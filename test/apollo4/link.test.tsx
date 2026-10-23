import {
  ApolloClient,
  ApolloLink,
  CombinedGraphQLErrors,
  gql,
  InMemoryCache,
  LinkError,
  Observable,
} from "@apollo/client";
import { ErrorLink } from "@apollo/client/link/error";
import { ApolloProvider, useSubscription } from "@apollo/client/react";
import { renderHook } from "@testing-library/react";
import type { DocumentNode } from "graphql";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createAbsintheLink,
  createAbsintheTransport,
  type IAbsintheTransport,
  type ITransportOptions,
  isAbsintheSocketError,
  isSubscription,
  resyncOnJoin,
  splitSubscriptions,
} from "../../src";
import { server } from "../support/control";
import { eventually, nextEvent, sleep } from "../support/events";
import { openSocket } from "../support/sockets";

const ticked = gql`
  subscription Ticked {
    ticked {
      topic
      value
    }
  }
`;
const refused = gql`
  subscription Refused {
    refused {
      value
    }
  }
`;
const refusedWithCode = gql`
  subscription RefusedWithCode {
    refusedWithCode {
      value
    }
  }
`;
const failsAtPublish = gql`
  subscription FailsAtPublish($topic: String!) {
    failsAtPublish(topic: $topic) {
      topic
      value
    }
  }
`;
const privateTicked = gql`
  subscription PrivateTicked {
    privateTicked {
      value
    }
  }
`;
const crashes = gql`
  subscription Crashes {
    crashes {
      value
    }
  }
`;
const hello = gql`
  query Hello {
    hello
  }
`;

interface IHarness {
  client: ApolloClient;
  transport: IAbsintheTransport;
  linkErrors: ErrorLink.ErrorHandlerOptions[];
}

const clients: ApolloClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
});

const httpStub = new ApolloLink(
  () =>
    new Observable((observer) => {
      observer.next({ data: { hello: "over http" } });
      observer.complete();
    }),
);

function harness(
  options: ITransportOptions = {},
  wrap: (transport: IAbsintheTransport) => IAbsintheTransport = (transport) =>
    transport,
): IHarness {
  const transport = createAbsintheTransport(openSocket(), options);
  const linkErrors: ErrorLink.ErrorHandlerOptions[] = [];
  const errorLink = new ErrorLink((handlerOptions) => {
    linkErrors.push(handlerOptions);
  });
  const absintheLink = createAbsintheLink(wrap(transport));
  const link = ApolloLink.from([
    errorLink,
    options.operations === "all"
      ? absintheLink
      : splitSubscriptions(absintheLink, httpStub),
  ]);
  const client = new ApolloClient({ link, cache: new InMemoryCache() });
  clients.push(client);
  return { client, transport, linkErrors };
}

// biome-ignore lint/suspicious/noExplicitAny: the test documents are untyped.
type AnyData = any;

function renderSubscription(
  client: ApolloClient,
  query: DocumentNode,
  variables: Record<string, unknown> = {},
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApolloProvider client={client}>{children}</ApolloProvider>
  );
  return renderHook(() => useSubscription<AnyData>(query, { variables }), {
    wrapper,
  });
}

const location = { line: expect.any(Number), column: expect.any(Number) };

