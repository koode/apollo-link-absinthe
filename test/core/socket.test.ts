import { Socket as Socket18 } from "phoenix";
import { Socket as Socket16 } from "phoenix-1.6";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createPhoenixSocket,
  type IManagedPhoenixSocketLike,
  type IManagedSocket,
  type IManagedSocketOptions,
  type SocketToken,
} from "../../src";
import { server, socketUrl } from "../support/control";
import { collectEvents, nextEvent, sleep } from "../support/events";
import {
  Socket,
  SocketWithStringAuthToken,
  WebSocketTransport,
} from "../support/phoenix";
import { privateTickedQuery, tickedQuery } from "../support/queries";
import { record } from "../support/recorder";
import { track } from "../support/sockets";

const socketOptions = {
  transport: WebSocketTransport,
  timeout: 1000,
  rejoinAfterMs: () => 50,
};

function managed(
  options: IManagedSocketOptions<IManagedPhoenixSocketLike> = {},
): IManagedSocket<IManagedPhoenixSocketLike> {
  const created = createPhoenixSocket<IManagedPhoenixSocketLike>(socketUrl(), {
    Socket,
    reconnectAfterMs: () => 50,
    ...options,
    socketOptions: { ...socketOptions, ...options.socketOptions },
  });
  track(created.socket);
  return created;
}

const paramsAuth = { params: (token: string) => ({ token }) };

