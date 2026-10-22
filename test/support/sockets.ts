import type { Socket as PhoenixSocket } from "phoenix";
import { afterEach } from "vitest";
import { disposeAbsintheTransport } from "../../src";
import { server, socketUrl } from "./control";
import { Socket, WebSocketTransport } from "./phoenix";

/** Fast backoffs and timeouts, so the suite does not wait on phoenix's defaults. */
export const fastSocketOptions = {
  transport: WebSocketTransport,
  timeout: 1000,
  heartbeatIntervalMs: 30_000,
  reconnectAfterMs: () => 50,
  rejoinAfterMs: () => 50,
};

const opened: Array<{ disconnect(): void }> = [];

/** Remembers a socket so the test's cleanup disconnects it. */
export function track<TSocket extends { disconnect(): void }>(
  socket: TSocket,
): TSocket {
  opened.push(socket);
  return socket;
}

export interface IOpenSocketOptions {
  token?: string;
  timeout?: number;
}

/** A real phoenix socket on the test server. The token goes in the params, which every phoenix version supports. */
export function openSocket(options: IOpenSocketOptions = {}): PhoenixSocket {
  const params = options.token ? { token: options.token } : {};
  const socket = new Socket(socketUrl(), {
    ...fastSocketOptions,
    params,
    timeout: options.timeout ?? fastSocketOptions.timeout,
  });
  return track(socket);
}

afterEach(async () => {
  for (const socket of opened.splice(0)) {
    disposeAbsintheTransport(socket as unknown as PhoenixSocket);
    socket.disconnect();
  }
  await server.reset();
});
