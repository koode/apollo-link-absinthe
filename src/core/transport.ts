import { docRetryBackoffMs, phoenixRejoinAfterMs } from "./backoff";
import { requestKey } from "./canonical";
import { AbsintheSocketError, type AbsintheSocketErrorCode } from "./errors";
import type {
  IAbsintheRequest,
  IAbsintheResult,
  IAbsintheTransport,
  IDocRetry,
  IGraphQLFormattedErrorLike,
  IPhoenixChannelLike,
  IPhoenixMessage,
  IPhoenixSocketLike,
  ISink,
  ITransportEvents,
  ITransportOptions,
  TransportStatus,
} from "./types";

const controlTopic = "__absinthe__:control";
const dataEvent = "subscription:data";
const defaultDocTimeoutMs = 10_000;
const defaultJoinErrorLimit = 3;
const defaultCrashLimit = 2;
const defaultDocRetry: IDocRetry = {
  attempts: 3,
  backoffMs: docRetryBackoffMs,
};
/** Data pushes kept for a subscription id that is not known yet. */
const maxBufferedData = 100;

/**
 * - `pending`: not on the server; pushed on the next join, or after a retry wait.
 * - `subscribing`: a `doc` push is in flight.
 * - `live`: subscribed with `subscriptionId`.
 * - `closing`: every observer left while the `doc` was in flight; the `ok` reply gets an `unsubscribe`.
 */
type EntryState = "pending" | "subscribing" | "live" | "closing";

interface IRegistration {
  readonly sink: ISink;
}

