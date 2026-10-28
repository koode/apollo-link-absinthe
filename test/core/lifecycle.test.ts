import { describe, expect, test, vi } from "vitest";
import {
  createAbsintheTransport,
  disposeAbsintheTransport,
  getAbsintheTransport,
  onAbsintheTransport,
  type TransportStatus,
} from "../../src";
import { server } from "../support/control";
import { collectEvents, eventually, nextEvent, sleep } from "../support/events";
import { tickedForQuery, tickedQuery } from "../support/queries";
import { record } from "../support/recorder";
import { openSocket } from "../support/sockets";

describe("recovery", () => {
  test("after a socket drop every subscription is sent again; the observers see no error and no complete", async () => {
    const transport = createAbsintheTransport(openSocket());
    const statuses = collectEvents(transport, "status");
    const live = collectEvents(transport, "docLive");
    const errors = collectEvents(transport, "error");
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    await nextEvent(transport, "joined");

    const rejoined = nextEvent(transport, "joined");
    await server.disconnect();
    expect(await rejoined).toEqual({ first: false });
    await server.publish("ticked", 1);

    expect(await recorder.waitForResults(1)).toHaveLength(1);
    expect(recorder.events.map((event) => event.type)).toEqual(["next"]);
    expect(statuses).toEqual([
      "connecting",
      "joining",
      "live",
      "reconnecting",
      "joining",
      "live",
    ]);
    expect(live).toHaveLength(2);
    expect(live[0]?.subscriptionId).not.toBe(live[1]?.subscriptionId);
    expect(errors).toEqual([]);
    expect(await server.docs()).toHaveLength(2);
  });

  test("a channel crash without a doc in flight resubscribes everything", async () => {
    const transport = createAbsintheTransport(openSocket());
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    await nextEvent(transport, "joined");

    const rejoined = nextEvent(transport, "joined");
    await server.crashChannels();
    expect(await rejoined).toEqual({ first: false });
    await server.publish("ticked", 1);
    expect(await recorder.waitForResults(1)).toHaveLength(1);
    expect(recorder.errors()).toEqual([]);
  });

  test("a control channel the server closes (phx_close) is joined again on a new channel", async () => {
    const transport = createAbsintheTransport(openSocket());
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    await nextEvent(transport, "joined");

    const rejoined = nextEvent(transport, "joined");
    await server.closeChannels();
    await eventually(() => expect(transport.status).toBe("reconnecting"));
    expect(await rejoined).toEqual({ first: false });
    await server.publish("ticked", 1);
    expect(await recorder.waitForResults(1)).toHaveLength(1);
    expect(recorder.errors()).toEqual([]);
  });

  test("a closed channel with nothing on it stays closed until the next subscription", async () => {
    const transport = createAbsintheTransport(openSocket());
    const stop = transport.subscribe(
      { query: tickedQuery, variables: {} },
      record().sink,
    );
    await nextEvent(transport, "joined");
    stop();
    await server.closeChannels();
    await eventually(() => expect(transport.status).toBe("idle"));

    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    await nextEvent(transport, "joined");
    await server.publish("ticked", 1);
    expect(await recorder.waitForResults(1)).toHaveLength(1);
  });

  test("only the newest join fires joined", async () => {
    await server.settings({ docDelays: [500] });
    const transport = createAbsintheTransport(openSocket());
    const joins = collectEvents(transport, "joined");
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await eventually(async () => expect(await server.docs()).toHaveLength(1));

    await server.disconnect();
    await eventually(() => expect(joins).toHaveLength(1));
    await sleep(600);
    expect(joins).toEqual([{ first: false }]);
  });

  test("with nothing to subscribe, joined fires at once", async () => {
    const transport = createAbsintheTransport(openSocket());
    const joins = collectEvents(transport, "joined");
    const stop = transport.subscribe(
      { query: tickedQuery, variables: {} },
      record().sink,
    );
    stop();
    await eventually(() => expect(joins).toEqual([{ first: true }]));
    expect(await server.docs()).toEqual([]);
  });
});

