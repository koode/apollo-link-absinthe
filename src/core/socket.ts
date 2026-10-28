import { Socket as PhoenixSocket } from "phoenix";
import { jitteredReconnectAfterMs } from "./backoff";
import { isServer } from "./environment";
import { AbsintheSocketError } from "./errors";
import { createAbsintheTransport, transportOf } from "./registry";
import type {
  IAbsintheTransport,
  IPhoenixChannelLike,
  IPhoenixSocketLike,
  IPushLike,
  ITransportOptions,
} from "./types";

export type SocketToken = string | null | undefined;

export interface ISocketAuth {
  /**
   * Read before every connect and reconnect, never once for all. It may be
   * async: the connect waits for it. `null` or `undefined` connects without a token.
   */
  token(): SocketToken | PromiseLike<SocketToken>;
  /**
   * How the token goes on the wire.
   * - `{ authToken: true }` (default): phoenix's `authToken`, sent in the
   *   WebSocket subprotocol header, so it stays out of access logs. Needs the
   *   phoenix client 1.8 or later and `auth_token: true` on the server socket.
   * - `{ params }`: in the URL query, for phoenix 1.6 and 1.7 clients.
   */
  send?:
    | { authToken: true }
    | { params: (token: string) => Record<string, unknown> };
  /**
   * `refreshAuth()` reconnects at once when the token changed. The server
   * checks the token only at connect. Default false: the next reconnect sends it.
   */
  reconnectOnChange?: boolean;
}

/** A socket the managed socket can connect and disconnect. */
export interface IManagedPhoenixSocketLike extends IPhoenixSocketLike {
  disconnect(callback?: () => void, code?: number, reason?: string): void;
}

/** The phoenix `Socket` class or a stand-in with the same constructor. */
export type PhoenixSocketConstructor<TSocket> = new (
  endPoint: string,
  // oxlint-disable-next-line typescript/no-explicit-any -- the options type differs per phoenix version and type package; any in this parameter is what lets every Socket class fit.
  options?: any,
) => TSocket;

export interface IManagedSocketOptions<
  TSocket extends IManagedPhoenixSocketLike,
> {
  auth?: ISocketAuth;
  /** Default: full jitter, a random wait up to 1 s doubled per try, capped at 30 s, at least 500 ms. */
  reconnectAfterMs?: (tries: number) => number;
  /** Passed to `new Socket` (heartbeatIntervalMs, logger, transport, params, ...). */
  socketOptions?: Record<string, unknown> & {
    params?: Record<string, unknown> | (() => Record<string, unknown>);
  };
  /** The Socket class. Default: `Socket` from `phoenix`. */
  Socket?: PhoenixSocketConstructor<TSocket>;
  /** Options of the socket's Absinthe transport. */
  transport?: ITransportOptions;
}

export interface IManagedSocket<TSocket extends IManagedPhoenixSocketLike> {
  /** Share it for other channels: `socket.channel("presence:order:1")`. */
  readonly socket: TSocket;
  readonly transport: IAbsintheTransport;
  /**
   * Reads the token again. With `reconnectOnChange`, a new token disconnects
   * and connects the socket: the channels rejoin and every subscription is
   * sent again, then `joined` fires with `first: false`.
   */
  refreshAuth(): Promise<void>;
  /** Disposes the transport (its observers complete) and disconnects. */
  close(): void;
}

const authTokenProbe = "apollo-link-absinthe:auth-token-probe";

/** Phoenix 1.8.0 to 1.8.8 keep `authToken` as a string; later versions wrap it in a function. */
type AuthTokenStyle = "string" | "function";

interface IAuthTokenHolder {
  authToken?: unknown;
}

function authTokenStyleOf(socket: object): AuthTokenStyle {
  const value = (socket as IAuthTokenHolder).authToken;
  if (typeof value === "function") return "function";
  if (value === authTokenProbe) return "string";
  throw new Error(
    "auth.send { authToken: true } needs the phoenix client 1.8 or later. With an older client, use auth.send: { params }.",
  );
}

/** An empty token is no token, the same as null or undefined. */
function tokenOrNull(token: SocketToken): string | null {
  return typeof token === "string" && token !== "" ? token : null;
}

function isPromiseLike(value: unknown): value is PromiseLike<SocketToken> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function createInertSocket(): IManagedPhoenixSocketLike {
  const push: IPushLike = { receive: () => push };
  const channel: IPhoenixChannelLike = {
    join: () => push,
    leave: () => push,
    push: () => push,
    onError: () => {},
    onClose: () => {},
  };
  return {
    channel: () => channel,
    onOpen: () => {},
    onClose: () => {},
    onError: () => {},
    onMessage: () => {},
    connect: () => {},
    disconnect: (callback) => callback?.(),
    isConnected: () => false,
  };
}

