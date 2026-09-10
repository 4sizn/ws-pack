import type { Observable } from "rxjs";
import { map, merge, Subject } from "rxjs";
import type { ConnectionState, DisconnectInfo, ReconnectInfo, WorkerClientConfig } from "../../lib";
import {
  MqttWebSocketClient,
  ReconnectTimeMode,
  StompWebSocketClient,
  WindowWebSocketClient,
  WorkerWebSocketClient,
} from "../../lib";

/** 데모가 지원하는 프로토콜. 화면에서 전환하며 같은 시나리오를 확인한다. */
export type Protocol = "stomp" | "window" | "mqtt";

/**
 * 연결을 어디서 들고 있을지.
 * - direct: 페이지(메인 스레드)가 소켓을 소유한다.
 * - worker: 이 탭 전용 Worker 가 소유한다. 소켓 작업이 메인 스레드에서 빠지지만 탭마다 따로다.
 * - shared: SharedWorker 가 소유한다. 탭이 여러 개여도 같은 방이면 소켓 하나를 공유한다.
 */
export type TransportMode = "direct" | "worker" | "shared";

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
  /** 세션이 폐기될 때 부른다. 워커 손잡이처럼 연결 종료와 별개로 놓아야 하는 자원이 있을 때 쓴다. */
  release?(): void;
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
export function createRoomTransport(
  protocol: Protocol,
  room: string,
  mode: TransportMode = "direct",
): RoomTransport {
  if (mode !== "direct") {
    return workerTransport(protocol, room, mode);
  }
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
    release: () => client.destroy(),
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
    release: () => client.destroy(),
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
    release: () => client.destroy(),
  };
}

/** 워커 안에서 만들 클라이언트 설정. direct 경로가 쓰는 것과 같은 옵션이어야 한다. */
function workerConfig(protocol: Protocol, room: string): WorkerClientConfig {
  switch (protocol) {
    case "stomp":
      return {
        protocol: "stomp",
        options: { brokerURL, connectHeaders: { login, passcode }, reconnect },
      };
    case "window":
      return { protocol: "window", options: { url: roomAddress("window", room), reconnect } };
    case "mqtt":
      return { protocol: "mqtt", options: { brokerURL: mqttURL, reconnect } };
  }
}

const workerURL = new URL("../../lib/worker/socket-worker.ts", import.meta.url);

/**
 * 페이지 전체가 워커 하나를 쓴다. 방마다 손잡이를 따로 열고, 워커 안에서 키로 연결을 구분한다.
 *
 * 전용 Worker 는 이 탭에만 존재하므로 공유는 탭 안에서 끝나고, SharedWorker 는 같은 키를 쓰는
 * 다른 탭과도 소켓을 공유한다. 진입 스크립트는 같은 파일이다.
 */
let dedicated: Worker | undefined;
let shared: SharedWorker | undefined;

function workerFor(mode: Exclude<TransportMode, "direct">): Worker | SharedWorker {
  if (mode === "shared") {
    shared ??= new SharedWorker(workerURL, { type: "module", name: "ws-pack-demo" });
    return shared;
  }
  dedicated ??= new Worker(workerURL, { type: "module", name: "ws-pack-demo" });
  return dedicated;
}

function workerTransport(
  protocol: Protocol,
  room: string,
  mode: Exclude<TransportMode, "direct">,
): RoomTransport {
  const config = workerConfig(protocol, room);
  const client = new WorkerWebSocketClient(workerFor(mode), config, {
    key: `${protocol}:${room}`,
  });

  // 워커 경유 전송은 비동기라 즉시 throw 하지 않는다. 실패를 error$ 로 합쳐서 화면이 같은 자리에서 본다.
  const sendErrors = new Subject<Error>();

  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    messages: () =>
      protocol === "window"
        ? client.message$.pipe(map((message) => message.body))
        : client.subscribe(destinationOf(protocol, room)).pipe(map((message) => message.body)),
    say: (text) => {
      void client
        .send(text, protocol === "window" ? undefined : sendOptionsOf(protocol, room))
        .catch((error: Error) => sendErrors.next(error));
    },
    connectionChanges$: client.connectionChanges$,
    reconnectAttempt$: client.reconnectAttempt$,
    error$: merge(client.error$, sendErrors),
    disconnect$: client.disconnect$,
    address: roomAddress(protocol, room),
    release: () => client.destroy(),
  };
}

/** 구독 대상. destination 이 있는 프로토콜만 쓴다. */
function destinationOf(protocol: Protocol, room: string): string {
  return protocol === "stomp" ? `/topic/${room}` : `chat/${room}`;
}

/** 발행 옵션. STOMP 는 destination, MQTT 는 topic 이라는 이름을 쓴다. */
function sendOptionsOf(protocol: Protocol, room: string): unknown {
  return protocol === "stomp"
    ? { destination: destinationOf(protocol, room) }
    : { topic: destinationOf(protocol, room) };
}