describe("Apollo 4: GraphQL errors reach the hook and the error link with their code", () => {
  test("data flows into useSubscription", async () => {
    const { client, transport } = harness();
    const { result } = renderSubscription(client, ticked);
    await nextEvent(transport, "joined");
    await server.publish("ticked", 1);
    await eventually(() =>
      expect(result.current.data).toEqual({
        ticked: { __typename: "Tick", topic: "ticked", value: 1 },
      }),
    );
  });

  test("a refusal with extensions.code: CombinedGraphQLErrors with the code, path data and extras intact", async () => {
    const { client, linkErrors } = harness();
    const { result } = renderSubscription(client, refusedWithCode);
    await eventually(() => expect(result.current.error).toBeDefined());

    const error = result.current.error;
    expect(CombinedGraphQLErrors.is(error)).toBe(true);
    const graphQLErrors = (error as CombinedGraphQLErrors).errors;
    expect(graphQLErrors).toEqual([
      {
        message: "Not allowed here",
        extensions: { code: "FORBIDDEN" },
        reason: "test",
        locations: [location],
      },
    ]);
    expect(linkErrors).toHaveLength(1);
    expect(CombinedGraphQLErrors.is(linkErrors[0]?.error)).toBe(true);
    expect(linkErrors[0]?.result?.errors).toEqual(graphQLErrors);
  });

  test("a refusal without a code keeps the message, as a plain config error sends it", async () => {
    const { client } = harness();
    const { result } = renderSubscription(client, refused);
    await eventually(() => expect(result.current.error).toBeDefined());
    expect((result.current.error as CombinedGraphQLErrors).errors).toEqual([
      { message: "FORBIDDEN", locations: [location] },
    ]);
  });

  test("an authorization refusal on the connect token carries UNAUTHENTICATED", async () => {
    const { client } = harness();
    const { result } = renderSubscription(client, privateTicked);
    await eventually(() => expect(result.current.error).toBeDefined());
    expect(
      (result.current.error as CombinedGraphQLErrors).errors[0]?.extensions,
    ).toEqual({ code: "UNAUTHENTICATED" });
  });

  test("an error inside a pushed result: the code and path reach the hook and the link, and the subscription stays open", async () => {
    const { client, transport, linkErrors } = harness();
    const { result } = renderSubscription(client, failsAtPublish, {
      topic: "jobs",
    });
    await nextEvent(transport, "joined");
    await server.publish("jobs", 1, true);
    await eventually(() => expect(result.current.error).toBeDefined());

    expect((result.current.error as CombinedGraphQLErrors).errors).toEqual([
      {
        message: "Publish failed",
        path: ["failsAtPublish"],
        locations: [location],
        extensions: { code: "PUBLISH_FAILED" },
        detail: "kept",
      },
    ]);
    expect(linkErrors).toHaveLength(1);

    await server.publish("jobs", 2);
    await eventually(() =>
      expect(result.current.data?.failsAtPublish).toEqual({
        __typename: "Tick",
        topic: "jobs",
        value: 2,
      }),
    );
    expect(result.current.error).toBeUndefined();
    expect(await server.unsubscribes()).toEqual([]);
  });
});

