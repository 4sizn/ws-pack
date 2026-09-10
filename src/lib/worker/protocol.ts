import type { MqttWebSocketClientOptions } from "../core/adapters/MqttWebSocketClientAdapter";
import type { StompWebSocketClientOptions } from "../core/adapters/StompWebSocketClientAdapter";
import type { WindowWebSocketClientOptions } from "../core/adapters/WindowWebSocketClientAdapter";
import type { DisconnectInfo } from "../core/CloseInfo";
import type { ConnectionState } from "../core/ConnectionState";
import type { ReconnectInfo } from "../core/Reconnect";

/**
 * 페이지와 워커 사이의 계약.
 *
 * 여기 오가는 값은 전부 구조화 복제(structured clone)가 되어야 한다. 그래서 프로토콜 객체를
 * 그대로 넘기지 않는다 — stompjs 의 IMessage 에는 ack() 같은 함수가, MQTT 패킷에는 Buffer 가 들어 있다.
 * 워커가 평문으로 투영해서 넘기고, 페이지는 그 평문만 본다.
 */

/** 워커 안에서 만들 클라이언트의 설정. plugins/logger 처럼 복제 불가능한 값은 뺀다. */
export type WorkerClientConfig =
  | {
      protocol: "window";
      options: Omit<WindowWebSocketClientOptions, "client" | "plugins" | "logger">;
    }
  | {
      protocol: "stomp";
      options: Omit<StompWebSocketClientOptions, "client" | "plugins" | "logger">;
    }
  | {
      protocol: "mqtt";
      options: Omit<MqttWebSocketClientOptions, "client" | "plugins" | "logger">;
    };

/** 워커가 넘겨주는 메시지. 프로토콜별 원본에서 복제 가능한 부분만 남긴 것. */
export interface WireMessage {
  body: string;
  /** STOMP destination 또는 MQTT topic. 순수 WebSocket 에는 없다. */
  destination?: string;
  headers?: Record<string, string>;
}

/** 페이지 → 워커 */
export type WorkerCommand =
  /** 이 포트가 쓸 연결 손잡이를 연다. 같은 key 를 요청하면 SharedWorker 안에서 연결을 공유한다. */
  | { type: "open"; handle: string; key: string; config: WorkerClientConfig }
  /** 손잡이를 놓는다. 마지막 사용자가 놓으면 연결도 닫힌다. */
  | { type: "release"; handle: string }
  | { type: "connect"; handle: string; command: string }
  | { type: "disconnect"; handle: string; command: string }
  | { type: "send"; handle: string; command: string; data: string; options?: unknown }
  /** 연결이 살아 있는지 워커에게 확인시킨다. 결과는 ack 의 alive 로 온다. */
  | { type: "revalidate"; handle: string; command: string; timeoutMs?: number }
  | {
      type: "subscribe";
      handle: string;
      subscription: string;
      destination: string;
      options?: unknown;
    }
  | { type: "unsubscribe"; handle: string; subscription: string };

/** 워커 → 페이지 */
export type WorkerEvent =
  /** connect/disconnect/send 요청의 응답. 실패는 여기로만 온다. */
  | { type: "ack"; handle: string; command: string; error?: string; alive?: boolean }
  | { type: "state"; handle: string; state: ConnectionState }
  | { type: "opened"; handle: string }
  | { type: "closed"; handle: string; info: DisconnectInfo }
  | { type: "error"; handle: string; name: string; message: string }
  | { type: "message"; handle: string; message: WireMessage }
  | { type: "subscription"; handle: string; subscription: string; message: WireMessage }
  | { type: "reconnect"; handle: string; info: ReconnectInfo }
  | { type: "exhausted"; handle: string };

/**
 * 포트 하나. 전용 Worker 는 자기 자신이 포트이고, SharedWorker 는 connect 이벤트로 받은 MessagePort 다.
 * 양쪽을 같은 타입으로 다루려고 필요한 메서드만 추린다.
 */
export interface MessageLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener?(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
}
