import { describe, expect, test } from "vitest";
import { createAbsintheTransport } from "../../src";
import { server } from "../support/control";
import { collectEvents, eventually, nextEvent, sleep } from "../support/events";
import { anyLocation, stringContaining } from "../support/matchers";
import { tickedQuery } from "../support/queries";
import { record } from "../support/recorder";
import { openSocket } from "../support/sockets";

describe("queries and mutations over the socket (operations: 'all')", () => {
  test("they are off by default", () => {
    const transport = createAbsintheTransport(openSocket());
    const errors = collectEvents(transport, "error");
    const recorder = record();
    transport.execute({ query: "{ hello }", variables: {} }, recorder.sink)();
    expect(recorder.errors()).toEqual([
      expect.objectContaining({ code: "OPERATION_NOT_ENABLED" }),
    ]);
    expect(errors).toEqual(recorder.errors());
  });

  test("a query sent before the join is sent once joined, and its result is passed as it is", async () => {
    const transport = createAbsintheTransport(openSocket(), {
      operations: "all",
    });
    const recorder = record();
    transport.execute(
      {
        query: "query Hello($name: String) { hello(name: $name) }",
        variables: { name: "Absinthe" },
      },
      recorder.sink,
    );
    await eventually(() => expect(recorder.completed()).toBe(true));
    expect(recorder.events).toEqual([
      { type: "next", result: { data: { hello: "Hello Absinthe" } } },
      { type: "complete" },
    ]);
  });

  test("resolver errors come with the data, validation errors on their own", async () => {
    const transport = createAbsintheTransport(openSocket(), {
      operations: "all",
    });
    const failing = record();
    const invalid = record();
    transport.execute({ query: "{ failing }", variables: {} }, failing.sink);
    transport.execute({ query: "{ missing }", variables: {} }, invalid.sink);
    await eventually(() => expect(invalid.completed()).toBe(true));
    await eventually(() => expect(failing.completed()).toBe(true));

    expect(failing.results()).toEqual([
      {
        data: { failing: null },
        errors: [
          {
            message: "Query failed",
            path: ["failing"],
            locations: [anyLocation],
            extensions: { code: "QUERY_FAILED" },
          },
        ],
      },
    ]);
    expect(invalid.results()).toEqual([
      {
        errors: [
          {
            message: stringContaining("missing"),
            locations: [anyLocation],
          },
        ],
      },
    ]);
  });

  test("a mutation runs and its publish reaches the subscriptions", async () => {
    const transport = createAbsintheTransport(openSocket(), {
      operations: "all",
    });
    const subscription = record();
    const mutation = record();
    transport.subscribe(
      { query: tickedQuery, variables: {} },
      subscription.sink,
    );
    await nextEvent(transport, "joined");
    transport.execute(
      {
        query:
          'mutation { publishTick(topic: "ticked", value: 4) { topic value } }',
        variables: {},
      },
      mutation.sink,
    );

    expect(await mutation.waitForResults(1)).toEqual([
      { data: { publishTick: { topic: "ticked", value: 4 } } },
    ]);
    expect(await subscription.waitForResults(1)).toEqual([
      { data: { ticked: { topic: "ticked", value: 4 } } },
    ]);
  });

  test("an operation in flight when the socket drops fails with DISCONNECTED and is not sent again", async () => {
    await server.settings({ docDelays: [500] });
    const transport = createAbsintheTransport(openSocket(), {
      operations: "all",
    });
    const recorder = record();
    transport.execute({ query: "{ hello }", variables: {} }, recorder.sink);
    await eventually(async () => expect(await server.docs()).toHaveLength(1));
    await server.disconnect();

    await eventually(() => expect(recorder.errors()).toHaveLength(1));
    expect(recorder.errors()[0]).toMatchObject({
      code: "DISCONNECTED",
      request: { query: "{ hello }" },
    });
    await sleep(300);
    expect(await server.docs()).toHaveLength(1);
  });

  test("an operation without an answer fails with DOC_TIMEOUT; one without a GraphQL reply with PROTOCOL", async () => {
    await server.settings({ docDelays: [600] });
    const transport = createAbsintheTransport(openSocket(), {
      operations: "all",
      docTimeoutMs: 200,
    });
    const slow = record();
    transport.execute({ query: "{ hello }", variables: {} }, slow.sink);
    await eventually(() => expect(slow.errors()).toHaveLength(1));
    expect(slow.errors()[0]).toMatchObject({ code: "DOC_TIMEOUT" });

    // The channel answers in order, so the next doc goes over its own socket.
    const other = createAbsintheTransport(openSocket(), { operations: "all" });
    const malformed = record();
    other.execute(
      {
        query: "{ hello }",
        variables: [] as unknown as Record<string, unknown>,
      },
      malformed.sink,
    );
    await eventually(() => expect(malformed.errors()).toHaveLength(1));
    expect(malformed.errors()[0]).toMatchObject({
      code: "PROTOCOL",
      payload: { error: "Could not parse variables as map" },
    });
  });

  test("an operation torn down before the reply gets nothing", async () => {
    const transport = createAbsintheTransport(openSocket(), {
      operations: "all",
    });
    const recorder = record();
    const stop = transport.execute(
      { query: "{ hello }", variables: {} },
      recorder.sink,
    );
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    stop();
    await nextEvent(transport, "joined");
    await sleep(100);
    expect(recorder.events).toEqual([]);
  });
});
