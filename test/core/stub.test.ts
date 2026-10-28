import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AbsintheSocketError,
  createAbsintheTransport,
  docRetryBackoffMs,
  isAbsintheSocketError,
  jitteredReconnectAfterMs,
} from "../../src";
import { phoenixRejoinAfterMs } from "../../src/core/backoff";
import { collectEvents } from "../support/events";
import { record } from "../support/recorder";
import { StubSocket } from "../support/stubSocket";

/**
 * Cases a real Absinthe server cannot produce on demand: replies to stale
 * pushes, malformed frames, more early data than the buffer holds, and the
 * transport's defaults for a socket that has no phoenix timeouts.
 */
const tick = { query: "subscription { ticked { value } }", variables: {} };
const other = { query: "subscription { other { value } }", variables: {} };
const hello = { query: "{ hello }", variables: {} };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stale and late answers", () => {
  test("hooks of a channel the transport gave up on do nothing", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket, { joinErrorLimit: 1 });
    const recorder = record();
    transport.subscribe(tick, recorder.sink);
    const abandoned = socket.current;
    socket.open();
    abandoned.joinPush.reply("error", { reason: "nope" });
    expect(abandoned.left).toBe(true);
    expect(recorder.errors()).toHaveLength(1);

    abandoned.joinPush.reply("ok", {});
    abandoned.joinPush.reply("error", {});
    abandoned.joinPush.reply("timeout");
    abandoned.error();
    abandoned.close();
    expect(transport.status).toBe("idle");

    transport.subscribe(tick, record().sink);
    expect(socket.channels).toHaveLength(2);
  });

  test("replies to a push from before a drop are ignored", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    const recorder = record();
    transport.subscribe(tick, recorder.sink);
    const channel = socket.join();
    const before = channel.lastDoc();
    socket.drop();
    socket.join();

    before.push.reply("ok", { subscriptionId: "old" });
    before.push.reply("error", { errors: [{ message: "old" }] });
    before.push.reply("timeout");
    expect(recorder.events).toEqual([]);
    expect(channel.docs()).toHaveLength(2);
  });

  test("an ok without a subscription id fails the subscription with PROTOCOL", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    const first = record();
    const second = record();
    transport.subscribe(tick, first.sink);
    transport.subscribe(other, second.sink);
    const channel = socket.join();
    channel.docs()[0]?.push.reply("ok", null);
    channel.docs()[1]?.push.reply("ok", { data: {} });

    expect(first.errors()[0]).toMatchObject({
      code: "PROTOCOL",
      payload: null,
    });
    expect(second.errors()[0]).toMatchObject({
      code: "PROTOCOL",
      payload: { data: {} },
    });
  });

  test("a closing doc ends quietly whatever the answer", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    const queries = ["a", "b", "c", "d"].map((name) => ({
      query: `subscription { ${name} }`,
      variables: {},
    }));
    const stops = queries.map((query) =>
      transport.subscribe(query, record().sink),
    );
    const channel = socket.join();
    for (const stop of stops) stop();
    expect(transport.activeCount()).toBe(0);
    const [noId, rejected, timedOut, accepted] = channel.docs();
    noId?.push.reply("ok", {});
    rejected?.push.reply("error", { errors: [] });
    timedOut?.push.reply("timeout");
    accepted?.push.reply("ok", { subscriptionId: "id-d" });

    const unsubscribes = channel.pushed.filter(
      (pushed) => pushed.event === "unsubscribe",
    );
    expect(unsubscribes.map((pushed) => pushed.payload)).toEqual([
      { subscriptionId: "id-d" },
    ]);
    expect(channel.docs()).toHaveLength(4);
  });

  test("a closing doc is forgotten on a drop and not sent again", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    const stop = transport.subscribe(tick, record().sink);
    const channel = socket.join();
    stop();
    socket.drop();
    socket.join();
    expect(channel.docs()).toHaveLength(1);
    expect(transport.activeCount()).toBe(0);
  });

  test("a doc waiting for its retry is dropped by a teardown, and its timer by a drop", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    const stop = transport.subscribe(tick, record().sink);
    transport.subscribe(other, record().sink);
    const channel = socket.join();
    channel.docs()[0]?.push.reply("timeout");
    channel.docs()[1]?.push.reply("timeout");
    stop();
    socket.drop();
    vi.advanceTimersByTime(10_000);
    expect(channel.docs()).toHaveLength(2);
    socket.join();
    expect(channel.docs().map((doc) => doc.payload.query)).toEqual([
      tick.query,
      other.query,
      other.query,
    ]);
  });

  test("the default doc retry waits 1 s, 2 s and 4 s with jitter, then fails", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    const recorder = record();
    transport.subscribe(tick, recorder.sink);
    const channel = socket.join();
    for (const wait of [1000, 2000, 4000]) {
      channel.lastDoc().push.reply("timeout");
      vi.advanceTimersByTime(wait - 1);
      const sent = channel.docs().length;
      vi.advanceTimersByTime(1);
      expect(channel.docs()).toHaveLength(sent + 1);
    }
    channel.lastDoc().push.reply("timeout");
    expect(recorder.errors()[0]).toMatchObject({ code: "DOC_TIMEOUT" });
    vi.restoreAllMocks();
  });
});

