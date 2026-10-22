import { expect } from "vitest";
import type { AbsintheSocketError, IAbsintheResult, ISink } from "../../src";
import { eventually } from "./events";

export type SinkEvent =
  | { type: "next"; result: IAbsintheResult }
  | { type: "error"; error: AbsintheSocketError }
  | { type: "complete" };

export interface IRecorder {
  sink: ISink;
  events: SinkEvent[];
  results(): IAbsintheResult[];
  errors(): AbsintheSocketError[];
  completed(): boolean;
  /** Waits until `count` results arrived. */
  waitForResults(count: number): Promise<IAbsintheResult[]>;
}

export function record(): IRecorder {
  const events: SinkEvent[] = [];
  const recorder: IRecorder = {
    events,
    sink: {
      next: (result) => events.push({ type: "next", result }),
      error: (error) => events.push({ type: "error", error }),
      complete: () => events.push({ type: "complete" }),
    },
    results: () =>
      events.flatMap((event) => (event.type === "next" ? [event.result] : [])),
    errors: () =>
      events.flatMap((event) => (event.type === "error" ? [event.error] : [])),
    completed: () => events.some((event) => event.type === "complete"),
    async waitForResults(count) {
      await eventually(() =>
        expect(recorder.results().length).toBeGreaterThanOrEqual(count),
      );
      return recorder.results();
    },
  };
  return recorder;
}
