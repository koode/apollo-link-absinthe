# apollo-link-absinthe

GraphQL subscriptions from [Apollo Client](https://www.apollographql.com/docs/react/) to [Absinthe](https://hexdocs.pm/absinthe) over a Phoenix channel.

It replaces `@absinthe/socket` and `@absinthe/socket-apollo-link`, and fixes what those get wrong:
- **GraphQL errors stay GraphQL errors.** A refused subscription or an error inside a pushed result reaches `useSubscription` and your error link with `extensions.code`, `path`, `locations` and every other field the server sent. The old link turned them into `new Error("request: <messages>")`.
- **Subscriptions come back after a drop**, and you are told when they are live again (`joined`), so you can refetch what you missed.
- **Identical subscriptions share one server subscription** (refcounted). With a `context_id`, Absinthe gives identical documents the same id, so without this every push would arrive twice.
- **Fresh auth on every connect**, including Phoenix 1.8's `authToken`, which keeps the token out of URLs and access logs.
- No runtime dependencies, typed, dual ESM and CJS, safe for server rendering.

Supports Apollo Client 4 (the package root) and Apollo Client 3.4 or later (`apollo-link-absinthe/apollo3`), the phoenix client 1.6 to 1.8, and graphql 15 to 17.

## Install

```sh
pnpm add apollo-link-absinthe
```

Peer dependencies: `@apollo/client` (3.4+ or 4), `graphql` and `phoenix`.

## Quick start: Apollo Client 4

```ts
import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client";
import {
  createAbsintheLink,
  createPhoenixSocket,
  resyncOnJoin,
  splitSubscriptions,
} from "apollo-link-absinthe";

const { socket, transport } = createPhoenixSocket(
  "wss://api.example.com/socket",
  {
    auth: { token: () => getAccessToken() }, // read before every connect
  },
);

const client = new ApolloClient({
  link: splitSubscriptions(
    createAbsintheLink(transport),
    new HttpLink({ uri: "https://api.example.com/graphql" }),
  ),
  cache: new InMemoryCache(),
});

// Optional: refetch the active queries whenever the subscriptions come back.
resyncOnJoin(client, transport, { skipFirst: true });

// The socket is yours to share with other channels.
socket.channel("presence:lobby").join();
```

## Quick start: Apollo Client 3

Import everything from `apollo-link-absinthe/apollo3`. It exports the same names, typed for Apollo 3, plus the whole core, so an Apollo 3 app never loads the Apollo 4 link.

```ts
import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client";
import {
  createAbsintheLink,
  splitSubscriptions,
} from "apollo-link-absinthe/apollo3";
import { Socket } from "phoenix";

const socket = new Socket("/socket", { params: () => ({ token: getToken() }) });

const client = new ApolloClient({
  link: splitSubscriptions(
    createAbsintheLink(socket),
    new HttpLink({ uri: "/graphql" }),
  ),
  cache: new InMemoryCache(),
});
```

TypeScript 4.5 with `moduleResolution: node` is supported: `typesVersions` maps `/apollo3`.

## How it works

One **transport** per socket owns Absinthe's `__absinthe__:control` channel and all protocol state. It has no Apollo in it; the Apollo links are thin wrappers.
- The first subscription creates and joins the control channel (and connects the socket, unless `connect: "manual"`). Nothing happens at import.
- Documents are sent only while the channel is joined.
- Identical subscriptions (same document, same variables in any key order) share one server subscription. The `unsubscribe` goes out when the last observer leaves, also when that happens while the subscription is still being set up.
- After every drop (socket closed, channel crashed or closed by the server), the transport subscribes everything again. Observers see no error and no complete. Once the server has answered every document, `joined` fires with `first: false`.
- A document that gets no answer is retried while the channel stays joined.
- A document that keeps crashing the channel fails on its own (`CHANNEL_CRASHED`) instead of taking the other subscriptions down with it.
- Data that arrives before the reply with its subscription id is buffered and delivered once the id is known.

## API

### Apollo links

From `apollo-link-absinthe` (Apollo 4) and `apollo-link-absinthe/apollo3` (Apollo 3), with each version's own types:

```ts
function createAbsintheLink(
  source: AbsintheLinkSource<Operation>,
  options?: { transport?: ITransportOptions },
): ApolloLink;

type AbsintheLinkSource<TOperation> =
  | IAbsintheTransport
  | IPhoenixSocketLike // its transport is created on first use, with options.transport
  | ((
      operation: TOperation,
    ) => IAbsintheTransport | IPhoenixSocketLike | null | undefined);

function splitSubscriptions(
  absintheLink: ApolloLink,
  httpLink: ApolloLink,
): ApolloLink;
function isSubscription(operation: Operation): boolean;
function resyncOnJoin(
  client: ApolloClient,
  transport: IAbsintheTransport,
  options?: { include?: "active" | string[]; skipFirst?: boolean },
): () => void;
```

- A source function is called for each operation, so you can pick a socket per auth state. It is never called on the server. When it returns nothing, the operation completes at once.
- `splitSubscriptions` sends subscriptions to the socket and everything else to HTTP. On the server, everything goes to HTTP.
- Queries and mutations go over the socket only with `transport: { operations: "all" }`. Otherwise they fail with `OPERATION_NOT_ENABLED`.

### The transport

```ts
function createAbsintheTransport(
  socket: IPhoenixSocketLike,
  options?: ITransportOptions,
): IAbsintheTransport;
function getAbsintheTransport(
  socket: IPhoenixSocketLike,
  options?: ITransportOptions,
): IAbsintheTransport;
function disposeAbsintheTransport(socket: IPhoenixSocketLike): void;
function onAbsintheTransport(
  listener: (transport: IAbsintheTransport, socket: IPhoenixSocketLike) => void,
): () => void;

interface IAbsintheTransport {
  subscribe(request: IAbsintheRequest, sink: ISink): () => void;
  execute(request: IAbsintheRequest, sink: ISink): () => void; // needs operations: "all"
  on<TName extends keyof ITransportEvents>(
    name: TName,
    listener: ITransportEvents[TName],
  ): () => void;
  readonly status:
    | "idle"
    | "connecting"
    | "joining"
    | "live"
    | "reconnecting"
    | "disposed";
  activeCount(): number;
  dispose(): void;
}

interface ITransportEvents {
  joined: (info: { first: boolean }) => void; // every doc of a join was answered
  docLive: (info: {
    query: string;
    variables: Variables;
    subscriptionId: string;
  }) => void;
  status: (status: TransportStatus) => void;
  error: (error: AbsintheSocketError) => void; // every failure, for logging
}

interface ITransportOptions {
  connect?: "lazy" | "manual"; // default lazy: the first subscription connects the socket
  docTimeoutMs?: number; // default: the socket's timeout (10 s)
  docRetry?: { attempts: number; backoffMs(attempt: number): number }; // default 3 retries, 1 s, 2 s, 4 s, jittered
  joinErrorLimit?: number; // default 3
  crashLimit?: number; // default 2
  operations?: "subscriptions" | "all"; // default subscriptions
}
```

- **One transport per socket.** Two control channels on one socket leave each other on every rejoin. `createAbsintheTransport` throws for a socket that already has one; `getAbsintheTransport` shares it.
- `dispose()` completes every observer and leaves the control channel. The socket stays open: it may carry other channels. Call `disposeAbsintheTransport(socket)` before you throw a socket away, for example at sign-out.
- `onAbsintheTransport` tells you about every transport created from then on. Use it to keep event listeners across sockets when your app opens a new socket per session.

### The managed socket

Optional. Use it when your app does not already own a phoenix socket.

```ts
function createPhoenixSocket<TSocket>(
  url: string,
  options?: {
    auth?: {
      token():
        | string
        | null
        | undefined
        | PromiseLike<string | null | undefined>;
      send?:
        | { authToken: true }
        | { params: (token: string) => Record<string, unknown> };
      reconnectOnChange?: boolean;
    };
    reconnectAfterMs?: (tries: number) => number; // default: full jitter, 500 ms to 30 s
    socketOptions?: Record<string, unknown>; // passed to new Socket(...)
    Socket?: new (
      url: string,
      options?: object,
    ) => TSocket; // default: Socket from "phoenix"
    transport?: ITransportOptions;
  },
): {
  socket: TSocket;
  transport: IAbsintheTransport;
  refreshAuth(): Promise<void>;
  close(): void;
};
```

## Error handling

The rule: **GraphQL errors stay GraphQL errors.** Every `errors` array from the server reaches Apollo as `result.errors`, the same objects, never stringified or copied. Apollo then builds its own error type, as it does for an HTTP result. Only failures that are not GraphQL arrive as an `AbsintheSocketError` with a `code`.

| Source                                                                                     | Apollo 4: `useSubscription().error`                                | Apollo 3: `useSubscription().error`                     | Subscription after                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Server refuses the document (validation, `config` returning `{:error, ...}`, complexity)   | `CombinedGraphQLErrors`; `error.errors[0].extensions.code`         | `ApolloError`; `error.graphQLErrors[0].extensions.code` | Ended                                                                     |
| Resolver error inside a pushed result                                                      | `CombinedGraphQLErrors` for that push                              | `ApolloError`                                           | Apollo 4: stays open. Apollo 3: Apollo ends it, and the link unsubscribes |
| Reply that is not GraphQL-shaped                                                           | `AbsintheSocketError` `PROTOCOL` (Apollo tags it as a `LinkError`) | the raw `AbsintheSocketError`                           | Ended                                                                     |
| Join refused `joinErrorLimit` times in a row                                               | `JOIN_REJECTED`                                                    | raw `JOIN_REJECTED`                                     | Ended                                                                     |
| No answer after every retry                                                                | `DOC_TIMEOUT`                                                      | raw `DOC_TIMEOUT`                                       | Ended                                                                     |
| The document crashed the channel `crashLimit` times                                        | `CHANNEL_CRASHED` (this document only)                             | raw `CHANNEL_CRASHED`                                   | Ended                                                                     |
| Query or mutation in flight when the socket drops                                          | `DISCONNECTED`                                                     | `ApolloError` with `networkError` `DISCONNECTED`        | Ended, never retried                                                      |
| Socket drop, refused connect, channel crash, join timeout, a doc timeout with retries left | none                                                               | none                                                    | Stays open; subscribed again                                              |
| `dispose()` or `close()`                                                                   | none (complete)                                                    | none (complete)                                         | Ended                                                                     |

Error links see the same: in Apollo 4 `ErrorLink` gets the `CombinedGraphQLErrors` (with `result.errors`) or the `AbsintheSocketError`. In Apollo 3, `onError` gets `graphQLErrors` or the `AbsintheSocketError` as `networkError`.

```ts
import { CombinedGraphQLErrors } from "@apollo/client";
import { isAbsintheSocketError } from "apollo-link-absinthe";

function describe(error: unknown): string {
  if (CombinedGraphQLErrors.is(error))
    return error.errors
      .map(
        (graphQLError) => graphQLError.extensions?.code ?? graphQLError.message,
      )
      .join(", ");
  if (isAbsintheSocketError(error)) return error.code; // e.g. "DOC_TIMEOUT"
  return "unknown";
}
```

Failures that never reach an observer (join retries, failed connects, unsubscribe failures) go to `transport.on("error", ...)`.

```ts
class AbsintheSocketError extends Error {
  readonly name: "AbsintheSocketError";
  readonly code:
    | "JOIN_REJECTED"
    | "JOIN_TIMEOUT"
    | "DOC_TIMEOUT"
    | "CHANNEL_CRASHED"
    | "DISCONNECTED"
    | "UNSUBSCRIBE_FAILED"
    | "CONNECT_FAILED"
    | "PROTOCOL"
    | "OPERATION_NOT_ENABLED";
  readonly payload?: unknown; // the server's reply, when there was one
  readonly request?: IAbsintheRequest;
}
function isAbsintheSocketError(error: unknown): error is AbsintheSocketError;
```

`isAbsintheSocketError` also recognises an error from the other build (ESM and CJS can both end up in one app).

### `extensions.code` on `config` refusals

The link can only deliver a code the server sends. Absinthe takes `{:error, message}` from a subscription `config` as a plain message, so `{:error, "FORBIDDEN"}` arrives as `{message: "FORBIDDEN"}`, and a map ends up whole in `message`. [`test/server/lib/test_server/subscribe_self.ex`](test/server/lib/test_server/subscribe_self.ex) is a small replacement for Absinthe's `SubscribeSelf` phase: with it, `{:error, %{message: "Not allowed", extensions: %{code: "FORBIDDEN"}}}` reaches the client as a proper error with `extensions.code`.

## Auth

Absinthe checks the token only when the socket connects. The managed socket therefore reads the token **before every connect and reconnect**, also the reconnects phoenix does on its own. An async token is awaited first.

**Phoenix 1.8 `authToken` (default).** The token goes in the `Sec-WebSocket-Protocol` header, not in the URL, so it stays out of access logs. It needs the phoenix client 1.8 or later (the managed socket throws with an older one) and this on the server:

```elixir
socket "/socket", MyAppWeb.UserSocket, websocket: true, auth_token: true

# in MyAppWeb.UserSocket
def connect(_params, socket, connect_info) do
  case verify(connect_info[:auth_token]) do
    {:ok, user} -> {:ok, Absinthe.Phoenix.Socket.put_options(socket, context: %{current_user: user})}
    :error -> :error
  end
end
```

**Params (phoenix 1.6 and 1.7 clients).** The token goes in the URL query:

```ts
createPhoenixSocket(url, {
  auth: {
    token: () => getAccessToken(),
    send: { params: (token) => ({ authorization: `Bearer ${token}` }) },
  },
});
```

**Token refresh.** The open connection keeps the identity it connected with. By default the next reconnect sends the new token. With `reconnectOnChange: true`, `refreshAuth()` reconnects at once when the token changed: the channels rejoin, every subscription is sent again, and `joined` fires with `first: false`.

**Sign-out.** Call `close()` (managed socket) or `disposeAbsintheTransport(socket)` before disconnecting your own socket. The observers complete; they are not errored.

## Server rendering

Nothing runs at import (`sideEffects: false`, no `window` access at module scope). On the server:
- `splitSubscriptions` routes everything to HTTP;
- `createAbsintheLink` completes subscriptions at once and never calls the source function;
- `createPhoenixSocket` builds no socket: you get an inert stand-in and a disposed transport.

## Sharing a socket with other channels

The transport only uses the `__absinthe__:control` channel and the `subscription:data` frames, so the same socket can carry presence or your own channels. Do not join `__absinthe__:control` yourself.

When your app opens a new socket per session, keep app-level listeners with `onAbsintheTransport`:

```ts
import { createAbsintheLink, onAbsintheTransport } from "apollo-link-absinthe";

const joinedListeners = new Set<(first: boolean) => void>();

onAbsintheTransport((transport) => {
  transport.on("joined", ({ first }) => {
    for (const listener of joinedListeners) listener(first);
  });
});

export const subscriptionLink = createAbsintheLink(() => appSocket.current());

export function onSubscriptionsJoined(
  listener: (first: boolean) => void,
): () => void {
  joinedListeners.add(listener);
  return () => joinedListeners.delete(listener);
}
```

## Migrating from `@absinthe/socket-apollo-link`

```ts
// Before
import * as AbsintheSocket from "@absinthe/socket";
import { createAbsintheSocketLink } from "@absinthe/socket-apollo-link";
const socketLink = createAbsintheSocketLink(
  AbsintheSocket.create(phoenixSocket),
);

// After (Apollo 3)
import {
  createAbsintheLink,
  splitSubscriptions,
} from "apollo-link-absinthe/apollo3";
const socketLink = createAbsintheLink(phoenixSocket);
const link = splitSubscriptions(socketLink, httpLink);
```

1. Remove `@absinthe/socket`, `@absinthe/socket-apollo-link` and `@types/absinthe__socket-apollo-link`.
2. Pass the phoenix socket (or a function that picks one per operation) to `createAbsintheLink`. No `@ts-ignore` is needed.
3. Call `disposeAbsintheTransport(socket)` before you disconnect a socket you replace (sign-in, sign-out). The old link left those subscriptions behind.
4. Check how your screens show a subscription error. It used to be a plain `Error("request: <messages>")`. Now it is an `ApolloError` with `graphQLErrors` (Apollo 3) or `CombinedGraphQLErrors` (Apollo 4), so code checks such as `extensions.code === "FORBIDDEN"` work. Transport failures are an `AbsintheSocketError`; give it a branch where you format network errors.
5. A dropped socket no longer sends `"connection: close"` errors. Use `resyncOnJoin` or `transport.on("joined", ...)` to refetch after a reconnect.
6. Identical subscriptions are now deduplicated: a list that subscribes the same document per row sends it once.

## Development

Tools are pinned in `mise.toml` (Node, pnpm, Erlang, Elixir).

```sh
mise install
pnpm install
pnpm server:setup   # fetches and compiles the Phoenix + Absinthe test server
pnpm test           # starts the test server, runs every suite
pnpm test:coverage
pnpm build
```

The main test suite runs the real phoenix client against a real Phoenix + Absinthe app in [`test/server`](test/server), pinned to the versions a production Absinthe app runs. `PHOENIX_CLIENT=1.6 pnpm test` runs the suites with the phoenix 1.6 client. A stub socket covers what a real server cannot produce on demand, such as replies to stale pushes and malformed frames.

## License

MIT
