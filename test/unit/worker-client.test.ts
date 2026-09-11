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
  liveness = true;
  async revalidate(): Promise<boolean> {
    return this.liveness;
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

function pair(
  options: {
    hub?: ConstructorParameters<typeof WorkerHub>[1];
    page?: { pingIntervalMs?: number };
  } = {},
) {
  const channel = new MessageChannel();
  let client!: FakeHubClient;
  const hub = new WorkerHub(() => {
    client = new FakeHubClient();
    return client;
  }, options.hub);
  hub.attach(channel.port2 as unknown as Parameters<typeof hub.attach>[0]);

  const page = new WorkerWebSocketClient(channel.port1 as MessagePort, config, {
    key: "shared",
    ...options.page,
  });
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

  it("revalidate() 는 워커가 확인한 결과를 그대로 돌려준다", async () => {
    const session = pair();
    const { page, close } = session;
    await page.connect();

    expect(await page.revalidate()).toBe(true);

    session.worker.liveness = false;
    expect(await page.revalidate()).toBe(false);
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

  /**
   * 탭이 얼어 있는 동안 허브가 손잡이를 걷어낼 수 있다(모바일 백그라운드에서 타이머가 멈춘다).
   * 깨어난 페이지는 `stale` 을 받고 스스로 다시 열어야 한다 — 소비자가 들고 있는 구독과
   * 연결 의사가 그대로 살아나는지가 핵심이다.
   */
  it("stale 을 받으면 손잡이와 구독과 연결 의사를 되살린다", async () => {
    let now = 0;
    const session = pair({ hub: { staleAfterMs: 1000, now: () => now } });
    const { page, hub, close } = session;

    await page.connect();
    const received: string[] = [];
    const subscription = page.subscribe("/topic/x").subscribe((m) => received.push(m.body));
    await delay(10);
    expect(hub.connectionCount).toBe(1);

    // 탭이 얼어 ping 이 끊긴다 → 허브가 걷어낸다
    now = 1001;
    hub.sweep();
    await delay(20);

    // 페이지가 깨어나 stale 을 읽고 다시 열었다
    expect(hub.connectionCount).toBe(1);
    expect(page.connectionState).toBe(ConnectionState.OPEN);

    // 되살아난 구독으로 메시지가 흐른다
    session.worker.topic$.next({ body: "돌아왔다", destination: "/topic/x" });
    await delay(10);
    expect(received).toEqual(["돌아왔다"]);

    subscription.unsubscribe();
    page.destroy();
    close();
  });

  it("연결을 원하지 않았다면 되살릴 때 연결하지 않는다", async () => {
    let now = 0;
    const session = pair({ hub: { staleAfterMs: 1000, now: () => now } });
    const { page, hub, close } = session;

    await delay(10); // open 만 하고 connect 는 하지 않는다
    now = 1001;
    hub.sweep();
    await delay(20);

    expect(hub.handleCount).toBe(1);
    expect(session.worker.connects).toBe(0);
    page.destroy();
    close();
  });

  it("ping 이 도는 동안에는 걷어내지 않는다", async () => {
    let now = 0;
    const session = pair({
      hub: { staleAfterMs: 1000, now: () => now },
      page: { pingIntervalMs: 20 },
    });
    const { page, hub, close } = session;

    await page.connect();
    now = 900;
    await delay(60); // ping 이 최소 한 번은 건너간다

    now = 1500; // open 시각으로부터는 넘겼지만 마지막 ping 으로부터는 아니다
    hub.sweep();
    await delay(10);

    expect(hub.handleCount).toBe(1);
    expect(session.worker.disconnects).toBe(0);
    page.destroy();
    close();
  });

  it("destroy() 는 ping 도 멈춘다", async () => {
    let now = 0;
    const session = pair({
      hub: { staleAfterMs: 1000, now: () => now },
      page: { pingIntervalMs: 20 },
    });
    const { page, hub, close } = session;

    await page.connect();
    page.destroy();
    await delay(60);

    expect(hub.handleCount).toBe(0);
    now = 1001;
    hub.sweep();
    expect(hub.handleCount).toBe(0);
    close();
  });
});