describe("suspects after a crash", () => {
  test("docs in flight at a crash are sent again one at a time, after the others", () => {
    const socket = new StubSocket();
    socket.open();
    const transport = createAbsintheTransport(socket);
    transport.subscribe(tick, record().sink);
    transport.subscribe(other, record().sink);
    const channel = socket.join();
    channel.error();
    const third = { query: "subscription { third }", variables: {} };
    transport.subscribe(third, record().sink);
    channel.joinPush.reply("ok", {});

    expect(
      channel
        .docs()
        .slice(2)
        .map((doc) => doc.payload.query),
    ).toEqual([third.query]);
    channel.lastDoc().push.reply("ok", { subscriptionId: "third" });
    expect(channel.lastDoc().payload.query).toBe(tick.query);
    channel.lastDoc().push.reply("ok", { subscriptionId: "tick" });
    expect(channel.lastDoc().payload.query).toBe(other.query);
  });

  test("a suspect whose observers leave while it waits is not sent", () => {
    const socket = new StubSocket();
    socket.open();
    const transport = createAbsintheTransport(socket);
    const joins = collectEvents(transport, "joined");
    transport.subscribe(tick, record().sink);
    const stop = transport.subscribe(other, record().sink);
    const channel = socket.join();
    channel.error();
    channel.joinPush.reply("ok", {});
    stop();
    channel.lastDoc().push.reply("ok", { subscriptionId: "tick" });
    expect(channel.docs()).toHaveLength(3);
    expect(joins).toEqual([{ first: false }]);
  });
});

describe("crash or drop", () => {
  test("a heartbeat timeout errors the channel before the socket closes: that is a drop, not a crash", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket, { crashLimit: 1 });
    const first = record();
    const second = record();
    transport.subscribe(tick, first.sink);
    transport.subscribe(other, second.sink);
    const channel = socket.join();
    expect(channel.docs()).toHaveLength(2);

    socket.heartbeatTimeout();
    socket.heartbeatTimeout();
    socket.join();
    expect(first.errors()).toEqual([]);
    expect(second.errors()).toEqual([]);
    // No suspects: both docs go out again at once, not one at a time.
    expect(channel.docs()).toHaveLength(4);
  });

  test("an error on a socket that stays open is counted as a crash at the next join", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket, { crashLimit: 1 });
    const crashing = record();
    const left = record();
    transport.subscribe(tick, crashing.sink);
    const stop = transport.subscribe(other, left.sink);
    const channel = socket.join();

    channel.error();
    expect(crashing.errors()).toEqual([]);
    stop();
    channel.joinPush.reply("ok", {});
    expect(crashing.errors()[0]).toMatchObject({ code: "CHANNEL_CRASHED" });
    expect(left.events).toEqual([]);
    expect(transport.activeCount()).toBe(0);
  });
});

describe("operations", () => {
  test("an operation queued before the join survives a failed connect and is sent once joined", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket, { operations: "all" });
    const recorder = record();
    transport.execute(hello, recorder.sink);
    socket.current.error();
    const channel = socket.join();
    channel.lastDoc().push.reply("ok", { data: { hello: "hi" } });
    expect(recorder.results()).toEqual([{ data: { hello: "hi" } }]);
  });

  test("answers after a teardown are ignored", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket, { operations: "all" });
    const recorder = record();
    transport.subscribe(tick, record().sink);
    socket.join();
    const stops = [0, 1, 2].map(() => transport.execute(hello, recorder.sink));
    for (const stop of stops) stop();
    const [, ok, error, timeout] = socket.current.docs();
    ok?.push.reply("ok", { data: {} });
    error?.push.reply("error", { errors: [] });
    timeout?.push.reply("timeout");
    expect(recorder.events).toEqual([]);
  });

  test("an ok that is not a result fails with PROTOCOL", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket, { operations: "all" });
    const notAResult = record();
    const notAnObject = record();
    transport.execute(hello, notAResult.sink);
    transport.execute(hello, notAnObject.sink);
    socket.join();
    socket.current.docs()[0]?.push.reply("ok", { subscriptionId: "x" });
    socket.current.docs()[1]?.push.reply("ok", "text");
    expect(notAResult.errors()[0]).toMatchObject({ code: "PROTOCOL" });
    expect(notAnObject.errors()[0]).toMatchObject({ code: "PROTOCOL" });
  });

  test("a join refused for good fails the queued operations too; dispose completes them", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket, {
      operations: "all",
      joinErrorLimit: 1,
    });
    const refused = record();
    transport.execute(hello, refused.sink);
    socket.open();
    socket.current.joinPush.reply("error", {});
    expect(refused.errors()[0]).toMatchObject({ code: "JOIN_REJECTED" });

    const disposed = record();
    transport.execute(hello, disposed.sink);
    transport.dispose();
    expect(disposed.events).toEqual([{ type: "complete" }]);
    expect(socket.offRefs).toEqual(["open-ref", "close-ref"]);
  });
});

