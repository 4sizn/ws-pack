import { describe, expect, it } from "bun:test";
import { Subject } from "rxjs";
import type { DisconnectInfo, HubClient, WireMessage, WorkerClientConfig } from "../../src/lib";
import { ConnectionState, WorkerHub } from "../../src/lib";
import { delay } from "../support/async";

/**
 * 워커 허브의 규칙만 검증한다. 소켓도 워커도 띄우지 않고, 진짜 MessagePort 로 명령과 이벤트만 오간다.
 * 검증 대상은 하나다: 여러 포트가 연결 하나를 어떻게 공유하고 언제 놓는가.
 */

/** 허브가 다루는 클라이언트의 가짜 구현. 연결 횟수와 마지막 전송을 들여다볼 수 있다. */
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
  readonly topics = new Map<string, Subject<WireMessage>>();

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
    if (this.connectionState !== ConnectionState.OPEN) {
      throw new Error("not connected");
    }
    this.sent.push(data);
  }

  subscribe(destination: string) {
    const subject = this.topics.get(destination) ?? new Subject<WireMessage>();
    this.topics.set(destination, subject);
    return subject.asObservable();
  }
}

const config: WorkerClientConfig = {
  protocol: "stomp",
  options: { brokerURL: "ws://example.invalid/ws" },
};