interface IEntry {
  readonly key: string;
  readonly request: IAbsintheRequest;
  readonly registrations: Set<IRegistration>;
  state: EntryState;
  subscriptionId: string | null;
  /** Bumped on every push, so the hooks of an older push do nothing. */
  attempt: number;
  /** Doc timeouts since the last join. */
  timeouts: number;
  /** Channel crashes in a row with this doc in flight. */
  crashes: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

interface IOperation {
  readonly request: IAbsintheRequest;
  readonly sink: ISink;
  sent: boolean;
}

interface IBufferedData {
  readonly subscriptionId: string;
  readonly result: IAbsintheResult;
  readonly receivedAt: number;
}

type Listeners = {
  [TName in keyof ITransportEvents]: Set<ITransportEvents[TName]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphQLErrorsOf(
  reply: unknown,
): ReadonlyArray<IGraphQLFormattedErrorLike> | null {
  if (!isRecord(reply) || !Array.isArray(reply.errors)) return null;
  return reply.errors as ReadonlyArray<IGraphQLFormattedErrorLike>;
}

/** Runs a callback of the app; a throw is reported without breaking the loop it runs in. */
function safely(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/**
 * The protocol state of `absinthe_phoenix` on one socket: the control channel,
 * the subscriptions with their refcounts and ids, and the one-shot operations.
 */
export class Transport implements IAbsintheTransport {
  private currentStatus: TransportStatus = "idle";
  private readonly socket: IPhoenixSocketLike;
  private readonly connectMode: "lazy" | "manual";
  private readonly docTimeoutMs: number;
  private readonly docRetry: IDocRetry;
  private readonly joinErrorLimit: number;
  private readonly crashLimit: number;
  private readonly operationsEnabled: boolean;
  private readonly onDispose: () => void;
  private readonly socketRefs: unknown[];
  private readonly listeners: Listeners = {
    joined: new Set(),
    docLive: new Set(),
    status: new Set(),
    error: new Set(),
  };

  private channel: IPhoenixChannelLike | null = null;
  private joined = false;
  private everJoined = false;
  private disposed = false;
  /** Bumped on every join, drop and dispose: hooks of an older generation do nothing. */
  private generation = 0;
  private joinErrors = 0;
  private channelCloses = 0;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private openedSinceClose: boolean;
  private firstOfGeneration = false;
  /** Set on a join until `joined` fired for it. */
  private joinedPending = false;
  /** Entries of this join whose first answer has not come yet; `joined` fires when it empties. */
  private awaiting = new Set<IEntry>();
  /** Entries that were in flight when the channel crashed: pushed one at a time once nothing else is in flight. */
  private suspects: IEntry[] = [];
  private inFlight = 0;
  private readonly entries = new Map<string, IEntry>();
  private readonly byId = new Map<string, IEntry>();
  private readonly operations = new Set<IOperation>();
  private buffered: IBufferedData[] = [];

  constructor(
    socket: IPhoenixSocketLike,
    options: ITransportOptions,
    onDispose: () => void,
  ) {
    this.socket = socket;
    this.connectMode = options.connect ?? "lazy";
    this.docTimeoutMs =
      options.docTimeoutMs ?? socket.timeout ?? defaultDocTimeoutMs;
    this.docRetry = options.docRetry ?? defaultDocRetry;
    this.joinErrorLimit = options.joinErrorLimit ?? defaultJoinErrorLimit;
    this.crashLimit = options.crashLimit ?? defaultCrashLimit;
    this.operationsEnabled = options.operations === "all";
    this.onDispose = onDispose;
    this.openedSinceClose = socket.isConnected();
    this.socketRefs = [
      socket.onOpen(() => this.socketOpened()),
      socket.onClose(() => this.socketClosed()),
      socket.onMessage((message) => this.received(message as IPhoenixMessage)),
    ];
  }

  get status(): TransportStatus {
    return this.currentStatus;
  }

  subscribe(request: IAbsintheRequest, sink: ISink): () => void {
    if (this.disposed) {
      sink.complete();
      return () => {};
    }
    const key = requestKey(request);
    let entry = this.entries.get(key);
    const isNew = !entry;
    if (!entry) {
      entry = {
        key,
        request,
        registrations: new Set(),
        state: "pending",
        subscriptionId: null,
        attempt: 0,
        timeouts: 0,
        crashes: 0,
        retryTimer: null,
      };
      this.entries.set(key, entry);
    } else if (entry.state === "closing") {
      entry.state = "subscribing";
    }
    const registration: IRegistration = { sink };
    entry.registrations.add(registration);
    const subscribed = entry;
    this.ensureChannel();
    // An existing entry is in flight, live, or waiting for a join, a retry or its turn as a suspect.
    if (isNew && this.joined) this.pushDoc(subscribed);
    return () => this.release(subscribed, registration);
  }

  execute(request: IAbsintheRequest, sink: ISink): () => void {
    if (this.disposed) {
      sink.complete();
      return () => {};
    }
    if (!this.operationsEnabled) {
      const error = new AbsintheSocketError("OPERATION_NOT_ENABLED", {
        request,
      });
      this.emit("error", error);
      sink.error(error);
      return () => {};
    }
    const operation: IOperation = { request, sink, sent: false };
    this.operations.add(operation);
    this.ensureChannel();
    if (this.joined) this.sendOperation(operation);
    return () => {
      this.operations.delete(operation);
    };
  }

  on<TName extends keyof ITransportEvents>(
    name: TName,
    listener: ITransportEvents[TName],
  ): () => void {
    const listeners = this.listeners[name] as Set<ITransportEvents[TName]>;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  activeCount(): number {
    let count = 0;
    for (const entry of this.entries.values())
      if (entry.state !== "closing") count++;
    return count;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.clearRejoinTimer();
    const channel = this.channel;
    this.channel = null;
    this.joined = false;
    channel?.leave();
    const entries = [...this.entries.values()];
    const operations = [...this.operations];
    this.entries.clear();
    this.byId.clear();
    this.operations.clear();
    this.buffered = [];
    this.awaiting.clear();
    this.joinedPending = false;
    this.suspects = [];
    for (const entry of entries) {
      this.clearRetryTimer(entry);
      this.completeAll(entry);
    }
    for (const operation of operations) safely(() => operation.sink.complete());
    const refs = this.socketRefs.filter(
      (ref): ref is string => typeof ref === "string",
    );
    this.socket.off?.(refs);
    this.setStatus("disposed");
    this.onDispose();
  }

  /** Reports a failure that belongs to the socket, not to one document (the managed socket's token reads). */
  reportError(error: AbsintheSocketError): void {
    this.emit("error", error);
  }

  private ensureChannel(): void {
    if (this.channel || this.rejoinTimer) return;
    const channel = this.socket.channel(controlTopic, {});
    this.channel = channel;
    channel.onError(() => {
      if (this.channel !== channel) return;
      // A socket drop errors every channel too; only an error on an open socket is a crash.
      this.channelDown(this.socket.isConnected() ? "crash" : "drop");
    });
    channel.onClose(() => {
      if (this.channel === channel) this.channelClosed();
    });
    // Phoenix runs these hooks again on every rejoin of this channel.
    channel
      .join()
      .receive("ok", () => {
        if (this.channel === channel) this.channelJoined();
      })
      .receive("error", (reply) => {
        if (this.channel === channel) this.joinRejected(reply);
      })
      .receive("timeout", () => {
        if (this.channel === channel)
          this.emit("error", new AbsintheSocketError("JOIN_TIMEOUT"));
      });
    const connected = this.socket.isConnected();
    if (!connected && this.connectMode === "lazy") this.socket.connect();
    this.setStatus(this.socket.isConnected() ? "joining" : this.downStatus());
  }

  private downStatus(): TransportStatus {
    return this.everJoined ? "reconnecting" : "connecting";
  }

  private socketOpened(): void {
    this.openedSinceClose = true;
    if (this.channel && !this.joined) this.setStatus("joining");
  }

  private socketClosed(): void {
    // A close without an open since the last close is a failed connect (also an auth refusal).
    if (!this.openedSinceClose)
      this.emit("error", new AbsintheSocketError("CONNECT_FAILED"));
    this.openedSinceClose = false;
    if (this.channel) this.setStatus(this.downStatus());
  }

  private channelJoined(): void {
    this.joined = true;
    this.joinErrors = 0;
    this.channelCloses = 0;
    this.generation++;
    this.byId.clear();
    this.buffered = [];
    this.inFlight = 0;
    this.firstOfGeneration = !this.everJoined;
    this.everJoined = true;
    this.setStatus("live");
    const fresh: IEntry[] = [];
    const suspects: IEntry[] = [];
    // A drop came before this join, so every entry is pending: none is in flight or closing.
    for (const entry of this.entries.values())
      (entry.crashes > 0 ? suspects : fresh).push(entry);
    this.awaiting = new Set([...fresh, ...suspects]);
    this.joinedPending = true;
    this.suspects = suspects;
    for (const entry of fresh) this.pushDoc(entry);
    // The drop before this join failed every operation that was sent.
    for (const operation of [...this.operations]) this.sendOperation(operation);
    this.pushNextSuspect();
    this.checkJoined();
  }

  private joinRejected(reply: unknown): void {
    this.joinErrors++;
    const error = new AbsintheSocketError("JOIN_REJECTED", { payload: reply });
    this.emit("error", error);
    if (this.joinErrors < this.joinErrorLimit) return;
    // Give up: leave the channel so phoenix stops joining it. The next subscription joins again.
    const channel = this.channel;
    this.channel = null;
    this.joined = false;
    this.joinErrors = 0;
    this.generation++;
    channel?.leave();
    this.failEverything(error);
    this.setStatus("idle");
  }

  private channelClosed(): void {
    // The server closed the channel (phx_close): phoenix forgets it and never joins it again.
    this.channel = null;
    this.channelDown("drop");
    this.channelCloses++;
    if (this.entries.size === 0 && this.operations.size === 0) {
      this.setStatus("idle");
      return;
    }
    this.setStatus(this.downStatus());
    const rejoinAfterMs = this.socket.rejoinAfterMs ?? phoenixRejoinAfterMs;
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      this.ensureChannel();
    }, rejoinAfterMs(this.channelCloses));
  }

  private channelDown(reason: "drop" | "crash"): void {
    this.joined = false;
    this.generation++;
    this.byId.clear();
    this.buffered = [];
    this.awaiting.clear();
    this.joinedPending = false;
    this.suspects = [];
    this.inFlight = 0;
    for (const entry of [...this.entries.values()]) {
      this.clearRetryTimer(entry);
      if (entry.state === "closing") {
        this.entries.delete(entry.key);
        continue;
      }
      if (entry.state === "subscribing" && reason === "crash") {
        entry.crashes++;
        if (entry.crashes >= this.crashLimit) {
          this.entries.delete(entry.key);
          this.fail(entry, "CHANNEL_CRASHED");
          continue;
        }
      }
      this.resetEntry(entry);
    }
    for (const operation of [...this.operations]) {
      if (!operation.sent) continue;
      this.operations.delete(operation);
      const error = new AbsintheSocketError("DISCONNECTED", {
        request: operation.request,
      });
      this.emit("error", error);
      safely(() => operation.sink.error(error));
    }
    if (this.channel) this.setStatus(this.downStatus());
  }

  private resetEntry(entry: IEntry): void {
    entry.state = "pending";
    entry.subscriptionId = null;
    entry.timeouts = 0;
  }

  private pushDoc(entry: IEntry): void {
    const channel = this.channel as IPhoenixChannelLike;
    const attempt = ++entry.attempt;
    const generation = this.generation;
    entry.state = "subscribing";
    this.inFlight++;
    const isCurrent = () =>
      generation === this.generation && attempt === entry.attempt;
    channel
      .push("doc", this.payloadOf(entry.request), this.docTimeoutMs)
      .receive("ok", (reply) => {
        if (isCurrent()) this.docAccepted(entry, reply);
      })
      .receive("error", (reply) => {
        if (isCurrent()) this.docRejected(entry, reply);
      })
      .receive("timeout", () => {
        if (isCurrent()) this.docTimedOut(entry);
      });
  }

  private payloadOf(request: IAbsintheRequest): object {
    return { query: request.query, variables: request.variables };
  }

  private docAccepted(entry: IEntry, reply: unknown): void {
    const subscriptionId = isRecord(reply) ? reply.subscriptionId : undefined;
    if (typeof subscriptionId !== "string") {
      this.removeEntry(entry);
      if (entry.state !== "closing")
        this.fail(entry, "PROTOCOL", { payload: reply });
    } else if (entry.state === "closing") {
      this.removeEntry(entry);
      this.sendUnsubscribe(subscriptionId);
    } else {
      entry.crashes = 0;
      entry.state = "live";
      entry.subscriptionId = subscriptionId;
      this.byId.set(subscriptionId, entry);
      this.emit("docLive", {
        query: entry.request.query,
        variables: entry.request.variables,
        subscriptionId,
      });
      this.replayBuffered(entry, subscriptionId);
    }
    this.answered(entry);
  }

  private docRejected(entry: IEntry, reply: unknown): void {
    this.removeEntry(entry);
    const errors = graphQLErrorsOf(reply);
    if (entry.state === "closing") {
      // Nobody is left to tell.
    } else if (errors) {
      // GraphQL errors stay GraphQL errors: the same array, as a result, so Apollo applies its errorPolicy.
      const result: IAbsintheResult = { errors };
      const registrations = [...entry.registrations];
      entry.registrations.clear();
      for (const registration of registrations) {
        safely(() => registration.sink.next(result));
        safely(() => registration.sink.complete());
      }
    } else {
      this.fail(entry, "PROTOCOL", { payload: reply });
    }
    this.answered(entry);
  }

  private docTimedOut(entry: IEntry): void {
    if (entry.state === "closing") {
      // The id is unknown, so it cannot be unsubscribed; the server drops it with the channel.
      this.removeEntry(entry);
    } else if (entry.timeouts >= this.docRetry.attempts) {
      this.removeEntry(entry);
      this.fail(entry, "DOC_TIMEOUT");
    } else {
      entry.timeouts++;
      entry.state = "pending";
      // The timers are cleared on every join, drop and removal, so this entry is still current when it fires.
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        this.pushDoc(entry);
      }, this.docRetry.backoffMs(entry.timeouts));
    }
    this.answered(entry);
  }

