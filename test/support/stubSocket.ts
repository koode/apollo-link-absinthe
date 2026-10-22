import type {
  IPhoenixChannelLike,
  IPhoenixMessage,
  IPhoenixSocketLike,
  IPushLike,
} from "../../src";

/** A push whose replies the test fires by hand. */
export class StubPush implements IPushLike {
  readonly hooks = new Map<string, (response?: unknown) => void>();

  receive(status: string, callback: (response?: unknown) => void): IPushLike {
    this.hooks.set(status, callback);
    return this;
  }

  reply(status: "ok" | "error" | "timeout", response?: unknown): void {
    this.hooks.get(status)?.(response);
  }
}

export interface IStubPushed {
  event: string;
  payload: Record<string, unknown>;
  push: StubPush;
}

export class StubChannel implements IPhoenixChannelLike {
  readonly joinPush = new StubPush();
  readonly pushed: IStubPushed[] = [];
  left = false;
  private readonly errorCallbacks: Array<() => void> = [];
  private readonly closeCallbacks: Array<() => void> = [];

  join(): IPushLike {
    return this.joinPush;
  }

  leave(): IPushLike {
    this.left = true;
    return new StubPush();
  }

  push(event: string, payload: object): IPushLike {
    const push = new StubPush();
    this.pushed.push({
      event,
      payload: payload as Record<string, unknown>,
      push,
    });
    return push;
  }

  onError(callback: () => void): unknown {
    this.errorCallbacks.push(callback);
    return undefined;
  }

  onClose(callback: () => void): unknown {
    this.closeCallbacks.push(callback);
    return undefined;
  }

  docs(): IStubPushed[] {
    return this.pushed.filter((pushed) => pushed.event === "doc");
  }

  lastDoc(): IStubPushed {
    const doc = this.docs().at(-1);
    if (!doc) throw new Error("No doc was pushed");
    return doc;
  }

  error(): void {
    for (const callback of this.errorCallbacks) callback();
  }

  close(): void {
    for (const callback of this.closeCallbacks) callback();
  }
}

/**
 * A socket without phoenix: the test drives every open, close, reply and
 * frame. It has no `timeout` and no `rejoinAfterMs`, so the transport's own
 * defaults apply.
 */
export class StubSocket implements IPhoenixSocketLike {
  readonly channels: StubChannel[] = [];
  connected = false;
  connects = 0;
  offRefs: string[] = [];
  private readonly openCallbacks: Array<() => void> = [];
  private readonly closeCallbacks: Array<() => void> = [];
  private readonly messageCallbacks: Array<(message: object) => void> = [];

  channel(): IPhoenixChannelLike {
    const channel = new StubChannel();
    this.channels.push(channel);
    return channel;
  }

  get current(): StubChannel {
    const channel = this.channels.at(-1);
    if (!channel) throw new Error("No channel was created");
    return channel;
  }

  onOpen(callback: () => void): unknown {
    this.openCallbacks.push(callback);
    return "open-ref";
  }

  onClose(callback: () => void): unknown {
    this.closeCallbacks.push(callback);
    return "close-ref";
  }

  onError(): unknown {
    return undefined;
  }

  onMessage(callback: (message: object) => void): unknown {
    this.messageCallbacks.push(callback);
    return 3;
  }

  off(refs: string[]): void {
    this.offRefs = refs;
  }

  connect(): void {
    this.connects++;
  }

  isConnected(): boolean {
    return this.connected;
  }

  open(): void {
    this.connected = true;
    for (const callback of this.openCallbacks) callback();
  }

  /** As phoenix does on a close: the channels error first, then the close callbacks run. */
  drop(): void {
    this.connected = false;
    this.current.error();
    for (const callback of this.closeCallbacks) callback();
  }

  /** Opens and joins the current channel. */
  join(): StubChannel {
    if (!this.connected) this.open();
    const channel = this.current;
    channel.joinPush.reply("ok", {});
    return channel;
  }

  message(message: IPhoenixMessage | object): void {
    for (const callback of this.messageCallbacks) callback(message);
  }

  data(subscriptionId: string, result: unknown): void {
    this.message({
      topic: subscriptionId,
      event: "subscription:data",
      payload: { result, subscriptionId },
    });
  }
}
