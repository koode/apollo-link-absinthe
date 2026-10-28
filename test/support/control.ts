import { inject } from "vitest";

export interface IServerConnect {
  token: string | null;
  via: "auth_token" | "params" | "none";
}

export type ServerLogEntry =
  | { event: "doc"; query: string; variables: unknown }
  | { event: "unsubscribe"; subscriptionId: string };

export interface IServerState {
  connects: IServerConnect[];
  log: ServerLogEntry[];
  /** Subscription documents Absinthe holds, all sockets together. */
  subscriptions: number;
}

export interface IServerSettings {
  joinMode?: "normal" | "reject" | "slow";
  joinDelayMs?: number;
  /** Delays for the next docs, one each, before Absinthe sees them. */
  docDelays?: number[];
  unsubscribeMode?: "normal" | "error" | "silent";
}

export function serverUrl(): string {
  return inject("serverUrl");
}

export function socketUrl(): string {
  return `${serverUrl().replace(/^http/u, "ws")}/socket`;
}

async function post(path: string, body: object = {}): Promise<void> {
  const response = await fetch(`${serverUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
}

export const server = {
  reset: () => post("/control/reset"),
  settings: (settings: IServerSettings) => post("/control/settings", settings),
  publish: (topic: string, value: number, fail = false) =>
    post("/control/publish", { topic, value, fail }),
  /** Disconnects every socket of the user, as revoking a session does. */
  disconnect: (user = "anonymous") => post("/control/disconnect", { user }),
  closeChannels: () => post("/control/channels/close"),
  crashChannels: () => post("/control/channels/crash"),
  async state(): Promise<IServerState> {
    const response = await fetch(`${serverUrl()}/control/state`);
    return (await response.json()) as IServerState;
  },
  async docs(): Promise<Array<{ query: string; variables: unknown }>> {
    const { log } = await server.state();
    return log.flatMap((entry) =>
      entry.event === "doc"
        ? [{ query: entry.query, variables: entry.variables }]
        : [],
    );
  },
  async unsubscribes(): Promise<string[]> {
    const { log } = await server.state();
    return log.flatMap((entry) =>
      entry.event === "unsubscribe" ? [entry.subscriptionId] : [],
    );
  },
};
