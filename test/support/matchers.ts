import { expect } from "vitest";

/*
 * vitest types its asymmetric matchers as any. These hand them out as unknown,
 * so no any flows into the expected values of a test.
 */

export const anyNumber: unknown = expect.any(Number);
export const anyString: unknown = expect.any(String);

/** A GraphQL error location, wherever in the document it points. */
export const anyLocation = { line: anyNumber, column: anyNumber };

export function stringMatching(pattern: RegExp): unknown {
  return expect.stringMatching(pattern);
}

export function stringContaining(text: string): unknown {
  return expect.stringContaining(text);
}
