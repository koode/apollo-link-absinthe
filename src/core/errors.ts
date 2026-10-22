import type { IAbsintheRequest } from "./types";

export type AbsintheSocketErrorCode =
  /** The control join was refused `joinErrorLimit` times in a row (an event before that). */
  | "JOIN_REJECTED"
  /** Event only: the control join got no answer; phoenix joins again. */
  | "JOIN_TIMEOUT"
  /** A doc got no answer after every retry. */
  | "DOC_TIMEOUT"
  /** The channel crashed `crashLimit` times with this doc in flight. */
  | "CHANNEL_CRASHED"
  /** A query or mutation was in flight when the socket or channel dropped. It is never retried. */
  | "DISCONNECTED"
  /** Event only: the server refused or did not answer an `unsubscribe`. */
  | "UNSUBSCRIBE_FAILED"
  /** Event only: one connect attempt failed (an auth refusal looks the same in a browser), or the token could not be read. */
  | "CONNECT_FAILED"
  /** A reply that is not GraphQL-shaped, for example `{error: "Could not parse variables as map"}`. */
  | "PROTOCOL"
  /** A query or mutation reached a transport without `operations: 'all'`. */
  | "OPERATION_NOT_ENABLED";

const defaultMessages: Record<AbsintheSocketErrorCode, string> = {
  JOIN_REJECTED: "The server refused to join the Absinthe control channel",
  JOIN_TIMEOUT: "The Absinthe control channel did not answer the join",
  DOC_TIMEOUT: "The server did not answer the GraphQL document",
  CHANNEL_CRASHED:
    "The Absinthe control channel crashed each time this document was sent",
  DISCONNECTED: "The socket dropped while the operation was in flight",
  UNSUBSCRIBE_FAILED: "The server did not confirm the unsubscribe",
  CONNECT_FAILED: "The socket could not connect",
  PROTOCOL: "The server's reply is not a GraphQL result",
  OPERATION_NOT_ENABLED:
    "Queries and mutations over the socket need the transport option operations: 'all'",
};

export interface IAbsintheSocketErrorOptions {
  /** The server's reply payload, when there was one. */
  payload?: unknown;
  request?: IAbsintheRequest;
  cause?: unknown;
  message?: string;
}

/**
 * A failure of the socket or the protocol. GraphQL errors from the server are
 * never wrapped in this class: they reach the app as `result.errors`.
 */
export class AbsintheSocketError extends Error {
  override readonly name = "AbsintheSocketError" as const;
  readonly code: AbsintheSocketErrorCode;
  /** The server's reply payload, when there was one. */
  readonly payload?: unknown;
  readonly request?: IAbsintheRequest;

  constructor(
    code: AbsintheSocketErrorCode,
    options: IAbsintheSocketErrorOptions = {},
  ) {
    super(
      options.message ?? defaultMessages[code],
      "cause" in options ? { cause: options.cause } : undefined,
    );
    this.code = code;
    if ("payload" in options) this.payload = options.payload;
    if (options.request) this.request = options.request;
  }
}

/**
 * True for an `AbsintheSocketError`, also one from another copy of this
 * package (the ESM and the CJS build can both be loaded in one app).
 */
export function isAbsintheSocketError(
  error: unknown,
): error is AbsintheSocketError {
  if (error instanceof AbsintheSocketError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "AbsintheSocketError" &&
    typeof candidate.code === "string"
  );
}
