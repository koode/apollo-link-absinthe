import type { AbsintheSocketError } from "./errors";

/** A reply hook as a phoenix `Push` offers it. */
export interface IPushLike {
  receive(status: string, callback: (response?: unknown) => void): IPushLike;
}

/** The part of a phoenix `Channel` the transport uses. */
export interface IPhoenixChannelLike {
  join(timeout?: number): IPushLike;
  leave(timeout?: number): IPushLike;
  push(event: string, payload: object, timeout?: number): IPushLike;
  onError(callback: (reason?: unknown) => void): unknown;
  onClose(callback: (payload?: unknown) => void): unknown;
}

/** A frame as phoenix hands it to `socket.onMessage`. */
export interface IPhoenixMessage {
  topic: string;
  event: string;
  payload?: unknown;
  ref?: string | null;
  join_ref?: string | null;
}

/**
 * The structural part of a phoenix `Socket` the transport uses. It matches the
 * phoenix client from 1.6 to 1.8 and `@types/phoenix`, so the library needs no
 * phoenix types of its own.
 */
export interface IPhoenixSocketLike {
  channel(topic: string, params?: object): IPhoenixChannelLike;
  onOpen(callback: () => void): unknown;
  onClose(callback: (event?: unknown) => void): unknown;
  onError(callback: (error?: unknown) => void): unknown;
  /** Phoenix hands every frame here as an `IPhoenixMessage`; typed `object` as in `@types/phoenix`. */
  onMessage(callback: (message: object) => void): unknown;
  off?(refs: string[]): void;
  connect(): void;
  isConnected(): boolean;
  /** The default push timeout of the socket (phoenix: 10 s). */
  timeout?: number;
  /** Phoenix's channel rejoin backoff. */
  rejoinAfterMs?: (tries: number) => number;
}

export type Variables = Record<string, unknown>;

/** One GraphQL document as it goes to Absinthe: `operationName` is not read by the server. */
export interface IAbsintheRequest {
  query: string;
  variables: Variables;
}

/**
 * A GraphQL error as the server formats it. Absinthe merges extra fields at the
 * top level next to `extensions`; they are kept as they are.
 */
export interface IGraphQLFormattedErrorLike {
  readonly message: string;
  readonly locations?: ReadonlyArray<{
    readonly line: number;
    readonly column: number;
  }>;
  readonly path?: ReadonlyArray<string | number>;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

/** A GraphQL result exactly as the server sent it. `errors` entries are never copied or reshaped. */
export interface IAbsintheResult {
  data?: Record<string, unknown> | null;
  errors?: ReadonlyArray<IGraphQLFormattedErrorLike>;
  extensions?: Record<string, unknown>;
}

/** Where the results of one subscription or operation go. */
export interface ISink {
  next(result: IAbsintheResult): void;
  error(error: AbsintheSocketError): void;
  complete(): void;
}

export type TransportStatus =
  | "idle"
  | "connecting"
  | "joining"
  | "live"
  | "reconnecting"
  | "disposed";

export interface IJoinedInfo {
  /** The first join of this transport. */
  first: boolean;
}

export interface IDocLiveInfo {
  query: string;
  variables: Variables;
  subscriptionId: string;
}

export interface ITransportEvents {
  /**
   * The server has answered every doc pushed on a join (ok, error or the first
   * timeout), so the subscriptions are live and a refetch catches what was missed.
   */
  joined: (info: IJoinedInfo) => void;
  /** The server accepted a doc: on the first subscribe and again on every rejoin. */
  docLive: (info: IDocLiveInfo) => void;
  status: (status: TransportStatus) => void;
  /** Every failure, also the ones that reach no observer (join retries, unsubscribe failures). For logging. */
  error: (error: AbsintheSocketError) => void;
}

export interface IDocRetry {
  /** Retries after the first timeout. */
  attempts: number;
  /** The wait before retry number `attempt` (1-based). */
  backoffMs(attempt: number): number;
}

export interface ITransportOptions {
  /** `lazy` (default): the first subscription connects the socket when it is not connected. `manual`: the app connects. */
  connect?: "lazy" | "manual";
  /** Timeout of one `doc` push. Default: the socket's timeout (10 s). */
  docTimeoutMs?: number;
  /** Retries of a timed-out `doc` while the channel stays joined. Default: 3 retries after 1 s, 2 s and 4 s, with jitter. */
  docRetry?: IDocRetry;
  /** Join `error` replies in a row before the observers fail. Default 3. */
  joinErrorLimit?: number;
  /** Channel crashes with the same doc in flight before that doc fails alone. Default 2. */
  crashLimit?: number;
  /** Also carry queries and mutations (a one-shot `doc`). Default `subscriptions`. */
  operations?: "subscriptions" | "all";
}

export interface IAbsintheTransport {
  /** Refcounted: identical (query, canonical variables) share one server subscription. Returns the teardown. */
  subscribe(request: IAbsintheRequest, sink: ISink): () => void;
  /** A one-shot query or mutation (needs `operations: 'all'`). Never deduplicated, never retried. */
  execute(request: IAbsintheRequest, sink: ISink): () => void;
  on<TName extends keyof ITransportEvents>(
    name: TName,
    listener: ITransportEvents[TName],
  ): () => void;
  readonly status: TransportStatus;
  /** The number of distinct server subscriptions (for tests and debug panels). */
  activeCount(): number;
  /** Leaves the control channel and completes every observer. The socket stays open: it may be shared. */
  dispose(): void;
}