describe("ownership", () => {
  test("dispose completes every observer, leaves the channel and keeps the socket open", async () => {
    await server.settings({ docDelays: [300] });
    const socket = openSocket();
    const transport = createAbsintheTransport(socket);
    const statuses = collectEvents(transport, "status");
    const live = record();
    const inFlight = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, live.sink);
    await nextEvent(transport, "joined");
    transport.subscribe(
      { query: tickedForQuery, variables: { topic: "slow" } },
      inFlight.sink,
    );
    await eventually(async () => expect(await server.docs()).toHaveLength(2));

    disposeAbsintheTransport(socket);
    transport.dispose();
    expect(live.events).toEqual([{ type: "complete" }]);
    expect(inFlight.events).toEqual([{ type: "complete" }]);
    expect(transport.status).toBe("disposed");
    expect(statuses.at(-1)).toBe("disposed");
    expect(socket.isConnected()).toBe(true);
    await eventually(async () =>
      expect((await server.state()).subscriptions).toBe(0),
    );

    const late = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, late.sink);
    transport.execute({ query: "{ hello }", variables: {} }, late.sink);
    expect(late.events).toEqual([{ type: "complete" }, { type: "complete" }]);
    expect(getAbsintheTransport(socket)).not.toBe(transport);
  });

  test("one transport per socket: a second one throws, getAbsintheTransport shares the first", () => {
    const socket = openSocket();
    const created: unknown[] = [];
    const stop = onAbsintheTransport((transport, owner) =>
      created.push([transport, owner]),
    );
    const transport = getAbsintheTransport(socket);
    stop();
    expect(getAbsintheTransport(socket)).toBe(transport);
    expect(() => createAbsintheTransport(socket)).toThrow(
      /already has an Absinthe transport/u,
    );
    expect(created).toEqual([[transport, socket]]);
    getAbsintheTransport(openSocket());
    expect(created).toHaveLength(1);
  });

  test("connect: 'manual' waits for the app to connect the socket", async () => {
    const socket = openSocket();
    const transport = createAbsintheTransport(socket, { connect: "manual" });
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    await sleep(200);
    expect(socket.isConnected()).toBe(false);
    expect(transport.status).toBe("connecting");

    socket.connect();
    await nextEvent(transport, "joined");
    await server.publish("ticked", 1);
    expect(await recorder.waitForResults(1)).toHaveLength(1);
  });

  test("a transport on a socket that is already open joins at once and reports no failed connect on a drop", async () => {
    const socket = openSocket();
    socket.connect();
    await eventually(() => expect(socket.isConnected()).toBe(true));
    const transport = createAbsintheTransport(socket);
    const statuses = collectEvents(transport, "status");
    const errors = collectEvents(transport, "error");
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");
    expect(statuses).toEqual(["joining", "live"]);

    const rejoined = nextEvent(transport, "joined");
    await server.disconnect();
    await rejoined;
    expect(errors).toEqual([]);
  });

  test("a throwing listener is reported and does not stop the others", async () => {
    const reported: unknown[] = [];
    const queueMicrotask = vi
      .spyOn(globalThis, "queueMicrotask")
      .mockImplementation((callback) => {
        try {
          callback();
        } catch (error) {
          reported.push(error);
        }
      });
    try {
      const transport = createAbsintheTransport(openSocket());
      const failure = new Error("listener failed");
      transport.on("status", () => {
        throw failure;
      });
      const statuses = collectEvents(transport, "status");
      const stopped = vi.fn<(status: TransportStatus) => void>();
      transport.on("status", stopped)();
      transport.subscribe(
        { query: tickedQuery, variables: {} },
        {
          next: () => {},
          error: () => {},
          complete: () => {
            throw failure;
          },
        },
      );
      await nextEvent(transport, "joined");
      transport.dispose();
      expect(statuses).toEqual(["connecting", "joining", "live", "disposed"]);
      expect(stopped).not.toHaveBeenCalled();
      expect(reported).toEqual([failure, failure, failure, failure, failure]);
    } finally {
      queueMicrotask.mockRestore();
    }
  });
});