  /** The first answer of a push: counts towards `joined` and lets the next suspect go. */
  private answered(entry: IEntry): void {
    this.inFlight--;
    this.awaiting.delete(entry);
    this.pushNextSuspect();
    this.checkJoined();
  }

  private pushNextSuspect(): void {
    if (this.inFlight > 0) return;
    const suspect = this.suspects.shift();
    if (suspect) this.pushDoc(suspect);
  }

  private checkJoined(): void {
    if (!this.joinedPending || this.awaiting.size > 0) return;
    this.joinedPending = false;
    this.emit("joined", { first: this.firstOfGeneration });
  }

  private release(entry: IEntry, registration: IRegistration): void {
    if (!entry.registrations.delete(registration)) return;
    if (entry.registrations.size > 0) return;
    if (entry.state === "subscribing") {
      entry.state = "closing";
      return;
    }
    this.removeEntry(entry);
    if (entry.state === "live")
      this.sendUnsubscribe(entry.subscriptionId as string);
  }

  private removeEntry(entry: IEntry): void {
    this.entries.delete(entry.key);
    if (entry.subscriptionId !== null) this.byId.delete(entry.subscriptionId);
    this.clearRetryTimer(entry);
    this.suspects = this.suspects.filter((suspect) => suspect !== entry);
    this.awaiting.delete(entry);
    this.checkJoined();
  }

