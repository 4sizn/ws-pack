import { map, type Observable } from "rxjs";
import type { ConnectionState } from "../../src/lib";
import { ReconnectTimeMode, WindowWebSocketClient } from "../../src/lib";
import { MqttWebSocketClient } from "../../src/lib/mqtt";
import { StompWebSocketClient } from "../../src/lib/stomp";
import { TestEchoServer } from "./echo-server";
import { TestMqttBroker } from "./mqtt-broker";
import { TestStompBroker } from "./stomp-broker";

/**
 * 프로토콜 무관 채팅 계약.
 *
 * 데모와 같은 단위로 맞춘다: **참가자 하나 = 클라이언트 인스턴스 하나 = 방 하나.**
 * 이 단위여야 destination 개념이 없는 순수 WebSocket(window) 과 pub/sub 인 STOMP/MQTT 가
 * 같은 시나리오를 만족할 수 있다. 시나리오는 프로토콜을 모르고, 드라이버만 프로토콜을 안다.
 */

/** 테스트가 조작할 수 있는 서버 쪽 손잡이. 고장을 만들 수 있어야 계약을 검증할 수 있다. */
export interface ChatBackend {
  /** 살아 있는 클라이언트 연결 수. 소켓 누수 판정 기준. */
  readonly connectionCount: number;
  /**
   * 서버가 인지한 수신 대기자 수(최소 보장값). 보내기 전에 이 값이 기대치에 도달하길 기다린다 —
   * 구독 등록과 발행은 서로 다른 연결에서 일어나므로 도착 순서가 보장되지 않는다.
   * destination 개념이 없는 프로토콜에서는 연결 수와 같다.
   */
  readonly subscriptionCount: number;
  /** 종료 핸드셰이크 없이 모든 연결을 끊는다 (비정상 종료 재현). */
  killConnections(): void;
  /** 들어오는 요청에 일절 응답하지 않는다 (브로커 무응답 재현). */
  mute(): void;
  /** 다시 응답하게 되돌린다. */
  unmute(): void;
  stop(): Promise<void>;
}

/** 채팅 참가자. 방 하나에 붙어서 듣고 말한다. */
export interface ChatMember {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** 이 방의 메시지 본문 스트림. 연결 전에 불러도 되고, 재연결되면 다시 걸려야 한다. */
  listen(): Observable<string>;
  say(text: string): void;
  /** 연결이 정말 살아 있는지 왕복으로 확인한다. */
  revalidate(timeoutMs?: number): Promise<boolean>;
  readonly state: ConnectionState;
  readonly stateChanges$: Observable<ConnectionState>;
}

export interface ChatDriver {
  readonly name: string;
  /** 어댑터가 아직 없으면 false. 시나리오는 그대로 두고 skip 된다. */
  readonly available: boolean;
  /** 미구현 사유 (skip 사유로 출력) */
  readonly pendingReason?: string;
  start(): Promise<ChatBackend>;
  member(backend: ChatBackend, room: string): ChatMember;
}

/**
 * 테스트용 재연결 정책: 짧고 고정 간격, 지터 없음.
 * 백오프 계산과 지터는 별도 단위 테스트 몫이라 여기선 대기 시간이 흔들리지 않아야 한다.
 */
const reconnect = {
  maxAttempts: 3,
  delay: 50,
  timeMode: ReconnectTimeMode.INTERVAL,
  maxDelay: 50,
  jitter: false,
};

interface StompBackend extends ChatBackend {
  readonly url: string;
}

