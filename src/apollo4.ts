import { type ApolloClient, ApolloLink, Observable } from "@apollo/client";
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

/**
 * The Apollo Client 4 link. GraphQL errors arrive as `result.errors`, so Apollo
 * builds `CombinedGraphQLErrors` with every field the server sent. Transport
 * failures arrive as an `AbsintheSocketError`.
 */
export function createAbsintheLink(
  source: AbsintheLinkSource<ApolloLink.Operation>,
  options: IAbsintheLinkOptions = {},
): ApolloLink {
  return new ApolloLink(
    (operation) =>
      new Observable<ApolloLink.Result>((observer) =>
        runOperation(source, operation, options, {
          next: (result) => observer.next(result as ApolloLink.Result),
          error: (error) => observer.error(error),
          complete: () => observer.complete(),
        }),
      ),
  );
}

/** True for a subscription operation. */
export function isSubscription(operation: ApolloLink.Operation): boolean {
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
  client: ApolloClient,
  transport: IAbsintheTransport,
  options: IResyncOptions = {},
): () => void {
  return resyncTransport(client, transport, options);
}
