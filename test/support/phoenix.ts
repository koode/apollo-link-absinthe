import { Socket as Socket18 } from "phoenix";
import { Socket as Socket16 } from "phoenix-1.6";
import { Socket as Socket188 } from "phoenix-1.8.8";
import { WebSocket } from "ws";

/** The phoenix client the suite runs against: PHOENIX_CLIENT=1.6 or 1.8 (default). */
export const phoenixClient =
  process.env.PHOENIX_CLIENT === "1.6" ? "1.6" : "1.8";

export const Socket: typeof Socket18 =
  phoenixClient === "1.6" ? (Socket16 as typeof Socket18) : Socket18;

/** Phoenix 1.8.0 to 1.8.8 keep `authToken` as a string instead of a function. */
export const SocketWithStringAuthToken = Socket188 as typeof Socket18;

/**
 * The `ws` WebSocket in every environment. Node's own (undici) breaks under
 * jsdom: it dispatches jsdom's Event class into Node's EventTarget.
 */
export const WebSocketTransport = WebSocket;
