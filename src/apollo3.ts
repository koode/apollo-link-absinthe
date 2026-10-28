/**
 * The entry for Apollo Client 3.4 and later. It also exports the core, so an
 * Apollo 3 app imports everything from here and never loads the Apollo 4 link.
 */
import {
  type ApolloClient,
  ApolloLink,
  type FetchResult,
  Observable,
  type Operation,
} from "@apollo/client-3/core";
import { isServer } from "./core/environment";
import type { IAbsintheTransport } from "./core/types";
import {
  type AbsintheLinkSource,
  type IAbsintheLinkOptions,
  isSubscriptionOperation,
  runOperation,
} from "./link/operation";
import {
  type IResyncOptions,
  resyncOnJoin as resyncTransport,
} from "./link/resync";

export * from "./core";
export type {
  AbsintheLinkSource,
  IAbsintheLinkOptions,
} from "./link/operation";
export type { IResyncOptions } from "./link/resync";

/**
 * The Apollo Client 3 link. GraphQL errors arrive as `result.errors`, so
 * Apollo builds an `ApolloError` whose `graphQLErrors` keep every field the
 * server sent. Transport failures arrive as a raw `AbsintheSocketError`:
 * Apollo 3 does not wrap link errors on subscriptions.
 */
export function createAbsintheLink(
  source: AbsintheLinkSource<Operation>,
  options: IAbsintheLinkOptions = {},
): ApolloLink {
  return new ApolloLink(
    (operation) =>
      new Observable<FetchResult>((observer) =>
        runOperation(source, operation, options, {
          // Apollo 3 types errors as GraphQLError; on the wire, and from HttpLink too, they are plain objects.
          next: (result) => observer.next(result as unknown as FetchResult),
          error: (error) => observer.error(error),
          complete: () => observer.complete(),
        }),
      ),
  );
}

/** True for a subscription operation. */
export function isSubscription(operation: Operation): boolean {
  return isSubscriptionOperation(operation);
}

/** Subscriptions go to `absintheLink`, the rest to `httpLink`. On the server everything goes to `httpLink`. */
export function splitSubscriptions(
  absintheLink: ApolloLink,
  httpLink: ApolloLink,
): ApolloLink {
  return ApolloLink.split(
    (operation) => !isServer() && isSubscription(operation),
    absintheLink,
    httpLink,
  );
}

/** Refetches the active queries (or `include`) on every `joined` of the transport. Returns the stop function. */
export function resyncOnJoin(
  client: ApolloClient<unknown>,
  transport: IAbsintheTransport,
  options: IResyncOptions = {},
): () => void {
  return resyncTransport(client, transport, options);
}
