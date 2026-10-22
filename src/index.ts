/**
 * The core transport and the Apollo Client 4 link. Apollo 3 apps import from
 * `apollo-link-absinthe/apollo3` instead.
 */
export {
  createAbsintheLink,
  isSubscription,
  resyncOnJoin,
  splitSubscriptions,
} from "./apollo4";
export * from "./core";
export type {
  AbsintheLinkSource,
  IAbsintheLinkOptions,
} from "./link/operation";
export type { IResyncOptions } from "./link/resync";
