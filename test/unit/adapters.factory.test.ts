import { afterEach, describe, expect, it } from "bun:test";
import { ConnectionState, ReconnectTimeMode, WindowWebSocketClient } from "../../src/lib";

/** WindowAdapter 의 팩토리 해석이 시도마다 일어나는지 확인한다. */

type SocketEvent = (event: { code?: number; reason?: string; wasClean?: boolean }) => void;

class FakeWebSocket {
  static instances: string[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  private listeners = new Map<string, Set<SocketEvent>>();
  public onopen: (() => void) | null = null;
  public onerror: ((error: Error) => void) | null = null;
  public onclose: SocketEvent | null = null;
  private closeReason: { code?: number; reason?: string } | null = null;

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(url);

    queueMicrotask(() => {
      if (url.includes("expired")) {
        this.onerror?.(new Error("token expired"));
        this.closeReason = { code: 4001, reason: "token expired" };
        this.dispatch("close", this.closeReason);
        return;
      }

      this.readyState = FakeWebSocket.OPEN;
      this.dispatch("open");
    });
  }

  addEventListener(type: string, callback: SocketEvent): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, callback: SocketEvent): void {
    this.listeners.get(type)?.delete(callback);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closeReason = { code: 1000, reason: "closed" };
    this.dispatch("close", this.closeReason);
  }

  send(_data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
  }

  private dispatch(
    type: string,
    event: { code?: number; reason?: string; wasClean?: boolean } = {},
  ): void {
    const cb = (this as unknown as Record<string, (() => void) | SocketEvent | null>)[`on${type}`];
    if (typeof cb === "function") {
      if (type === "open") {
        cb.call(this);
      } else {
        (cb as SocketEvent)(event);
      }
    }

    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

let originalWebSocket: typeof WebSocket | undefined;

afterEach(() => {
  if (originalWebSocket) {
    globalThis.WebSocket = originalWebSocket;
  }
  FakeWebSocket.reset();
});

describe("Window WebSocket URL 팩토리", () => {
  it("연결 재시도마다 URL 팩토리를 다시 호출한다", async () => {
    originalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
      FakeWebSocket as unknown as typeof WebSocket;

    const tokens = ["expired", "fresh"];
    let call = 0;
    const client = new WindowWebSocketClient({
      url: () => `ws://example/ws?token=${tokens[Math.min(call++, 1)]}`,
      reconnect: {
        maxAttempts: 1,
        delay: 0,
        timeMode: ReconnectTimeMode.INTERVAL,
        maxDelay: 0,
        jitter: false,
      },
    });

    await client.connect();

    expect(FakeWebSocket.instances).toEqual([
      "ws://example/ws?token=expired",
      "ws://example/ws?token=fresh",
    ]);
    expect(client.connectionState).toBe(ConnectionState.OPEN);

    client.destroy();
  });

  it("URL 팩토리 실패를 error$와 함께 실패로 본다", async () => {
    const client = new WindowWebSocketClient({
      url: async () => {
        throw new Error("token request failed");
      },
      reconnect: {
        maxAttempts: 0,
        delay: 0,
        timeMode: ReconnectTimeMode.INTERVAL,
        maxDelay: 0,
      },
    });
    const failures: Error[] = [];
    const subscription = client.error$.subscribe((error) => failures.push(error));

    let finalError: Error | undefined;
    try {
      await client.connect();
    } catch (error) {
      finalError = error as Error;
    }

    expect(finalError).toBeInstanceOf(Error);
    const error = finalError as Error;
    expect(error.message).toContain("Maximum reconnection attempts");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe("token request failed");
    expect(failures.some((e) => e.message === "token request failed")).toBe(true);

    subscription.unsubscribe();
  });

  it("비동기 URL 팩토리가 성공하면 연결한다", async () => {
    originalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
      FakeWebSocket as unknown as typeof WebSocket;

    const client = new WindowWebSocketClient({
      url: async () => "ws://example/ws?token=async",
      reconnect: { maxAttempts: 0, delay: 0, timeMode: ReconnectTimeMode.INTERVAL, maxDelay: 0 },
    });

    await client.connect();

    expect(FakeWebSocket.instances).toEqual(["ws://example/ws?token=async"]);
    expect(client.connectionState).toBe(ConnectionState.OPEN);

    client.destroy();
  });

  it("URL 팩토리 실패 후 재시도 딜레이를 거쳐 다시 호출한다", async () => {
    originalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
      FakeWebSocket as unknown as typeof WebSocket;

    const tokens = ["expired", "fresh"];
    let call = 0;
    const client = new WindowWebSocketClient({
      url: () => `ws://example/ws?token=${tokens[Math.min(call++, 1)]}`,
      reconnect: {
        maxAttempts: 1,
        delay: 10,
        timeMode: ReconnectTimeMode.INTERVAL,
        maxDelay: 10,
        jitter: false,
      },
    });

    await client.connect();

    expect(FakeWebSocket.instances).toEqual([
      "ws://example/ws?token=expired",
      "ws://example/ws?token=fresh",
    ]);
    expect(client.connectionState).toBe(ConnectionState.OPEN);

    client.destroy();
  });
});
