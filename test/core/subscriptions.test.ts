import { describe, expect, test } from "vitest";
import { createAbsintheTransport } from "../../src";
import { server } from "../support/control";
import { collectEvents, eventually, nextEvent, sleep } from "../support/events";
import { stringMatching } from "../support/matchers";
import {
  racedTickedQuery,
  sharedQuery,
  tickedForQuery,
  tickedQuery,
} from "../support/queries";
import { record } from "../support/recorder";
import { openSocket } from "../support/sockets";

describe("subscriptions against Absinthe", () => {
  test("a subscription gets every push as the server sent it", async () => {
    const transport = createAbsintheTransport(openSocket());
    const statuses = collectEvents(transport, "status");
    const live = collectEvents(transport, "docLive");
    const recorder = record();
    expect(transport.status).toBe("idle");

    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    expect(await nextEvent(transport, "joined")).toEqual({ first: true });
    await server.publish("ticked", 1);
    await server.publish("ticked", 2);

    expect(await recorder.waitForResults(2)).toEqual([
      { data: { ticked: { topic: "ticked", value: 1 } } },
      { data: { ticked: { topic: "ticked", value: 2 } } },
    ]);
    expect(statuses).toEqual(["connecting", "joining", "live"]);
    expect(live).toEqual([
      {
        query: tickedQuery,
        variables: {},
        subscriptionId: stringMatching(/^__absinthe__:doc:/u),
      },
    ]);
    expect(transport.activeCount()).toBe(1);
  });

  test("variables reach the server as they are", async () => {
    const transport = createAbsintheTransport(openSocket());
    const recorder = record();
    transport.subscribe(
      { query: tickedForQuery, variables: { topic: "orders", scale: 10 } },
      recorder.sink,
    );
    await nextEvent(transport, "joined");
    await server.publish("orders", 3);

    expect(await recorder.waitForResults(1)).toEqual([
      { data: { tickedFor: { topic: "orders", value: 30 } } },
    ]);
    expect(await server.docs()).toEqual([
      { query: tickedForQuery, variables: { topic: "orders", scale: 10 } },
    ]);
  });

  test("identical subscriptions share one doc, whatever the key order of the variables", async () => {
    const transport = createAbsintheTransport(openSocket());
    const first = record();
    const second = record();
    transport.subscribe(
      { query: tickedForQuery, variables: { topic: "a", scale: 2 } },
      first.sink,
    );
    transport.subscribe(
      { query: tickedForQuery, variables: { scale: 2, topic: "a" } },
      second.sink,
    );
    await nextEvent(transport, "joined");
    await server.publish("a", 1);

    const expected = [{ data: { tickedFor: { topic: "a", value: 2 } } }];
    expect(await first.waitForResults(1)).toEqual(expected);
    expect(await second.waitForResults(1)).toEqual(expected);
    expect(await server.docs()).toHaveLength(1);
    expect(transport.activeCount()).toBe(1);
  });

  test("a late subscriber on a live subscription gets the next push, and nothing is sent again", async () => {
    const transport = createAbsintheTransport(openSocket());
    const early = record();
    const late = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, early.sink);
    await nextEvent(transport, "joined");
    transport.subscribe({ query: tickedQuery, variables: {} }, late.sink);
    await server.publish("ticked", 5);

    await early.waitForResults(1);
    expect(await late.waitForResults(1)).toEqual([
      { data: { ticked: { topic: "ticked", value: 5 } } },
    ]);
    expect(await server.docs()).toHaveLength(1);
  });

  test("Absinthe gives identical docs with a context_id the same id: the transport sends one and delivers each push once", async () => {
    const transport = createAbsintheTransport(openSocket());
    const first = record();
    const second = record();
    transport.subscribe(
      { query: sharedQuery, variables: { topic: "all" } },
      first.sink,
    );
    transport.subscribe(
      { query: sharedQuery, variables: { topic: "all" } },
      second.sink,
    );
    await nextEvent(transport, "joined");
    await server.publish("all", 1);
    await server.publish("all", 2);

    await first.waitForResults(2);
    await second.waitForResults(2);
    await sleep(100);
    expect(first.results()).toHaveLength(2);
    expect(second.results()).toHaveLength(2);
    expect(await server.docs()).toHaveLength(1);
  });

  test("the last observer to leave sends the unsubscribe, the others do not", async () => {
    const transport = createAbsintheTransport(openSocket());
    const live = nextEvent(transport, "docLive");
    const stopFirst = transport.subscribe(
      { query: tickedQuery, variables: {} },
      record().sink,
    );
    const stopSecond = transport.subscribe(
      { query: tickedQuery, variables: {} },
      record().sink,
    );
    const { subscriptionId } = await live;

    stopFirst();
    stopFirst();
    await sleep(100);
    expect(await server.unsubscribes()).toEqual([]);
    expect(transport.activeCount()).toBe(1);

    stopSecond();
    await eventually(async () =>
      expect(await server.unsubscribes()).toEqual([subscriptionId]),
    );
    expect((await server.state()).subscriptions).toBe(0);
    expect(transport.activeCount()).toBe(0);
  });

  test("when every observer leaves while the doc is in flight, the reply's id is unsubscribed", async () => {
    await server.settings({ docDelays: [300] });
    const transport = createAbsintheTransport(openSocket());
    const recorder = record();
    const stop = transport.subscribe(
      { query: tickedQuery, variables: {} },
      recorder.sink,
    );
    await eventually(async () => expect(await server.docs()).toHaveLength(1));
    stop();
    expect(transport.activeCount()).toBe(0);

    await eventually(async () =>
      expect(await server.unsubscribes()).toHaveLength(1),
    );
    expect((await server.state()).subscriptions).toBe(0);
    expect(recorder.events).toEqual([]);
  });

  test("a subscriber who comes back while the doc is in flight keeps it", async () => {
    await server.settings({ docDelays: [300] });
    const transport = createAbsintheTransport(openSocket());
    const stop = transport.subscribe(
      { query: tickedQuery, variables: {} },
      record().sink,
    );
    await eventually(async () => expect(await server.docs()).toHaveLength(1));
    stop();
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    await nextEvent(transport, "docLive");
    await server.publish("ticked", 9);

    expect(await recorder.waitForResults(1)).toHaveLength(1);
    expect(await server.docs()).toHaveLength(1);
    expect(await server.unsubscribes()).toEqual([]);
  });

  test("data that beats the doc reply is kept and delivered once the id is known", async () => {
    const transport = createAbsintheTransport(openSocket());
    const recorder = record();
    transport.subscribe(
      { query: racedTickedQuery, variables: { topic: "raced" } },
      recorder.sink,
    );
    await nextEvent(transport, "joined");
    await server.publish("raced", 1);

    expect(await recorder.waitForResults(2)).toEqual([
      { data: { racedTicked: { topic: "raced", value: -1 } } },
      { data: { racedTicked: { topic: "raced", value: 1 } } },
    ]);
  });

  test("a push for a subscription that is gone is dropped", async () => {
    const transport = createAbsintheTransport(openSocket());
    const recorder = record();
    const stop = transport.subscribe(
      { query: tickedQuery, variables: {} },
      recorder.sink,
    );
    await nextEvent(transport, "joined");
    await server.settings({ unsubscribeMode: "silent" });
    stop();
    await server.publish("ticked", 1);
    await sleep(200);
    expect(recorder.events).toEqual([]);
  });
});
