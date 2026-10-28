import { type DocumentNode, getOperationAST, print } from "graphql";
import { isServer } from "../core/environment";
import { getAbsintheTransport } from "../core/registry";
import type {
  IAbsintheTransport,
  IPhoenixSocketLike,
  ISink,
  ITransportOptions,
  Variables,
} from "../core/types";

/** The part of an Apollo operation the link reads; the same in Apollo 3 and 4. */
export interface IOperationLike {
  query: DocumentNode;
  variables: Variables;
  operationName?: string | undefined;
}

/**
 * Where the link sends an operation: a transport, a socket (its transport is
 * created on first use), or a function that picks one per operation, for
 * example a socket per auth state. The function is never called on the
 * server. When it returns nothing, the operation completes at once.
 */
export type AbsintheLinkSource<TOperation> =
  | IAbsintheTransport
  | IPhoenixSocketLike
  | ((
      operation: TOperation,
    ) => IAbsintheTransport | IPhoenixSocketLike | null | undefined);

export interface IAbsintheLinkOptions {
  /** Options of a transport the link creates for a socket. */
  transport?: ITransportOptions;
}

const printed = new WeakMap<DocumentNode, string>();

function printOnce(document: DocumentNode): string {
  let query = printed.get(document);
  if (query === undefined) {
    query = print(document);
    printed.set(document, query);
  }
  return query;
}

function isTransport(
  value: IAbsintheTransport | IPhoenixSocketLike,
): value is IAbsintheTransport {
  return typeof (value as IAbsintheTransport).execute === "function";
}

/** True for a subscription operation. */
export function isSubscriptionOperation(operation: IOperationLike): boolean {
  const definition = getOperationAST(operation.query, operation.operationName);
  // oxlint-disable-next-line typescript/no-unsafe-enum-comparison -- graphql 15 has no OperationTypeNode enum at runtime, and this package supports it; the string is what every version holds.
  return definition?.operation === "subscription";
}

/** Runs one Apollo operation on its transport. Returns the teardown. */
export function runOperation<TOperation extends IOperationLike>(
  source: AbsintheLinkSource<TOperation>,
  operation: TOperation,
  options: IAbsintheLinkOptions,
  sink: ISink,
): () => void {
  if (isServer()) {
    sink.complete();
    return () => {};
  }
  const resolved = typeof source === "function" ? source(operation) : source;
  if (!resolved) {
    sink.complete();
    return () => {};
  }
  const transport = isTransport(resolved)
    ? resolved
    : getAbsintheTransport(resolved, options.transport);
  const request = {
    query: printOnce(operation.query),
    variables: operation.variables,
  };
  return isSubscriptionOperation(operation)
    ? transport.subscribe(request, sink)
    : transport.execute(request, sink);
}
