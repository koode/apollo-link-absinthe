/**
 * True during server rendering. Read at call time, never at import, so the
 * package has no side effects and no `window` access at module scope.
 */
export function isServer(): boolean {
  return typeof window === "undefined";
}
