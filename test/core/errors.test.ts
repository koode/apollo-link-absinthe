import { describe, expect, test } from "vitest";
import {
  type AbsintheSocketError,
  createAbsintheTransport,
  isAbsintheSocketError,
} from "../../src";
import { server } from "../support/control";
import { collectEvents, eventually, nextEvent, sleep } from "../support/events";
import {
  crashesQuery,
  failsAtPublishQuery,
  privateTickedQuery,
  refusedQuery,
  refusedWithCodeQuery,
  tickedQuery,
} from "../support/queries";
import { record } from "../support/recorder";
import { openSocket } from "../support/sockets";

const location = { line: expect.any(Number), column: expect.any(Number) };

describe("GraphQL errors stay GraphQL errors", () => {
  test("a refusal without a code reaches the observer as result.errors, then the subscription ends", async () => {
    const transport = createAbsintheTransport(openSocket());
    const recorder = record();
    transport.subscribe({ query: refusedQuery, variables: {} }, recorder.sink);
    await nextEvent(transport, "joined");

    expect(recorder.events).toEqual([
      {
        type: "next",
        result: { errors: [{ message: "FORBIDDEN", locations: [location] }] },
      },
      { type: "complete" },
    ]);
    expect(transport.activeCount()).toBe(0);
  });

  test("a refusal with extensions.code keeps the code, the locations and Absinthe's top-level extras", async () => {
    const transport = createAbsintheTransport(openSocket());
    const recorder = record();
    transport.subscribe(
      { query: refusedWithCodeQuery, variables: {} },
      recorder.sink,
    );
    await nextEvent(transport, "joined");

    expect(recorder.events).toEqual([
      {
        type: "next",
        result: {
          errors: [
            {
              message: "Not allowed here",
              extensions: { code: "FORBIDDEN" },
              reason: "test",
              locations: [location],
            },
          ],
        },
      },
      { type: "complete" },
    ]);
    await sleep(100);
    expect(await server.docs()).toHaveLength(1);
  });

  test("an error inside a pushed result arrives with its path and code, and the subscription stays open", async () => {
    const transport = createAbsintheTransport(openSocket());
    const recorder = record();
    transport.subscribe(
      { query: failsAtPublishQuery, variables: { topic: "jobs" } },
      recorder.sink,
    );
    await nextEvent(transport, "joined");
    await server.publish("jobs", 1, true);
    await server.publish("jobs", 2);

    expect(await recorder.waitForResults(2)).toEqual([
      {
        data: { failsAtPublish: null },
        errors: [
          {
            message: "Publish failed",
            path: ["failsAtPublish"],
            locations: [location],
            extensions: { code: "PUBLISH_FAILED" },
            detail: "kept",
          },
        ],
      },
      { data: { failsAtPublish: { topic: "jobs", value: 2 } } },
    ]);
    expect(recorder.completed()).toBe(false);
  });

  test("the server authorizes with the token the socket connected with", async () => {
    const anonymous = createAbsintheTransport(openSocket());
    const refused = record();
    anonymous.subscribe(
      { query: privateTickedQuery, variables: {} },
      refused.sink,
    );
    await nextEvent(anonymous, "joined");
    expect(refused.results()).toEqual([
      {
        errors: [
          {
            message: "Sign in first",
            extensions: { code: "UNAUTHENTICATED" },
            locations: [location],
          },
        ],
      },
    ]);

    const signedIn = createAbsintheTransport(
      openSocket({ token: "user:alice" }),
    );
    const allowed = record();
    signedIn.subscribe(
      { query: privateTickedQuery, variables: {} },
      allowed.sink,
    );
    await nextEvent(signedIn, "joined");
    await server.publish("private:alice", 7);
    expect(await allowed.waitForResults(1)).toEqual([
      { data: { privateTicked: { topic: "private:alice", value: 7 } } },
    ]);
  });
});