  private sendUnsubscribe(subscriptionId: string): void {
    // Only called for an id of the current join, so the channel is joined.
    const channel = this.channel as IPhoenixChannelLike;
    const failed = (payload?: unknown) =>
      this.emit(
        "error",
        new AbsintheSocketError("UNSUBSCRIBE_FAILED", {
          payload: payload ?? { subscriptionId },
        }),
      );
    channel
      .push("unsubscribe", { subscriptionId }, this.docTimeoutMs)
      .receive("error", (reply) => failed(reply))
      .receive("timeout", () => failed());
  }

  private sendOperation(operation: IOperation): void {
    const channel = this.channel as IPhoenixChannelLike;
    operation.sent = true;
    const settle = () => this.operations.delete(operation);
    channel
      .push("doc", this.payloadOf(operation.request), this.docTimeoutMs)
      .receive("ok", (reply) => {
        if (!settle()) return;
        if (isRecord(reply) && ("data" in reply || "errors" in reply)) {
          safely(() => operation.sink.next(reply as IAbsintheResult));
          safely(() => operation.sink.complete());
          return;
        }
        this.failOperation(operation, "PROTOCOL", reply);
      })
      .receive("error", (reply) => {
        if (!settle()) return;
        const errors = graphQLErrorsOf(reply);
        if (!errors) {
          this.failOperation(operation, "PROTOCOL", reply);
          return;
        }
        const result: IAbsintheResult = { errors };
        safely(() => operation.sink.next(result));
        safely(() => operation.sink.complete());
      })
      .receive("timeout", () => {
        if (settle()) this.failOperation(operation, "DOC_TIMEOUT");
      });
  }

