import type { Observable } from "rxjs";
import { map } from "rxjs";
import type { ConnectionState, DisconnectInfo, ReconnectInfo } from "../../lib";
import {
  MqttWebSocketClient,
  ReconnectTimeMode,
  StompWebSocketClient,
  WindowWebSocketClient,
} from "../../lib";

/** 데모가 지원하는 프로토콜. 화면에서 전환하며 같은 시나리오를 확인한다. */
export type Protocol = "stomp" | "window" | "mqtt";

/**
 * 방 하나에 붙는 연결. 프로토콜 차이를 여기서 흡수해서, 위 계층(RoomSession)은
 * "듣는다 / 말한다" 만 안다. 계약 테스트의 드라이버와 같은 경계다.
 */
export interface RoomTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** 이 방의 메시지 본문 스트림 */
  messages(): Observable<string>;
  say(text: string): void;
  readonly connectionChanges$: Observable<ConnectionState>;
  readonly reconnectAttempt$: Observable<ReconnectInfo>;
  readonly error$: Observable<Error>;
  readonly disconnect$: Observable<DisconnectInfo>;
  /** 화면에 보여줄 실제 접속 대상 (destination 또는 URL) */
  readonly address: string;
}

/** 데모용 브로커/서버 주소. 기본값은 docker-compose.test.yml 의 RabbitMQ 와 `bun run ws:server`. */
const brokerURL = import.meta.env.VITE_STOMP_URL ?? "ws://127.0.0.1:15674/ws";
const login = import.meta.env.VITE_STOMP_LOGIN ?? "test";
const passcode = import.meta.env.VITE_STOMP_PASSCODE ?? "test";
const echoURL = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:8010";
const mqttURL = import.meta.env.VITE_MQTT_URL ?? "ws://127.0.0.1:8011";

const reconnect = {
  maxAttempts: 5,
  delay: 1000,
  timeMode: ReconnectTimeMode.EXPONENTIAL,
  maxDelay: 10_000,
};

/**
 * 방 하나당 클라이언트 인스턴스 하나. 인스턴스끼리 소켓/구독/재연결 상태를 전혀 공유하지 않는다.
 *
 * `room` 은 프로토콜에 따라 다르게 주소로 바뀐다:
 * STOMP 는 destination(`/topic/<room>`), 순수 WebSocket 은 접속 URL 의 질의 문자열(`?room=<room>`).
 * destination 개념이 없는 프로토콜에서는 연결 자체가 방이기 때문이다.
 */
export function createRoomTransport(protocol: Protocol, room: string): RoomTransport {
  switch (protocol) {
    case "stomp":
      return stompTransport(room);
    case "window":
      return windowTransport(room);
    case "mqtt":
      return mqttTransport(room);
  }
}

/** 방 이름이 실제로 어떤 주소가 되는지. 화면 표시와 전송이 같은 계산을 쓰도록 여기 한 곳에 둔다. */
export function roomAddress(protocol: Protocol, room: string): string {
  switch (protocol) {
    case "stomp":
      return `/topic/${room}`;
    case "window":
      return `${echoURL}/?room=${encodeURIComponent(room)}`;
    case "mqtt":
      return `${mqttURL} · chat/${room}`;
  }
}

function stompTransport(room: string): RoomTransport {
  const destination = roomAddress("stomp", room);
  const client = new StompWebSocketClient({
    brokerURL,
    connectHeaders: { login, passcode },
    reconnect,
  });

  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    messages: () => client.subscribe(destination).pipe(map((message) => message.body)),
    say: (text) => client.send(text, { destination }),
    connectionChanges$: client.connectionChanges$,
    reconnectAttempt$: client.reconnectAttempt$,
    error$: client.error$,
    disconnect$: client.disconnect$,
    address: destination,
  };
}

function windowTransport(room: string): RoomTransport {
  const url = roomAddress("window", room);
  const client = new WindowWebSocketClient({ url, reconnect });

  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    // 연결 자체가 방이라 구독 단계가 없다. 이 연결로 들어오는 모든 메시지가 이 방의 메시지다.
    messages: () => client.message$,
    say: (text) => client.send(text),
    connectionChanges$: client.connectionChanges$,
    reconnectAttempt$: client.reconnectAttempt$,
    error$: client.error$,
    disconnect$: client.disconnect$,
    address: url,
  };
}

function mqttTransport(room: string): RoomTransport {
  const topic = `chat/${room}`;
  const client = new MqttWebSocketClient({ brokerURL: mqttURL, reconnect });

  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    messages: () => client.subscribe(topic).pipe(map((message) => message.body)),
    say: (text) => client.send(text, { topic }),
    connectionChanges$: client.connectionChanges$,
    reconnectAttempt$: client.reconnectAttempt$,
    error$: client.error$,
    disconnect$: client.disconnect$,
    address: roomAddress("mqtt", room),
  };
}