describe("data frames", () => {
  test("malformed frames are reported and ignored; the topic is the id when the payload has none", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    const errors = collectEvents(transport, "error");
    const recorder = record();
    transport.subscribe(tick, recorder.sink);
    socket.join().lastDoc().push.reply("ok", { subscriptionId: "sub-1" });

    socket.message({ topic: "phoenix", event: "phx_reply", payload: {} });
    socket.message({
      topic: "sub-1",
      event: "subscription:data",
      payload: "x",
    });
    socket.message({
      topic: "sub-1",
      event: "subscription:data",
      payload: { result: [] },
    });
    socket.message({
      topic: "sub-1",
      event: "subscription:data",
      payload: { result: { data: { ticked: 1 } } },
    });

    expect(errors.map((error) => error.code)).toEqual(["PROTOCOL", "PROTOCOL"]);
    expect(recorder.results()).toEqual([{ data: { ticked: 1 } }]);
  });

  test("early data is kept for at most 100 frames and docTimeoutMs, and dropped with nothing in flight", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket, { docTimeoutMs: 1000 });
    const recorder = record();
    socket.data("unknown", { data: { dropped: true } });
    transport.subscribe(tick, recorder.sink);
    transport.subscribe(other, record().sink);
    const channel = socket.join();
    socket.data("expired", { data: { value: -1 } });
    vi.advanceTimersByTime(1001);
    for (let value = 0; value < 101; value++)
      socket.data("sub-1", { data: { value } });
    socket.data("expired", { data: { value: -2 } });
    channel.docs()[0]?.push.reply("ok", { subscriptionId: "sub-1" });

    const values = recorder
      .results()
      .map((result) => (result.data as { value: number }).value);
    expect(values).toHaveLength(99);
    expect(values[0]).toBe(2);
    expect(values.at(-1)).toBe(100);
  });
});

describe("channel close and defaults", () => {
  test("a closed channel is joined again after phoenix's rejoin schedule; dispose stops the wait", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    transport.subscribe(tick, record().sink);
    const channel = socket.join();
    channel.close();
    expect(transport.status).toBe("reconnecting");
    transport.subscribe(other, record().sink);
    vi.advanceTimersByTime(999);
    expect(socket.channels).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.channels).toHaveLength(2);

    socket.current.close();
    transport.dispose();
    vi.advanceTimersByTime(10_000);
    expect(socket.channels).toHaveLength(2);
  });

  test("socket events without a channel change nothing", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    const errors = collectEvents(transport, "error");
    socket.open();
    socket.connected = false;
    for (const callback of (
      socket as unknown as { closeCallbacks: Array<() => void> }
    ).closeCallbacks)
      callback();
    expect(transport.status).toBe("idle");
    expect(errors).toEqual([]);
  });

  test("teardowns returned without a subscription are safe to call", () => {
    const socket = new StubSocket();
    const transport = createAbsintheTransport(socket);
    expect(() => {
      transport.execute(hello, record().sink)();
      transport.dispose();
      transport.dispose();
      transport.subscribe(tick, record().sink)();
      transport.execute(hello, record().sink)();
    }).not.toThrow();
  });
});

describe("errors and backoff", () => {
  test("isAbsintheSocketError also accepts one from another copy of the package", () => {
    const error = new AbsintheSocketError("PROTOCOL", { payload: 1 });
    expect(error).toMatchObject({ name: "AbsintheSocketError", payload: 1 });
    expect(isAbsintheSocketError(error)).toBe(true);
    expect(
      isAbsintheSocketError({ name: "AbsintheSocketError", code: "PROTOCOL" }),
    ).toBe(true);
    expect(isAbsintheSocketError({ name: "AbsintheSocketError" })).toBe(false);
    expect(isAbsintheSocketError(new Error("x"))).toBe(false);
    expect(isAbsintheSocketError(null)).toBe(false);
    expect(isAbsintheSocketError("AbsintheSocketError")).toBe(false);
  });

  test("the reconnect backoff is full jitter between 500 ms and 30 s", () => {
    const random = vi.spyOn(Math, "random");
    random.mockReturnValue(1);
    expect(jitteredReconnectAfterMs(1)).toBe(2000);
    expect(jitteredReconnectAfterMs(10)).toBe(30_000);
    random.mockReturnValue(0);
    expect(jitteredReconnectAfterMs(3)).toBe(500);
    expect(docRetryBackoffMs(2)).toBe(1000);
    expect([1, 2, 3, 4, 9].map((tries) => phoenixRejoinAfterMs(tries))).toEqual(
      [1000, 2000, 5000, 10_000, 10_000],
    );
    random.mockRestore();
  });
});