  private failOperation(
    operation: IOperation,
    code: AbsintheSocketErrorCode,
    payload?: unknown,
  ): void {
    const error = new AbsintheSocketError(code, {
      request: operation.request,
      ...(payload === undefined ? {} : { payload }),
    });
    this.emit("error", error);
    safely(() => operation.sink.error(error));
  }

  private received(message: IPhoenixMessage): void {
    if (message.event !== dataEvent) return;
    const payload = isRecord(message.payload) ? message.payload : {};
    const subscriptionId =
      typeof payload.subscriptionId === "string"
        ? payload.subscriptionId
        : message.topic;
    const result = payload.result;
    if (!isRecord(result)) {
      this.emit(
        "error",
        new AbsintheSocketError("PROTOCOL", { payload: message.payload }),
      );
      return;
    }
    const entry = this.byId.get(subscriptionId);
    if (entry) {
      this.deliver(entry, result as IAbsintheResult);
      return;
    }
    // Absinthe subscribes before it replies, so data can beat the `ok` with the id.
    if (this.inFlight > 0) this.buffer(subscriptionId, result);
  }

  private buffer(subscriptionId: string, result: IAbsintheResult): void {
    this.pruneBuffer();
    this.buffered.push({ subscriptionId, result, receivedAt: Date.now() });
    if (this.buffered.length > maxBufferedData) this.buffered.shift();
  }

