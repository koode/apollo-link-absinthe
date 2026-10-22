import { vi } from "vitest";
import type { IAbsintheTransport, ITransportEvents } from "../../src";

type EventValue<TName extends keyof ITransportEvents> = Parameters<
  ITransportEvents[TName]
>[0];

/** The next `name` event of the transport that matches `accept`. */
export function nextEvent<TName extends keyof ITransportEvents>(
  transport: IAbsintheTransport,
  name: TName,
  accept: (value: EventValue<TName>) => boolean = () => true,
): Promise<EventValue<TName>> {
  return new Promise((resolve) => {
    const stop = transport.on(name, ((value: EventValue<TName>) => {
      if (!accept(value)) return;
      stop();
      resolve(value);
    }) as ITransportEvents[TName]);
  });
}

/** Every `name` event of the transport from now on. */
export function collectEvents<TName extends keyof ITransportEvents>(
  transport: IAbsintheTransport,
  name: TName,
): Array<EventValue<TName>> {
  const values: Array<EventValue<TName>> = [];
  transport.on(name, ((value: EventValue<TName>) => {
    values.push(value);
  }) as ITransportEvents[TName]);
  return values;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** vi.waitFor with room for a real server: the first connect of a run can take a second. */
export function eventually<TResult>(
  check: () => TResult | Promise<TResult>,
  timeout = 5000,
): Promise<TResult> {
  return vi.waitFor(check, { timeout, interval: 20 });
}
