const reconnectCeilingMs = 30_000;
const reconnectFloorMs = 500;
const reconnectBaseMs = 1000;
const docRetryBaseMs = 1000;

/**
 * Socket reconnect backoff: full jitter, a random wait up to 1 s doubled per
 * try and capped at 30 s, never under 500 ms. The jitter spreads the clients
 * out after a deploy instead of letting them all reconnect at the same moment.
 */
export function jitteredReconnectAfterMs(tries: number): number {
  const ceiling = Math.min(reconnectCeilingMs, reconnectBaseMs * 2 ** tries);
  return Math.max(reconnectFloorMs, Math.random() * ceiling);
}

/** Wait before doc retry `attempt` (1-based): 1 s, 2 s, 4 s ... each between half and all of it. */
export function docRetryBackoffMs(attempt: number): number {
  const base = docRetryBaseMs * 2 ** (attempt - 1);
  return base / 2 + (Math.random() * base) / 2;
}

/** Phoenix's own channel rejoin schedule, for a socket that does not expose one. */
export function phoenixRejoinAfterMs(tries: number): number {
  return [1000, 2000, 5000][tries - 1] ?? 10_000;
}