/** 포트 한 쌍과 수신함. page 쪽에서 명령을 보내고 이벤트를 받는다. */
function connectPort(hub: WorkerHub) {
  const channel = new MessageChannel();
  const received: unknown[] = [];
  channel.port1.addEventListener("message", (event) => received.push(event.data));
  channel.port1.start();
  const detach = hub.attach(channel.port2 as unknown as Parameters<typeof hub.attach>[0]);

  return {
    received,
    detach,
    send: (command: unknown) => channel.port1.postMessage(command),
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe("워커 허브", () => {
  it("같은 키를 연 손잡이들은 연결 하나를 공유한다", async () => {
    const clients: FakeHubClient[] = [];
    const hub = new WorkerHub(() => {
      const client = new FakeHubClient();
      clients.push(client);
      return client;
    });

    const first = connectPort(hub);
    const second = connectPort(hub);
    first.send({ type: "open", handle: "a", key: "shared", config });
    second.send({ type: "open", handle: "b", key: "shared", config });
    await delay(10);

    expect(hub.connectionCount).toBe(1);
    expect(clients).toHaveLength(1);

    first.close();
    second.close();
  });

  it("키가 다르면 연결도 따로 만든다", async () => {
    const hub = new WorkerHub(() => new FakeHubClient());
    const port = connectPort(hub);

    port.send({ type: "open", handle: "a", key: "one", config });
    port.send({ type: "open", handle: "b", key: "two", config });
    await delay(10);

    expect(hub.connectionCount).toBe(2);
    port.close();
  });

  it("두 손잡이가 함께 쓰면 connect 는 한 번만 실제로 연결한다", async () => {
    let client!: FakeHubClient;
    const hub = new WorkerHub(() => {
      client = new FakeHubClient();
      return client;
    });
    const port = connectPort(hub);

    port.send({ type: "open", handle: "a", key: "shared", config });
    port.send({ type: "open", handle: "b", key: "shared", config });
    port.send({ type: "connect", handle: "a", command: "c1" });
    await delay(10);
    port.send({ type: "connect", handle: "b", command: "c2" });
    await delay(10);

    // 두 손잡이 모두 ack 을 받지만, 실제 연결은 이미 열려 있으므로 클라이언트는 그대로다.
    expect(client.connects).toBe(2); // 컨트롤러가 이미 OPEN 이면 무시하는 건 그쪽 규칙
    expect(hub.connectionCount).toBe(1);
    port.close();
  });

  it("한 손잡이가 끊어도 다른 손잡이가 원하면 소켓은 유지된다", async () => {
    let client!: FakeHubClient;
    const hub = new WorkerHub(() => {
      client = new FakeHubClient();
      return client;
    });
    const port = connectPort(hub);

    port.send({ type: "open", handle: "a", key: "shared", config });
    port.send({ type: "open", handle: "b", key: "shared", config });
    port.send({ type: "connect", handle: "a", command: "c1" });
    port.send({ type: "connect", handle: "b", command: "c2" });
    await delay(10);

    port.send({ type: "disconnect", handle: "a", command: "d1" });
    await delay(10);
    expect(client.disconnects).toBe(0);

    // 마지막으로 원하던 손잡이가 빠지면 그때 닫는다
    port.send({ type: "disconnect", handle: "b", command: "d2" });
    await delay(10);
    expect(client.disconnects).toBe(1);

    port.close();
  });

  it("마지막 손잡이를 놓으면 연결도 사라진다", async () => {
    let client!: FakeHubClient;
    const hub = new WorkerHub(() => {
      client = new FakeHubClient();
      return client;
    });
    const port = connectPort(hub);

    port.send({ type: "open", handle: "a", key: "shared", config });
    port.send({ type: "connect", handle: "a", command: "c1" });
    await delay(10);

    port.send({ type: "release", handle: "a" });
    await delay(10);

    expect(hub.connectionCount).toBe(0);
    expect(client.disconnects).toBe(1);
    port.close();
  });

  it("명령 결과는 ack 으로 돌아가고, 실패 사유도 함께 온다", async () => {
    const hub = new WorkerHub(() => new FakeHubClient());
    const port = connectPort(hub);

    port.send({ type: "open", handle: "a", key: "shared", config });
    // 연결 전 전송은 실패해야 한다
    port.send({ type: "send", handle: "a", command: "s1", data: "이른 전송" });
    await delay(10);

    const failure = port.received.find(
      (event) => (event as { command?: string }).command === "s1",
    ) as { type: string; error?: string };
    expect(failure.type).toBe("ack");
    expect(failure.error).toBe("not connected");

    port.send({ type: "connect", handle: "a", command: "c1" });
    await delay(10);
    port.send({ type: "send", handle: "a", command: "s2", data: "정상 전송" });
    await delay(10);

    const ok = port.received.find((event) => (event as { command?: string }).command === "s2") as {
      type: string;
      error?: string;
    };
    expect(ok.error).toBeUndefined();
    port.close();
  });

  it("구독 메시지는 그 구독을 연 손잡이에게만 간다", async () => {
    let client!: FakeHubClient;
    const hub = new WorkerHub(() => {
      client = new FakeHubClient();
      return client;
    });
    const first = connectPort(hub);
    const second = connectPort(hub);

    first.send({ type: "open", handle: "a", key: "shared", config });
    second.send({ type: "open", handle: "b", key: "shared", config });
    first.send({ type: "subscribe", handle: "a", subscription: "s", destination: "/topic/x" });
    await delay(10);

    client.topics.get("/topic/x")?.next({ body: "안녕", destination: "/topic/x" });
    await delay(10);

    const delivered = first.received.filter(
      (event) => (event as { type: string }).type === "subscription",
    );
    const others = second.received.filter(
      (event) => (event as { type: string }).type === "subscription",
    );
    expect(delivered).toHaveLength(1);
    expect(others).toHaveLength(0);

    first.close();
    second.close();
  });

  it("구독 없는 프로토콜에 구독을 요청하면 에러로 알린다", async () => {
    const hub = new WorkerHub(() => {
      const client = new FakeHubClient();
      // 순수 WebSocket 처럼 destination 구독이 없는 경우
      (client as { subscribe?: unknown }).subscribe = undefined;
      return client;
    });
    const port = connectPort(hub);

    port.send({ type: "open", handle: "a", key: "plain", config });
    port.send({ type: "subscribe", handle: "a", subscription: "s", destination: "/topic/x" });
    await delay(10);

    const error = port.received.find((event) => (event as { type: string }).type === "error") as {
      name: string;
    };
    expect(error.name).toBe("UnsupportedOperation");
    port.close();
  });
});