describe("Apollo 4: transport errors are a typed AbsintheSocketError", () => {
  test("PROTOCOL: a reply that is not GraphQL-shaped", async () => {
    const { client, linkErrors } = harness({}, (transport) => ({
      ...transport,
      subscribe: (request, sink) =>
        transport.subscribe(
          { ...request, variables: [] as unknown as Record<string, unknown> },
          sink,
        ),
      execute: transport.execute,
      on: transport.on,
      activeCount: transport.activeCount,
      dispose: transport.dispose,
    }));
    const { result } = renderSubscription(client, ticked);
    await eventually(() => expect(result.current.error).toBeDefined());

    const error = result.current.error;
    expect(isAbsintheSocketError(error)).toBe(true);
    expect(LinkError.is(error)).toBe(true);
    expect(error).toMatchObject({
      code: "PROTOCOL",
      payload: { error: "Could not parse variables as map" },
    });
    expect(linkErrors[0]?.error).toBe(error);
  });

  test("JOIN_REJECTED once the join is refused joinErrorLimit times", async () => {
    await server.settings({ joinMode: "reject" });
    const { client, linkErrors } = harness({ joinErrorLimit: 1 });
    const { result } = renderSubscription(client, ticked);
    await eventually(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toMatchObject({ code: "JOIN_REJECTED" });
    expect(isAbsintheSocketError(linkErrors[0]?.error)).toBe(true);
  });

  test("DOC_TIMEOUT once no retries are left", async () => {
    await server.settings({ docDelays: [600] });
    const { client } = harness({
      docTimeoutMs: 200,
      docRetry: { attempts: 0, backoffMs: () => 0 },
    });
    const { result } = renderSubscription(client, ticked);
    await eventually(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toMatchObject({ code: "DOC_TIMEOUT" });
  });

  test("CHANNEL_CRASHED for the doc that keeps crashing the channel", async () => {
    const { client, linkErrors } = harness();
    const { result } = renderSubscription(client, crashes);
    await eventually(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toMatchObject({ code: "CHANNEL_CRASHED" });
    expect(linkErrors[0]?.error).toBe(result.current.error);
  });

  test("DISCONNECTED for a query in flight when the socket drops", async () => {
    await server.settings({ docDelays: [500] });
    const { client, linkErrors } = harness({ operations: "all" });
    const query = client.query({ query: hello });
    await eventually(async () => expect(await server.docs()).toHaveLength(1));
    await server.disconnect();
    await expect(query).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(linkErrors[0]?.error).toMatchObject({ code: "DISCONNECTED" });
  });
});

describe("Apollo 4: what is not an error", () => {
  test("a socket drop reaches neither the hook nor the error link, and data flows again", async () => {
    const { client, transport, linkErrors } = harness();
    const { result } = renderSubscription(client, ticked);
    await nextEvent(transport, "joined");
    const rejoined = nextEvent(transport, "joined");
    await server.disconnect();
    await rejoined;
    await server.publish("ticked", 2);
    await eventually(() => expect(result.current.data?.ticked.value).toBe(2));
    expect(result.current.error).toBeUndefined();
    expect(linkErrors).toEqual([]);
  });

  test("a doc timeout with retries left reaches neither", async () => {
    await server.settings({ docDelays: [500] });
    const { client, linkErrors } = harness({
      docTimeoutMs: 400,
      docRetry: { attempts: 1, backoffMs: () => 10 },
    });
    const { result } = renderSubscription(client, ticked);
    await eventually(async () => expect(await server.docs()).toHaveLength(2));
    await sleep(200);
    await server.publish("ticked", 3);
    await eventually(() => expect(result.current.data?.ticked.value).toBe(3));
    expect(linkErrors).toEqual([]);
  });

  test("queries over the socket work with operations: 'all'", async () => {
    const { client } = harness({ operations: "all" });
    const { data } = await client.query({ query: hello });
    expect(data).toEqual({ hello: "Hello world" });
  });
});

describe("Apollo 4: wiring", () => {
  test("a socket as the source gets its transport on first use, with the link's options", async () => {
    const socket = openSocket();
    const client = new ApolloClient({
      link: createAbsintheLink(socket, { transport: { operations: "all" } }),
      cache: new InMemoryCache(),
    });
    clients.push(client);
    const { data } = await client.query({ query: hello });
    expect(data).toEqual({ hello: "Hello world" });
  });

  test("a source function that returns nothing completes the operation", async () => {
    const source = vi.fn((_operation: ApolloLink.Operation) => null);
    const client = new ApolloClient({
      link: createAbsintheLink(source),
      cache: new InMemoryCache(),
    });
    clients.push(client);
    const { result } = renderSubscription(client, ticked);
    await eventually(() => expect(source).toHaveBeenCalled());
    expect(result.current.error).toBeUndefined();
    expect(source.mock.calls[0]?.[0]).toMatchObject({
      operationName: "Ticked",
    });
  });

  test("isSubscription tells subscriptions from the rest", () => {
    const operations: ApolloLink.Operation[] = [];
    const recorderLink = new ApolloLink((operation) => {
      operations.push(operation);
      return new Observable<ApolloLink.Result>((observer) => {
        observer.next({ data: {} });
        observer.complete();
      });
    });
    const client = new ApolloClient({
      link: recorderLink,
      cache: new InMemoryCache(),
    });
    clients.push(client);
    client.subscribe({ query: ticked }).subscribe({});
    void client.query({ query: hello });
    expect(operations.map(isSubscription)).toEqual([true, false]);
  });

  test("on the server everything goes over HTTP and the source is never called", async () => {
    vi.stubGlobal("window", undefined);
    try {
      const source = vi.fn();
      const absintheLink = createAbsintheLink(source);
      const link = splitSubscriptions(absintheLink, httpStub);
      const results: unknown[] = [];
      const client = new ApolloClient({ link, cache: new InMemoryCache() });
      clients.push(client);
      client.subscribe({ query: ticked }).subscribe({
        next: (value) => results.push(value),
      });
      const direct = new ApolloClient({
        link: absintheLink,
        cache: new InMemoryCache(),
      });
      clients.push(direct);
      let completed = false;
      direct
        .subscribe({ query: ticked })
        .subscribe({ complete: () => (completed = true) });
      await eventually(() => expect(completed).toBe(true));
      expect(results).toHaveLength(1);
      expect(source).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("resyncOnJoin refetches the active queries on every join, or only after a reconnect", async () => {
    const { client, transport } = harness();
    const refetch = vi.spyOn(client, "refetchQueries");
    const stopAll = resyncOnJoin(client, transport);
    const stopNamed = resyncOnJoin(client, transport, {
      include: ["Orders"],
      skipFirst: true,
    });
    renderSubscription(client, ticked);
    await nextEvent(transport, "joined");
    expect(refetch.mock.calls.map(([options]) => options)).toEqual([
      { include: "active" },
    ]);

    const rejoined = nextEvent(transport, "joined");
    await server.disconnect();
    await rejoined;
    expect(refetch.mock.calls.map(([options]) => options)).toEqual([
      { include: "active" },
      { include: "active" },
      { include: ["Orders"] },
    ]);
    stopAll();
    stopNamed();
  });

  test("resyncOnJoin swallows a failed refetch: the query's own observers get that error", async () => {
    const { client, transport } = harness();
    const refetch = vi
      .spyOn(client, "refetchQueries")
      // Built on the call: a rejection made up front would be unhandled until the join.
      .mockImplementation(() => Promise.reject(new Error("offline")) as never);
    resyncOnJoin(client, transport);
    renderSubscription(client, ticked);
    await nextEvent(transport, "joined");
    await sleep(10);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