/**
 * A phoenix socket with fresh auth on every connect, a jittered reconnect
 * backoff, and its Absinthe transport. On the server it never touches `window`
 * or a WebSocket: the socket is inert and the transport is disposed.
 */
export function createPhoenixSocket<
  TSocket extends IManagedPhoenixSocketLike = IManagedPhoenixSocketLike,
>(
  url: string,
  options: IManagedSocketOptions<TSocket> = {},
): IManagedSocket<TSocket> {
  if (isServer()) {
    const socket = createInertSocket() as TSocket;
    const transport = createAbsintheTransport(socket, options.transport);
    transport.dispose();
    return {
      socket,
      transport,
      refreshAuth: () => Promise.resolve(),
      close: () => {},
    };
  }

  const auth = options.auth;
  const send = auth?.send ?? { authToken: true };
  const socketOptions: Record<string, unknown> = {
    ...options.socketOptions,
    reconnectAfterMs: options.reconnectAfterMs ?? jitteredReconnectAfterMs,
  };
  let currentToken: string | null = null;
  if (auth && "params" in send) {
    const staticParams = options.socketOptions?.params;
    socketOptions.params = () => ({
      ...(typeof staticParams === "function" ? staticParams() : staticParams),
      ...(currentToken === null ? {} : send.params(currentToken)),
    });
  }
  const usesAuthToken = auth !== undefined && "authToken" in send;
  if (usesAuthToken) socketOptions.authToken = authTokenProbe;

  const SocketClass = (options.Socket ??
    PhoenixSocket) as PhoenixSocketConstructor<TSocket>;
  const socket = new SocketClass(url, socketOptions);
  const authTokenStyle = usesAuthToken ? authTokenStyleOf(socket) : null;
  const holder = socket as IAuthTokenHolder;

  const applyToken = (token: SocketToken) => {
    currentToken = tokenOrNull(token);
    if (authTokenStyle === null) return;
    const value = currentToken;
    if (value === null) holder.authToken = undefined;
    else holder.authToken = authTokenStyle === "string" ? value : () => value;
  };
  applyToken(null);

  const transport = createAbsintheTransport(socket, options.transport);
  const reconnectAfterMs = options.reconnectAfterMs ?? jitteredReconnectAfterMs;
  const phoenixConnect = socket.connect.bind(socket);
  const phoenixDisconnect = socket.disconnect.bind(socket);
  let closed = false;
  /** Bumped on every disconnect: a token read that started before it does not connect. */
  let epoch = 0;
  let reading = false;
  let tokenFailures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetryTimer = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const tokenFailed = (cause: unknown) => {
    tokenFailures++;
    transportOf(socket)?.reportError(
      new AbsintheSocketError("CONNECT_FAILED", {
        message: "The socket token could not be read",
        cause,
      }),
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      socket.connect();
    }, reconnectAfterMs(tokenFailures));
  };

  const connectWith = (token: SocketToken) => {
    tokenFailures = 0;
    applyToken(token);
    phoenixConnect();
  };

  // Phoenix reads params and authToken synchronously in connect, also for its
  // own reconnects, so every connect goes through here and reads the token first.
  socket.connect = () => {
    if (closed || reading || retryTimer) return;
    if (!auth) {
      phoenixConnect();
      return;
    }
    const startedIn = epoch;
    let token: SocketToken | PromiseLike<SocketToken>;
    try {
      token = auth.token();
    } catch (error) {
      tokenFailed(error);
      return;
    }
    if (!isPromiseLike(token)) {
      connectWith(token);
      return;
    }
    reading = true;
    Promise.resolve(token).then(
      (resolved) => {
        if (startedIn !== epoch) return;
        reading = false;
        connectWith(resolved);
      },
      (error: unknown) => {
        if (startedIn !== epoch) return;
        reading = false;
        tokenFailed(error);
      },
    );
  };

  socket.disconnect = (callback, code, reason) => {
    epoch++;
    reading = false;
    clearRetryTimer();
    phoenixDisconnect(callback, code, reason);
  };

  return {
    socket,
    transport,
    async refreshAuth() {
      if (!auth || closed) return;
      const token = tokenOrNull(await auth.token());
      if (token === currentToken || auth.reconnectOnChange !== true) return;
      if (!socket.isConnected()) return;
      socket.disconnect(() => socket.connect());
    },
    close() {
      if (closed) return;
      transport.dispose();
      socket.disconnect();
      closed = true;
    },
  };
}
