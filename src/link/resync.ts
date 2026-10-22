import type { IAbsintheTransport } from "../core/types";

export interface IResyncOptions {
  /** What to refetch: `active` (default) or operation names. */
  include?: "active" | string[];
  /** Skip the first join; refetch only after a reconnect. Default false. */
  skipFirst?: boolean;
}

/** The part of an `ApolloClient` that `resyncOnJoin` uses (Apollo 3.4 and later). */
export interface IRefetchingClient {
  refetchQueries(options: {
    include: "active" | string[];
  }): PromiseLike<unknown>;
}

/**
 * Refetches queries each time the subscriptions are live again (`joined`):
 * what changed while the socket was down was never pushed. Returns the stop function.
 */
export function resyncOnJoin(
  client: IRefetchingClient,
  transport: IAbsintheTransport,
  options: IResyncOptions = {},
): () => void {
  const include = options.include ?? "active";
  return transport.on("joined", ({ first }) => {
    if (first && options.skipFirst) return;
    // A failed refetch reaches the observers of that query; it must not become an unhandled rejection here.
    Promise.resolve(client.refetchQueries({ include })).then(
      undefined,
      () => {},
    );
  });
}
