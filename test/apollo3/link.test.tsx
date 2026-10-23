import {
  ApolloClient,
  ApolloError,
  ApolloLink,
  ApolloProvider,
  gql,
  InMemoryCache,
  Observable,
  type Operation,
  useSubscription,
} from "@apollo/client-3";
import { type ErrorResponse, onError } from "@apollo/client-3/link/error";
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
} from "../../src/apollo3";
import { server } from "../support/control";
import { eventually, nextEvent } from "../support/events";
import { openSocket } from "../support/sockets";
import { formatGraphQLError, hasErrorCode } from "./errorHelpers";

const ticked = gql`
  subscription Ticked {
    ticked {
      topic
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
  client: ApolloClient<unknown>;
  transport: IAbsintheTransport;
  linkErrors: ErrorResponse[];
}

const clients: ApolloClient<unknown>[] = [];

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

function harness(options: ITransportOptions = {}): IHarness {
  const transport = createAbsintheTransport(openSocket(), options);
  const linkErrors: ErrorResponse[] = [];
  const errorLink = onError((response) => {
    linkErrors.push(response);
  });
  const absintheLink = createAbsintheLink(transport);
  const link = ApolloLink.from([
    errorLink,
    options.operations === "all"
      ? absintheLink
      : splitSubscriptions(absintheLink, httpStub),
  ]);
  const client = new ApolloClient({ link, cache: new InMemoryCache() });
  clients.push(client as ApolloClient<unknown>);
  return { client: client as ApolloClient<unknown>, transport, linkErrors };
}

function renderSubscription(
  client: ApolloClient<unknown>,
  query: DocumentNode,
  variables: Record<string, unknown> = {},
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApolloProvider client={client}>{children}</ApolloProvider>
  );
  return renderHook(() => useSubscription(query, { variables }), { wrapper });
}

const location = { line: expect.any(Number), column: expect.any(Number) };

describe("Apollo 3: GraphQL errors become ApolloError with graphQLErrors intact", () => {
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

  test("a refusal with extensions.code: the app's hasErrorCode matches it", async () => {
    const { client, linkErrors } = harness();
    const { result } = renderSubscription(client, refusedWithCode);
    await eventually(() => expect(result.current.error).toBeDefined());

    const error = result.current.error as ApolloError;
    expect(error).toBeInstanceOf(ApolloError);
    expect(error.graphQLErrors).toEqual([
      {
        message: "Not allowed here",
        extensions: { code: "FORBIDDEN" },
        reason: "test",
        locations: [location],
      },
    ]);
    expect(hasErrorCode(error, "FORBIDDEN")).toBe(true);
    expect(formatGraphQLError(error)).toEqual({
      title: "API error",
      description: "Not allowed here",
    });
    expect(linkErrors).toHaveLength(1);
    expect(linkErrors[0]?.graphQLErrors).toEqual(error.graphQLErrors);
    expect(hasErrorCode(linkErrors[0] as ErrorResponse, "FORBIDDEN")).toBe(
      true,
    );
  });

  test("an error inside a pushed result: Apollo 3 ends the subscription itself, and the link then unsubscribes", async () => {
    const { client, transport, linkErrors } = harness();
    const { result } = renderSubscription(client, failsAtPublish, {
      topic: "jobs",
    });
    const { subscriptionId } = await nextEvent(transport, "docLive");
    await server.publish("jobs", 1, true);
    await eventually(() => expect(result.current.error).toBeDefined());

    const error = result.current.error as ApolloError;
    expect(error.graphQLErrors).toEqual([
      {
        message: "Publish failed",
        path: ["failsAtPublish"],
        locations: [location],
        extensions: { code: "PUBLISH_FAILED" },
        detail: "kept",
      },
    ]);
    expect(hasErrorCode(error, "PUBLISH_FAILED")).toBe(true);
    expect(linkErrors[0]?.graphQLErrors?.[0]?.extensions).toEqual({
      code: "PUBLISH_FAILED",
    });
    await eventually(async () =>
      expect(await server.unsubscribes()).toEqual([subscriptionId]),
    );
  });
});

describe("Apollo 3: transport errors arrive raw", () => {
  test("CHANNEL_CRASHED is the AbsintheSocketError itself in the hook and the link's networkError", async () => {
    const { client, linkErrors } = harness();
    const { result } = renderSubscription(client, crashes);
    await eventually(() => expect(result.current.error).toBeDefined());

    const error = result.current.error;
    expect(isAbsintheSocketError(error)).toBe(true);
    expect(error).toMatchObject({ code: "CHANNEL_CRASHED" });
    expect(linkErrors[0]?.networkError).toBe(error);
    expect(formatGraphQLError(linkErrors[0] as ErrorResponse).title).toBe(
      "An error occured while communicating with the server",
    );
  });

  test("JOIN_REJECTED once the join is refused joinErrorLimit times", async () => {
    await server.settings({ joinMode: "reject" });
    const { client, linkErrors } = harness({ joinErrorLimit: 1 });
    const { result } = renderSubscription(client, ticked);
    await eventually(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toMatchObject({ code: "JOIN_REJECTED" });
    expect(isAbsintheSocketError(linkErrors[0]?.networkError)).toBe(true);
  });

  test("DISCONNECTED for a query in flight when the socket drops", async () => {
    await server.settings({ docDelays: [500] });
    const { client } = harness({ operations: "all" });
    const query = client.query({ query: hello });
    await eventually(async () => expect(await server.docs()).toHaveLength(1));
    await server.disconnect();
    const error = (await query.catch(
      (caught: unknown) => caught,
    )) as ApolloError;
    expect(isAbsintheSocketError(error.networkError)).toBe(true);
    expect(error.networkError).toMatchObject({ code: "DISCONNECTED" });
  });
});

describe("Apollo 3: what is not an error, and wiring", () => {
  test("a socket drop reaches neither the hook nor the error link, and data flows again", async () => {
    const { client, transport, linkErrors } = harness();
    const { result } = renderSubscription(client, ticked);
    await nextEvent(transport, "joined");
    const rejoined = nextEvent(transport, "joined");
    await server.disconnect();
    await rejoined;
    await server.publish("ticked", 2);
    await eventually(() =>
      expect(
        (result.current.data as { ticked: { value: number } } | undefined)
          ?.ticked.value,
      ).toBe(2),
    );
    expect(result.current.error).toBeUndefined();
    expect(linkErrors).toEqual([]);
  });

  test("queries over the socket work with operations: 'all'", async () => {
    const { client } = harness({ operations: "all" });
    const { data } = await client.query({ query: hello });
    expect(data).toEqual({ hello: "Hello world" });
  });

  test("a socket per operation, as an app picks one per auth state", async () => {
    const socket = openSocket({ token: "user:alice" });
    const source = vi.fn((_operation: Operation) => socket);
    const client = new ApolloClient({
      link: createAbsintheLink(source, { transport: { operations: "all" } }),
      cache: new InMemoryCache(),
    });
    clients.push(client as ApolloClient<unknown>);
    const { data } = await client.query({ query: hello });
    expect(data).toEqual({ hello: "Hello world" });
    expect(source.mock.calls[0]?.[0].operationName).toBe("Hello");
  });

  test("isSubscription tells subscriptions from the rest", () => {
    const operations: Operation[] = [];
    const recorderLink = new ApolloLink((operation) => {
      operations.push(operation);
      return Observable.of({ data: {} });
    });
    const client = new ApolloClient({
      link: recorderLink,
      cache: new InMemoryCache(),
    });
    clients.push(client as ApolloClient<unknown>);
    client.subscribe({ query: ticked }).subscribe({});
    void client.query({ query: hello });
    expect(operations.map(isSubscription)).toEqual([true, false]);
  });

  test("on the server everything goes over HTTP and the source is never called", async () => {
    vi.stubGlobal("window", undefined);
    try {
      const source = vi.fn();
      const link = splitSubscriptions(createAbsintheLink(source), httpStub);
      const results: unknown[] = [];
      const client = new ApolloClient({ link, cache: new InMemoryCache() });
      clients.push(client as ApolloClient<unknown>);
      client.subscribe({ query: ticked }).subscribe({
        next: (value) => results.push(value),
      });
      await eventually(() => expect(results).toHaveLength(1));
      expect(source).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("resyncOnJoin refetches after a reconnect", async () => {
    const { client, transport } = harness();
    const refetch = vi.spyOn(client, "refetchQueries");
    const stop = resyncOnJoin(client, transport, { skipFirst: true });
    renderSubscription(client, ticked);
    await nextEvent(transport, "joined");
    expect(refetch).not.toHaveBeenCalled();
    const rejoined = nextEvent(transport, "joined");
    await server.disconnect();
    await rejoined;
    expect(refetch).toHaveBeenCalledWith({ include: "active" });
    stop();
  });
});
