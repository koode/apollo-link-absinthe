import type { IAbsintheRequest } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(record: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

/** JSON with the keys of every object sorted, so key order does not change the result. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    isRecord(nested) ? sortKeys(nested) : nested,
  );
}

/** The dedupe key of a subscription: the document and its variables in canonical form. */
export function requestKey(request: IAbsintheRequest): string {
  return `${request.query}\n${canonicalJson(request.variables)}`;
}
