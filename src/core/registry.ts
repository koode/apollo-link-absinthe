import { Transport } from "./transport";
import type {
  IAbsintheTransport,
  IPhoenixSocketLike,
  ITransportOptions,
} from "./types";

export type TransportCreatedListener = (
  transport: IAbsintheTransport,
  socket: IPhoenixSocketLike,
) => void;

const transports = new WeakMap<IPhoenixSocketLike, Transport>();
const createdListeners = new Set<TransportCreatedListener>();

/** The transport of a socket, when it has one; internal, for the managed socket. */
export function transportOf(socket: IPhoenixSocketLike): Transport | undefined {
  return transports.get(socket);
}

/**
 * Creates the transport for a socket. Throws when the socket already has one:
 * two control channels on one socket leave each other on every rejoin.
 */
export function createAbsintheTransport(
  socket: IPhoenixSocketLike,
  options: ITransportOptions = {},
): IAbsintheTransport {
  if (transports.has(socket))
    throw new Error(
      "This socket already has an Absinthe transport. Use getAbsintheTransport(socket) to share it.",
    );
  const transport = new Transport(socket, options, () =>
    transports.delete(socket),
  );
  transports.set(socket, transport);
  // oxlint-disable-next-line unicorn/no-useless-spread -- a snapshot: a listener may add or remove listeners while the loop runs.
  for (const listener of [...createdListeners]) listener(transport, socket);
  return transport;
}

/** The socket's transport, created on first use. `options` apply only when this call creates it. */
export function getAbsintheTransport(
  socket: IPhoenixSocketLike,
  options: ITransportOptions = {},
): IAbsintheTransport {
  return transports.get(socket) ?? createAbsintheTransport(socket, options);
}

/** Disposes the socket's transport, if it has one. Call it before you throw a socket away. */
export function disposeAbsintheTransport(socket: IPhoenixSocketLike): void {
  transports.get(socket)?.dispose();
}

/**
 * Calls `listener` for every transport created from now on. Use it to keep
 * event listeners across sockets: an app that opens a new socket per session
 * gets a new transport each time.
 */
export function onAbsintheTransport(
  listener: TransportCreatedListener,
): () => void {
  createdListeners.add(listener);
  return () => {
    createdListeners.delete(listener);
  };
}
