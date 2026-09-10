import { describe, expect, it } from "bun:test";
import { firstValueFrom, Subject } from "rxjs";
import type { DisconnectInfo, HubClient, WireMessage, WorkerClientConfig } from "../../src/lib";
import { ConnectionState, WorkerHub, WorkerWebSocketClient } from "../../src/lib";
import { delay } from "../support/async";

/**
 * 페이지 쪽 손잡이(WorkerWebSocketClient)와 워커 쪽 허브를 진짜 MessagePort 로 이어서
 * 왕복을 검증한다. 워커를 띄우지 않는 이유는 포트 양끝의 계약이 시험 대상이지
 * 워커 생성 방식이 아니기 때문이다 — 그건 소비자가 정한다.
 */

class FakeHubClient implements HubClient {
  connects = 0;
  disconnects = 0;
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
  readonly topic$ = new Subject<WireMessage>();

  async connect(): Promise<void> {
    this.connects += 1;
    this.connectionState = ConnectionState.OPEN;
    this.connectionChanges$.next(ConnectionState.OPEN);
    this.connect$.next();
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.connectionState = ConnectionState.IDLE;
    this.connectionChanges$.next(ConnectionState.IDLE);
  }
  send(data: string): void {
    if (this.connectionState !== ConnectionState.OPEN) throw new Error("not connected");
    this.sent.push(data);
  }
  subscribe() {
    return this.topic$.asObservable();
  }
}

const config: WorkerClientConfig = {
  protocol: "stomp",
  options: { brokerURL: "ws://example.invalid/ws" },
};

function pair() {
  const channel = new MessageChannel();
  let client!: FakeHubClient;
  const hub = new WorkerHub(() => {
    client = new FakeHubClient();
    return client;
  });
  hub.attach(channel.port2 as unknown as Parameters<typeof hub.attach>[0]);

  const page = new WorkerWebSocketClient(channel.port1 as MessagePort, config, { key: "shared" });
  return {
    page,
    hub,
    get worker() {
      return client;
    },
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe("워커 클라이언트 왕복", () => {
  it("connect() 는 워커의 연결이 끝난 뒤에 resolve 한다", async () => {
    const session = pair();
    const { page, close } = session;

    await page.connect();

    expect(session.worker.connects).toBe(1);
    expect(page.connectionState).toBe(ConnectionState.OPEN);
    close();
  });

  it("상태와 연결 이벤트가 페이지 스트림으로 흘러온다", async () => {
    const { page, close } = pair();
    const state = firstValueFrom(page.connectionChanges$);
    const opened = firstValueFrom(page.connect$);

    await page.connect();

    expect(await state).toBe(ConnectionState.OPEN);
    await opened;
    close();
  });

  it("send() 는 워커까지 갔다 오고, 실패는 reject 로 온다", async () => {
    const session = pair();
    const { page, close } = session;

    await expect(page.send("연결 전")).rejects.toThrow("not connected");

    await page.connect();
    await page.send("연결 후");
    expect(session.worker.sent).toEqual(["연결 후"]);
    close();
  });

  it("subscribe() 로 받은 메시지가 그 구독으로만 흘러온다", async () => {
    const session = pair();
    const { page, close } = session;
    await page.connect();

    const received: WireMessage[] = [];
    const subscription = page.subscribe("/topic/x").subscribe((message) => received.push(message));
    await delay(10);

    session.worker.topic$.next({ body: "안녕", destination: "/topic/x" });
    await delay(10);

    expect(received).toEqual([{ body: "안녕", destination: "/topic/x" }]);

    subscription.unsubscribe();
    await delay(10);
    session.worker.topic$.next({ body: "해제 후", destination: "/topic/x" });
    await delay(10);
    expect(received).toHaveLength(1);
    close();
  });

  it("워커 쪽 에러는 이름을 유지한 채 error$ 로 온다", async () => {
    const session = pair();
    const { page, close } = session;
    await page.connect();

    const failed = firstValueFrom(page.error$);
    const original = new Error("소켓 오류");
    original.name = "StompWebsocketError";
    session.worker.error$.next(original);

    const received = await failed;
    expect(received.name).toBe("StompWebsocketError");
    expect(received.message).toBe("소켓 오류");
    close();
  });

  it("destroy() 하면 워커의 연결도 정리된다", async () => {
    const session = pair();
    const { page, hub, close } = session;
    await page.connect();
    expect(hub.connectionCount).toBe(1);

    page.destroy();
    await delay(10);

    expect(hub.connectionCount).toBe(0);
    expect(session.worker.disconnects).toBe(1);
    close();
  });
});