describe("transport errors", () => {
  test("a reply that is not GraphQL-shaped fails the subscription with PROTOCOL and the payload", async () => {
    const transport = createAbsintheTransport(openSocket());
    const errors = collectEvents(transport, "error");
    const recorder = record();
    const request = {
      query: tickedQuery,
      variables: ["not", "a", "map"] as unknown as Record<string, unknown>,
    };
    transport.subscribe(request, recorder.sink);
    await nextEvent(transport, "joined");

    const [error] = recorder.errors();
    expect(isAbsintheSocketError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "PROTOCOL",
      payload: { error: "Could not parse variables as map" },
      request,
    });
    expect(errors).toEqual([error]);
  });

  test("a doc that crashes the channel fails alone after crashLimit crashes; the others come back", async () => {
    const transport = createAbsintheTransport(openSocket());
    const crashing = record();
    const innocent = record();
    const innocentLive = nextEvent(
      transport,
      "docLive",
      (info) => info.query === tickedQuery,
    );
    // Pushed in this order, so the innocent doc is in flight at both crashes.
    transport.subscribe({ query: crashesQuery, variables: {} }, crashing.sink);
    transport.subscribe({ query: tickedQuery, variables: {} }, innocent.sink);

    await eventually(() => expect(crashing.errors()).toHaveLength(1));
    expect(crashing.errors()[0]).toMatchObject({ code: "CHANNEL_CRASHED" });
    await innocentLive;
    await server.publish("ticked", 1);
    expect(await innocent.waitForResults(1)).toHaveLength(1);
    expect(innocent.errors()).toEqual([]);
    const crashDocs = (await server.docs()).filter(
      (doc) => doc.query === crashesQuery,
    );
    expect(crashDocs).toHaveLength(2);
  });

  test("a doc timeout is retried while the channel stays joined", async () => {
    await server.settings({ docDelays: [500] });
    const transport = createAbsintheTransport(openSocket(), {
      docTimeoutMs: 400,
      docRetry: { attempts: 2, backoffMs: () => 20 },
    });
    const joined = nextEvent(transport, "joined");
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);

    await joined;
    await nextEvent(transport, "docLive");
    await server.publish("ticked", 1);
    expect(await recorder.waitForResults(1)).toHaveLength(1);
    expect(recorder.errors()).toEqual([]);
    expect(await server.docs()).toHaveLength(2);
  });

  test("a doc with no answer after every retry fails with DOC_TIMEOUT", async () => {
    await server.settings({ docDelays: [600, 600] });
    const transport = createAbsintheTransport(openSocket(), {
      docTimeoutMs: 250,
      docRetry: { attempts: 1, backoffMs: () => 10 },
    });
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);

    await eventually(() => expect(recorder.errors()).toHaveLength(1), 3000);
    expect(recorder.errors()[0]).toMatchObject({
      code: "DOC_TIMEOUT",
      request: { query: tickedQuery },
    });
    expect(transport.activeCount()).toBe(0);
  });

  test("an unsubscribe the server refuses or ignores is reported as an event only", async () => {
    const transport = createAbsintheTransport(openSocket(), {
      docTimeoutMs: 300,
    });
    const errors = collectEvents(transport, "error");
    const refused = transport.subscribe(
      { query: tickedQuery, variables: {} },
      record().sink,
    );
    const silent = transport.subscribe(
      { query: "subscription { ticked { value } }", variables: {} },
      record().sink,
    );
    await nextEvent(transport, "joined");

    await server.settings({ unsubscribeMode: "error" });
    refused();
    await eventually(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({
      code: "UNSUBSCRIBE_FAILED",
      payload: { reason: "refused by the test server" },
    });

    await server.settings({ unsubscribeMode: "silent" });
    silent();
    await eventually(() => expect(errors).toHaveLength(2));
    expect(errors[1]).toMatchObject({
      code: "UNSUBSCRIBE_FAILED",
      payload: { subscriptionId: expect.any(String) },
    });
  });

  test("a refused join is an event until joinErrorLimit; the subscription waits for phoenix to rejoin", async () => {
    await server.settings({ joinMode: "reject" });
    const transport = createAbsintheTransport(openSocket(), {
      joinErrorLimit: 100,
    });
    const errors = collectEvents(transport, "error");
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);

    await eventually(() => expect(errors.length).toBeGreaterThanOrEqual(2));
    expect(errors[0]).toMatchObject({
      code: "JOIN_REJECTED",
      payload: { reason: "refused by the test server" },
    });
    await server.settings({ joinMode: "normal" });
    await nextEvent(transport, "joined");
    await server.publish("ticked", 1);
    expect(await recorder.waitForResults(1)).toHaveLength(1);
    expect(recorder.errors()).toEqual([]);
  });

  test("joinErrorLimit refusals in a row fail every observer; the next subscription joins again", async () => {
    await server.settings({ joinMode: "reject" });
    const transport = createAbsintheTransport(openSocket(), {
      joinErrorLimit: 2,
    });
    const errors = collectEvents(transport, "error");
    const first = record();
    const second = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, first.sink);
    transport.subscribe({ query: refusedQuery, variables: {} }, second.sink);

    await eventually(() => expect(first.errors()).toHaveLength(1));
    const failure: AbsintheSocketError | undefined = first.errors()[0];
    expect(failure).toMatchObject({
      code: "JOIN_REJECTED",
      payload: { reason: "refused by the test server" },
    });
    expect(second.errors()).toEqual([failure]);
    expect(
      errors.filter((error) => error.code === "JOIN_REJECTED"),
    ).toHaveLength(2);
    expect(transport.status).toBe("idle");
    expect(transport.activeCount()).toBe(0);

    await server.settings({ joinMode: "normal" });
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    await nextEvent(transport, "joined");
    await server.publish("ticked", 1);
    expect(await recorder.waitForResults(1)).toHaveLength(1);
  });

  test("a join timeout is an event; phoenix joins again and the subscription goes live", async () => {
    await server.settings({ joinMode: "slow", joinDelayMs: 800 });
    const transport = createAbsintheTransport(openSocket({ timeout: 300 }));
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);

    const timeout = await nextEvent(transport, "error");
    expect(timeout).toMatchObject({ code: "JOIN_TIMEOUT" });
    expect(transport.status).toBe("joining");
    await server.settings({ joinMode: "normal" });
    await nextEvent(transport, "joined");
    await server.publish("ticked", 1);
    expect(await recorder.waitForResults(1)).toHaveLength(1);
    expect(recorder.errors()).toEqual([]);
  });

  test("a refused connect is a CONNECT_FAILED event per attempt and never reaches the observer", async () => {
    const transport = createAbsintheTransport(openSocket({ token: "expired" }));
    const errors = collectEvents(transport, "error");
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);

    await eventually(() => expect(errors.length).toBeGreaterThanOrEqual(2));
    expect(errors.every((error) => error.code === "CONNECT_FAILED")).toBe(true);
    expect(transport.status).toBe("connecting");
    expect(recorder.events).toEqual([]);
  });
});