export const stompDriver: ChatDriver = {
  name: "stomp",
  available: true,

  async start(): Promise<ChatBackend> {
    const broker = new TestStompBroker();
    await broker.start();
    const backend: StompBackend = {
      url: broker.url,
      get connectionCount() {
        return broker.connectionCount;
      },
      get subscriptionCount() {
        return broker.subscriptionCount;
      },
      killConnections: () => broker.killConnections(),
      mute: () => broker.mute(),
      unmute: () => broker.unmute(),
      stop: () => broker.stop(),
    };
    return backend;
  },

  member(backend: ChatBackend, room: string): ChatMember {
    const { url } = backend as StompBackend;
    const destination = `/topic/${room}`;
    const client = new StompWebSocketClient({
      brokerURL: url,
      reconnect,
      // 왕복 확인용 destination. 아무도 구독하지 않는 이름이면 된다.
      revalidateDestination: `/topic/${room}.revalidate`,
    });

    return {
      connect: () => client.connect(),
      disconnect: () => client.disconnect(),
      listen: () => client.subscribe(destination).pipe(map((message) => message.body)),
      say: (text) => client.send(text, { destination }),
      revalidate: (timeoutMs) => client.revalidate(timeoutMs),
      get state() {
        return client.connectionState;
      },
      stateChanges$: client.connectionChanges$,
    };
  },
};

interface WindowBackend extends ChatBackend {
  readonly url: string;
}

/**
 * 순수 WebSocket 모드. destination 이 없으므로 방은 접속 URL 로 정하고, 서버가 같은 방
 * 참가자에게 되뿌린다. 참가자 하나가 연결 하나라서 구독 수는 곧 연결 수다.
 */
export const windowDriver: ChatDriver = {
  name: "window",
  available: true,

  async start(): Promise<ChatBackend> {
    const server = new TestEchoServer();
    await server.start();
    const backend: WindowBackend = {
      url: server.url,
      get connectionCount() {
        return server.connectionCount;
      },
      // 이 프로토콜에는 구독이라는 단계가 없다. 연결되면 곧 수신 대기 상태다.
      get subscriptionCount() {
        return server.connectionCount;
      },
      killConnections: () => server.killConnections(),
      mute: () => server.mute(),
      unmute: () => server.unmute(),
      stop: () => server.stop(),
    };
    return backend;
  },

  member(backend: ChatBackend, room: string): ChatMember {
    const { url } = backend as WindowBackend;
    const client = new WindowWebSocketClient({
      url: `${url}/?room=${encodeURIComponent(room)}`,
      reconnect,
      // 순수 WebSocket 은 프로토콜 ping 이 없다. 에코 서버가 그대로 돌려주므로 ping 이 곧 응답이다.
      heartbeat: { intervalMs: 60_000, timeoutMs: 500, ping: "__ws-client-pack-ping__" },
    });

    return {
      connect: () => client.connect(),
      disconnect: () => client.disconnect(),
      listen: () => client.message$,
      say: (text) => client.send(text),
      revalidate: (timeoutMs) => client.revalidate(timeoutMs),
      get state() {
        return client.connectionState;
      },
      stateChanges$: client.connectionChanges$,
    };
  },
};

interface MqttBackend extends ChatBackend {
  readonly url: string;
}

/** MQTT 모드. topic 이 곧 방이라 STOMP 와 같은 형태가 된다. */
export const mqttDriver: ChatDriver = {
  name: "mqtt",
  available: true,

  async start(): Promise<ChatBackend> {
    const broker = new TestMqttBroker();
    await broker.start();
    const backend: MqttBackend = {
      url: broker.url,
      get connectionCount() {
        return broker.connectionCount;
      },
      get subscriptionCount() {
        return broker.subscriptionCount;
      },
      killConnections: () => broker.killConnections(),
      mute: () => broker.mute(),
      unmute: () => broker.unmute(),
      stop: () => broker.stop(),
    };
    return backend;
  },

  member(backend: ChatBackend, room: string): ChatMember {
    const { url } = backend as MqttBackend;
    const topic = `chat/${room}`;
    const client = new MqttWebSocketClient({ brokerURL: url, reconnect });

    return {
      connect: () => client.connect(),
      disconnect: () => client.disconnect(),
      listen: () => client.subscribe(topic).pipe(map((message) => message.body)),
      say: (text) => client.send(text, { topic }),
      revalidate: (timeoutMs) => client.revalidate(timeoutMs),
      get state() {
        return client.connectionState;
      },
      stateChanges$: client.connectionChanges$,
    };
  },
};

export const drivers: ChatDriver[] = [stompDriver, windowDriver, mqttDriver];
