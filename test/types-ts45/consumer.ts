// An Apollo 3 app's use of the library, compiled with TypeScript 4.5 and moduleResolution node.
import {
  ApolloClient,
  from,
  HttpLink,
  InMemoryCache,
} from "@apollo/client/core";
import {
  type AbsintheSocketError,
  createAbsintheLink,
  createPhoenixSocket,
  disposeAbsintheTransport,
  getAbsintheTransport,
  isAbsintheSocketError,
  resyncOnJoin,
  splitSubscriptions,
} from "apollo-link-absinthe/apollo3";
import { Socket } from "phoenix";

const sockets = new Map<string, Socket>();

function getSocket(token: string | undefined): Socket {
  const key = token ?? "anonymous";
  const existing = sockets.get(key);
  if (existing) return existing;
  const socket = new Socket("/socket", {
    params: { authorization: `Bearer ${token}` },
  });
  sockets.set(key, socket);
  return socket;
}

const socketLink = createAbsintheLink((operation) =>
  getSocket(operation.getContext().token),
);
const link = splitSubscriptions(
  from([socketLink]),
  new HttpLink({ uri: "/graphql" }),
);
const client = new ApolloClient({ link, cache: new InMemoryCache() });

const transport = getAbsintheTransport(getSocket(undefined));
const stopResync = resyncOnJoin(client, transport, {
  include: ["Order"],
  skipFirst: true,
});
transport.on("error", (error: AbsintheSocketError) => {
  console.warn(error.code, error.payload);
});

function describeError(error: unknown): string {
  return isAbsintheSocketError(error) ? error.code : String(error);
}

const managed = createPhoenixSocket<Socket>("/socket", {
  Socket,
  auth: {
    token: () => Promise.resolve("token"),
    send: { params: (token) => ({ authorization: `Bearer ${token}` }) },
  },
});
managed.socket.channel("presence:order:1").join();

disposeAbsintheTransport(getSocket(undefined));
stopResync();
describeError(null);
