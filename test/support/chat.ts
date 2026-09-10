import { map, type Observable } from "rxjs";
import type { ConnectionState } from "../../src/lib";
import { ReconnectTimeMode, StompWebSocketClient } from "../../src/lib";
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
   * 서버가 인지한 수신 대기자 수. 보내기 전에 이 값이 기대치에 도달하길 기다린다 —
   * 구독 등록과 발행은 서로 다른 연결에서 일어나므로 도착 순서가 보장되지 않는다.
   * destination 개념이 없는 프로토콜에서는 연결 수와 같다.
   */
  readonly subscriptionCount: number;
  /** 종료 핸드셰이크 없이 모든 연결을 끊는다 (비정상 종료 재현). */
  killConnections(): void;
  /** 들어오는 요청에 일절 응답하지 않는다 (브로커 무응답 재현). */
  mute(): void;
  stop(): Promise<void>;
}

/** 채팅 참가자. 방 하나에 붙어서 듣고 말한다. */
export interface ChatMember {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** 이 방의 메시지 본문 스트림. 연결 전에 불러도 되고, 재연결되면 다시 걸려야 한다. */
  listen(): Observable<string>;
  say(text: string): void;
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

/** 테스트용 재연결 정책: 짧고 고정 간격. 지수 백오프 계산은 별도 단위 테스트 몫. */
const reconnect = {
  maxAttempts: 3,
  delay: 50,
  timeMode: ReconnectTimeMode.INTERVAL,
  maxDelay: 50,
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
      stop: () => broker.stop(),
    };
    return backend;
  },

  member(backend: ChatBackend, room: string): ChatMember {
    const { url } = backend as StompBackend;
    const destination = `/topic/${room}`;
    const client = new StompWebSocketClient({ brokerURL: url, reconnect });

    return {
      connect: () => client.connect(),
      disconnect: () => client.disconnect(),
      listen: () => client.subscribe(destination).pipe(map((message) => message.body)),
      say: (text) => client.send(text, { destination }),
      get state() {
        return client.connectionState;
      },
      stateChanges$: client.connectionChanges$,
    };
  },
};

/**
 * 순수 WebSocket 모드. 방은 접속 URL 로 구분하고, 서버가 같은 방 참가자에게 되뿌린다.
 * WindowWebSocketClientAdapter 가 구현되면 available 을 true 로 바꾸는 것만으로 같은 시나리오가 돈다.
 */
export const windowDriver: ChatDriver = {
  name: "window",
  available: false,
  pendingReason: "WindowWebSocketClientAdapter 미구현 (connect/send/onMessage 가 throw)",

  start(): Promise<ChatBackend> {
    throw new Error("not implemented");
  },
  member(): ChatMember {
    throw new Error("not implemented");
  },
};

/** MQTT 모드. topic 이 곧 방이라 STOMP 와 같은 형태가 된다. */
export const mqttDriver: ChatDriver = {
  name: "mqtt",
  available: false,
  pendingReason: "MqttWebSocketClientAdapter 미구현 (Controller 가 createAdapter 에서 throw)",

  start(): Promise<ChatBackend> {
    throw new Error("not implemented");
  },
  member(): ChatMember {
    throw new Error("not implemented");
  },
};

export const drivers: ChatDriver[] = [stompDriver, windowDriver, mqttDriver];