  private pruneBuffer(): void {
    const oldest = Date.now() - this.docTimeoutMs;
    this.buffered = this.buffered.filter(
      (buffered) => buffered.receivedAt >= oldest,
    );
  }

  private replayBuffered(entry: IEntry, subscriptionId: string): void {
    this.pruneBuffer();
    const matching = this.buffered.filter(
      (buffered) => buffered.subscriptionId === subscriptionId,
    );
    if (matching.length === 0) return;
    this.buffered = this.buffered.filter(
      (buffered) => buffered.subscriptionId !== subscriptionId,
    );
    for (const buffered of matching) this.deliver(entry, buffered.result);
  }

  private deliver(entry: IEntry, result: IAbsintheResult): void {
    for (const registration of [...entry.registrations])
      safely(() => registration.sink.next(result));
  }

  private fail(
    entry: IEntry,
    code: AbsintheSocketErrorCode,
    options: { payload?: unknown } = {},
  ): void {
    const error = new AbsintheSocketError(code, {
      ...options,
      request: entry.request,
    });
    this.emit("error", error);
    const registrations = [...entry.registrations];
    entry.registrations.clear();
    for (const registration of registrations)
      safely(() => registration.sink.error(error));
  }

  private failEverything(error: AbsintheSocketError): void {
    const entries = [...this.entries.values()];
    const operations = [...this.operations];
    this.entries.clear();
    this.byId.clear();
    this.operations.clear();
    this.awaiting.clear();
    this.joinedPending = false;
    this.suspects = [];
    this.inFlight = 0;
    for (const entry of entries) {
      this.clearRetryTimer(entry);
      const registrations = [...entry.registrations];
      entry.registrations.clear();
      for (const registration of registrations)
        safely(() => registration.sink.error(error));
    }
    for (const operation of operations)
      safely(() => operation.sink.error(error));
  }

  private completeAll(entry: IEntry): void {
    const registrations = [...entry.registrations];
    entry.registrations.clear();
    for (const registration of registrations)
      safely(() => registration.sink.complete());
  }

  private clearRetryTimer(entry: IEntry): void {
    if (!entry.retryTimer) return;
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }

  private clearRejoinTimer(): void {
    if (!this.rejoinTimer) return;
    clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
  }

  private setStatus(status: TransportStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.emit("status", status);
  }

  private emit<TName extends keyof ITransportEvents>(
    name: TName,
    ...args: Parameters<ITransportEvents[TName]>
  ): void {
    const listeners = [...this.listeners[name]] as Array<
      (...listenerArgs: Parameters<ITransportEvents[TName]>) => void
    >;
    for (const listener of listeners) safely(() => listener(...args));
  }
}