beforeEach(() => {
  vi.stubGlobal("window", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// authToken needs the phoenix 1.8 client, so these run on it whatever PHOENIX_CLIENT says.
describe("authToken (phoenix 1.8)", () => {
  test("is the default, and keeps the token out of the URL", async () => {
    const { transport } = managed({
      Socket: Socket18,
      auth: { token: () => "user:alice" },
    });
    const recorder = record();
    transport.subscribe(
      { query: privateTickedQuery, variables: {} },
      recorder.sink,
    );
    await nextEvent(transport, "joined");
    await server.publish("private:alice", 1);

    expect(await recorder.waitForResults(1)).toHaveLength(1);
    expect((await server.state()).connects).toEqual([
      { token: "user:alice", via: "auth_token" },
    ]);
  });

  test("a refreshed token is read again on reconnect, and the subscriptions follow it", async () => {
    let token = "user:alice";
    const { transport } = managed({
      Socket: Socket18,
      auth: { token: () => token },
    });
    const recorder = record();
    transport.subscribe(
      { query: privateTickedQuery, variables: {} },
      recorder.sink,
    );
    await nextEvent(transport, "joined");

    token = "user:bob";
    const rejoined = nextEvent(transport, "joined");
    await server.disconnect("alice");
    expect(await rejoined).toEqual({ first: false });
    await server.publish("private:bob", 2);

    expect(await recorder.waitForResults(1)).toEqual([
      { data: { privateTicked: { topic: "private:bob", value: 2 } } },
    ]);
    expect((await server.state()).connects).toEqual([
      { token: "user:alice", via: "auth_token" },
      { token: "user:bob", via: "auth_token" },
    ]);
  });

  test("no token connects without one", async () => {
    const { transport } = managed({
      Socket: Socket18,
      auth: { token: () => null },
    });
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");
    expect((await server.state()).connects).toEqual([
      { token: null, via: "none" },
    ]);
  });

  test("an empty token counts as no token", async () => {
    const { transport } = managed({
      Socket: Socket18,
      auth: { token: () => "" },
    });
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");
    expect((await server.state()).connects).toEqual([
      { token: null, via: "none" },
    ]);
  });

  test("phoenix 1.8.0 to 1.8.8 keep authToken as a string; that works too", async () => {
    const { transport } = managed({
      Socket: SocketWithStringAuthToken,
      auth: { token: () => "user:carol" },
    });
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");
    expect((await server.state()).connects).toEqual([
      { token: "user:carol", via: "auth_token" },
    ]);
  });

  test("refreshAuth with reconnectOnChange reconnects at once when the token changed", async () => {
    let token = "user:alice";
    const { transport, refreshAuth } = managed({
      Socket: Socket18,
      auth: { token: () => token, reconnectOnChange: true },
    });
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");

    await refreshAuth();
    await sleep(100);
    expect((await server.state()).connects).toHaveLength(1);

    token = "user:bob";
    const rejoined = nextEvent(transport, "joined");
    await refreshAuth();
    expect(await rejoined).toEqual({ first: false });
    expect((await server.state()).connects).toEqual([
      { token: "user:alice", via: "auth_token" },
      { token: "user:bob", via: "auth_token" },
    ]);
  });
});

describe("params (every phoenix version)", () => {
  test("the token goes in the params, next to the static params", async () => {
    const { transport } = managed({
      auth: { token: () => "user:dave", send: paramsAuth },
      socketOptions: { params: { client: "test" } },
    });
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");
    expect((await server.state()).connects).toEqual([
      { token: "user:dave", via: "params" },
    ]);
  });

  test("static params may be a function; no token sends only those", async () => {
    const { transport } = managed({
      auth: { token: () => null, send: paramsAuth },
      socketOptions: { params: () => ({ client: "test" }) },
    });
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");
    expect((await server.state()).connects).toEqual([
      { token: null, via: "none" },
    ]);
  });

  test("an async token is awaited before every connect", async () => {
    let token = "user:erin";
    const { transport, socket } = managed({
      auth: {
        token: () => sleep(50).then(() => token),
        send: paramsAuth,
      },
    });
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    socket.connect();
    await nextEvent(transport, "joined");

    token = "user:frank";
    const rejoined = nextEvent(transport, "joined");
    await server.disconnect("erin");
    await rejoined;
    expect((await server.state()).connects).toEqual([
      { token: "user:erin", via: "params" },
      { token: "user:frank", via: "params" },
    ]);
  });

  test("refreshAuth without reconnectOnChange leaves the open connection alone", async () => {
    let token = "user:alice";
    const { transport, refreshAuth } = managed({
      auth: { token: () => token, send: paramsAuth },
    });
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");
    token = "user:bob";
    await refreshAuth();
    await sleep(150);
    expect((await server.state()).connects).toHaveLength(1);
  });

  test("refreshAuth with a new token on a socket that is not connected waits for the next connect", async () => {
    const { socket, refreshAuth } = managed({
      auth: {
        token: () => "user:alice",
        send: paramsAuth,
        reconnectOnChange: true,
      },
    });
    await refreshAuth();
    await sleep(100);
    expect(socket.isConnected()).toBe(false);
  });

  test("refreshAuth on a socket that is not connected waits for the next connect", async () => {
    const { socket, refreshAuth } = managed({
      auth: { token: () => null, send: paramsAuth, reconnectOnChange: true },
    });
    await refreshAuth();
    await sleep(100);
    expect(socket.isConnected()).toBe(false);
    expect((await server.state()).connects).toEqual([]);
  });
});

describe("token failures", () => {
  test("a token read that throws or rejects is a CONNECT_FAILED event, then it is read again", async () => {
    const failure = new Error("token store unavailable");
    const token = vi
      .fn<() => SocketToken | Promise<SocketToken>>()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockImplementationOnce(() => Promise.reject(failure))
      .mockReturnValue("user:alice");
    const { transport } = managed({ auth: { token, send: paramsAuth } });
    const errors = collectEvents(transport, "error");
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");

    expect(errors).toEqual([
      expect.objectContaining({ code: "CONNECT_FAILED", cause: failure }),
      expect.objectContaining({ code: "CONNECT_FAILED", cause: failure }),
    ]);
    expect(token).toHaveBeenCalledTimes(3);
  });

  test("a token that arrives after a disconnect does not connect", async () => {
    const reads: {
      resolve: (token: string) => void;
      reject: (error: Error) => void;
    }[] = [];
    const { socket } = managed({
      auth: {
        token: () =>
          new Promise<string>((resolve, reject) => {
            reads.push({ resolve, reject });
          }),
        send: paramsAuth,
      },
    });
    socket.connect();
    socket.connect();
    socket.disconnect();
    reads.at(-1)?.resolve("user:alice");

    socket.connect();
    socket.disconnect();
    reads.at(-1)?.reject(new Error("too late"));
    await sleep(150);
    expect(socket.isConnected()).toBe(false);
    expect((await server.state()).connects).toEqual([]);
  });

  test("a connect during the wait after a failed read waits for that retry", async () => {
    const token = vi
      .fn<() => SocketToken>()
      .mockImplementationOnce(() => {
        throw new Error("not yet");
      })
      .mockReturnValue("user:alice");
    const { socket, transport } = managed({
      reconnectAfterMs: () => 100,
      auth: { token, send: paramsAuth },
    });
    socket.connect();
    socket.connect();
    expect(token).toHaveBeenCalledTimes(1);
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");
    expect(token).toHaveBeenCalledTimes(2);
  });

  test("a disconnect during the wait after a failed read cancels the retry", async () => {
    let calls = 0;
    const { socket } = managed({
      reconnectAfterMs: () => 50,
      auth: {
        token: () => {
          calls++;
          throw new Error("signed out");
        },
        send: paramsAuth,
      },
    });
    socket.connect();
    socket.disconnect();
    await sleep(150);
    expect(calls).toBe(1);
    expect(socket.isConnected()).toBe(false);
  });
});

describe("the managed socket", () => {
  test("without auth it connects as phoenix does", async () => {
    const { transport } = managed();
    transport.subscribe({ query: tickedQuery, variables: {} }, record().sink);
    await nextEvent(transport, "joined");
    expect((await server.state()).connects).toEqual([
      { token: null, via: "none" },
    ]);
  });

  test("uses the phoenix Socket class by default", async () => {
    const created = createPhoenixSocket(socketUrl(), { socketOptions });
    track(created.socket);
    created.transport.subscribe(
      { query: tickedQuery, variables: {} },
      record().sink,
    );
    await nextEvent(created.transport, "joined");
    expect(created.socket).toBeInstanceOf(Socket18);
  });

  test("close completes the observers, disconnects, and stays closed", async () => {
    const { socket, transport, close, refreshAuth } = managed({
      auth: {
        token: () => "user:alice",
        send: paramsAuth,
        reconnectOnChange: true,
      },
    });
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    await nextEvent(transport, "joined");

    close();
    close();
    expect(recorder.events).toEqual([{ type: "complete" }]);
    expect(transport.status).toBe("disposed");
    socket.connect();
    await refreshAuth();
    await sleep(150);
    expect(socket.isConnected()).toBe(false);
  });

  test("authToken with a phoenix client older than 1.8 throws", () => {
    expect(() =>
      createPhoenixSocket(socketUrl(), {
        Socket: Socket16,
        socketOptions,
        auth: { token: () => "user:alice" },
      }),
    ).toThrow(/needs the phoenix client 1.8/u);
  });

  test("on the server it builds no socket: the transport is disposed and completes at once", async () => {
    vi.stubGlobal("window", undefined);
    const SocketClass = vi.fn<() => void>();
    const { socket, transport, refreshAuth, close } = createPhoenixSocket(
      socketUrl(),
      {
        Socket: SocketClass as unknown as typeof Socket,
        auth: { token: () => "user:alice" },
      },
    );
    expect(SocketClass).not.toHaveBeenCalled();
    expect(transport.status).toBe("disposed");
    const recorder = record();
    transport.subscribe({ query: tickedQuery, variables: {} }, recorder.sink);
    expect(recorder.events).toEqual([{ type: "complete" }]);

    const channel = socket.channel("presence:1");
    channel
      .join()
      .receive("ok", () => {})
      .receive("error", () => {});
    channel.push("event", {});
    channel.leave();
    channel.onError(() => {});
    channel.onClose(() => {});
    socket.onOpen(() => {});
    socket.onClose(() => {});
    socket.onError(() => {});
    socket.onMessage(() => {});
    socket.connect();
    const disconnected = vi.fn<() => void>();
    socket.disconnect(disconnected);
    socket.disconnect();
    expect(disconnected).toHaveBeenCalled();
    expect(socket.isConnected()).toBe(false);
    await refreshAuth();
    close();
  });
});
