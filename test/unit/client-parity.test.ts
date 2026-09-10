import { describe, expect, it } from "bun:test";
import { Subject } from "rxjs";
import type {
  DisconnectInfo,
  HubClient,
  NetworkClient,
  WireMessage,
  WorkerClientConfig,
} from "../../src/lib";
import { ConnectionState, WebSocketClient, WorkerHub, WorkerWebSocketClient } from "../../src/lib";
import { delay } from "../support/async";
import { FakeAdapter, FakeController } from "../support/fake-adapter";

/**
 * 직접 연결과 워커 경유는 상태 머신을 서로 다른 곳에 두지만, 소비자가 보는 표면은 같아야 한다.
 * 그 "같음" 을 타입(NetworkClient)과 동작 양쪽에서 확인한다.
 */

class FakeHubClient implements HubClient {
  readonly sent: string[] = [];
  connectionState = ConnectionState.IDLE;
  readonly connectionChanges$ = new Subject<ConnectionState>();
  readonly connect$ = new Subject<void>();
  readonly disconnect$ = new Subject<DisconnectInfo>();
  readonly error$ = new Subject<Error>();
  readonly message$ = new Subject<WireMessage>();
  readonly reconnectAttempt$ = new Subject<{
    attempts: number;
    maxAttempts: number;
    isReconnecting: boolean;
  }>();
  readonly maxReconnectReached$ = new Subject<void>();

  async connect(): Promise<void> {
    this.connectionState = ConnectionState.OPEN;
    this.connectionChanges$.next(ConnectionState.OPEN);
    this.connect$.next();
  }
  async disconnect(): Promise<void> {
    this.connectionState = ConnectionState.IDLE;
    this.connectionChanges$.next(ConnectionState.IDLE);
  }
  liveness = true;
  async revalidate(): Promise<boolean> {
    return this.liveness;
  }

  send(data: string): void {
    if (this.connectionState !== ConnectionState.OPEN) throw new Error("not connected");
    this.sent.push(data);
  }
}

const config: WorkerClientConfig = {
  protocol: "window",
  options: { url: "ws://example.invalid" },
};

/**
 * 두 구현에 똑같이 쓰는 소비자 코드. 인터페이스만 보고 짜여 있고,
 * send 가 즉시 끝나든(직접) 왕복하든(워커) `await` 로 같은 모양이 된다.
 */
async function openAndSay(
  client: NetworkClient<unknown, undefined> | NetworkClient<unknown, unknown>,
  text: string,
): Promise<ConnectionState> {
  await client.connect();
  await (client as { send(data: string, options?: unknown): void | Promise<void> }).send(text);
  return client.connectionState;
}

describe("클라이언트 표면 일치", () => {
  it("직접 연결 클라이언트는 NetworkClient 로 쓸 수 있다", async () => {
    const adapter = new FakeAdapter();
    const direct: NetworkClient<string> = new WebSocketClient(new FakeController(adapter));

    expect(await openAndSay(direct, "직접")).toBe(ConnectionState.OPEN);
    expect(adapter.sent).toEqual(["직접"]);
  });

  it("워커 경유 클라이언트도 같은 코드로 쓸 수 있다", async () => {
    const channel = new MessageChannel();
    let worker!: FakeHubClient;
    const hub = new WorkerHub(() => {
      worker = new FakeHubClient();
      return worker;
    });
    hub.attach(channel.port2 as unknown as Parameters<typeof hub.attach>[0]);

    const remote: NetworkClient<WireMessage, unknown> = new WorkerWebSocketClient(
      channel.port1 as MessagePort,
      config,
    );

    expect(await openAndSay(remote, "워커")).toBe(ConnectionState.OPEN);
    await delay(10);
    expect(worker.sent).toEqual(["워커"]);

    channel.port1.close();
    channel.port2.close();
  });

  it("실패를 알리는 방식만 다르다 — 직접은 throw, 워커는 reject", async () => {
    const adapter = new FakeAdapter();
    const direct = new WebSocketClient(new FakeController(adapter));
    expect(() => direct.send("연결 전")).toThrow();

    const channel = new MessageChannel();
    const hub = new WorkerHub(() => new FakeHubClient());
    hub.attach(channel.port2 as unknown as Parameters<typeof hub.attach>[0]);
    const remote = new WorkerWebSocketClient(channel.port1 as MessagePort, config);

    await expect(remote.send("연결 전")).rejects.toThrow("not connected");

    channel.port1.close();
    channel.port2.close();
  });
});
