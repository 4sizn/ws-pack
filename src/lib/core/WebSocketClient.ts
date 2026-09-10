import type { IMessage } from "@stomp/stompjs";
import type { Observable } from "rxjs";
import type { StompWebSocketClientOptions } from "./adapters/StompWebSocketClientAdapter";
import type { WindowWebSocketClientOptions } from "./adapters/WindowWebSocketClientAdapter";
import type { ConnectionState } from "./ConnectionState";
import type { WebSocketController } from "./controllers/NetworkController";
import {
  MqttWebSocketController,
  StompWebSocketController,
  WindowWebSocketController,
} from "./controllers/NetworkController";
import type { ReconnectInfo } from "./Reconnect";

/**
 * 구조 관계 : Client -> Controller -> Adapter
 * Client는 Controller만 들고 있고, Adapter의 존재/구체 클래스는 Controller만 안다.
 * 공개 API 표면. 모든 동작/스트림은 Controller 로 위임한다.
 */
export class WebSocketClient<TMessage = string> {
  #controller: WebSocketController<TMessage>;

  constructor(controller: WebSocketController<TMessage>) {
    this.#controller = controller;
  }

  public connect(): Promise<void> {
    return this.#controller.connect();
  }

  public disconnect(): Promise<void> {
    return this.#controller.disconnect();
  }

  public get connectionState$(): Observable<ConnectionState> {
    return this.#controller.connectionState$;
  }

  public get connectionChanges$(): Observable<ConnectionState> {
    return this.#controller.connectionChanges$;
  }

  public get connectionState(): ConnectionState {
    return this.#controller.connectionState;
  }

  public get connect$(): Observable<void> {
    return this.#controller.connect$;
  }

  public get disconnect$(): Observable<void> {
    return this.#controller.disconnect$;
  }

  public get error$(): Observable<Error> {
    return this.#controller.error$;
  }

  public get message$(): Observable<TMessage> {
    return this.#controller.message$;
  }

  public get reconnectAttempt$(): Observable<ReconnectInfo> {
    return this.#controller.reconnectAttempt$;
  }

  public get maxReconnectReached$(): Observable<void> {
    return this.#controller.maxReconnectReached$;
  }

  public get reconnectInfo(): ReconnectInfo {
    return this.#controller.reconnectInfo;
  }
}

export class WindowWebSocketClient extends WebSocketClient<string> {
  constructor(options: WindowWebSocketClientOptions) {
    super(new WindowWebSocketController(options));
  }
}

export class StompWebSocketClient extends WebSocketClient<IMessage> {
  constructor(options: StompWebSocketClientOptions) {
    super(new StompWebSocketController(options));
  }
}

export class MqttWebSocketClient extends WebSocketClient<string> {
  // TODO: Mqtt 옵션 타입 정의 + MqttWebSocketClientAdapter 구현 필요
  constructor(options: unknown) {
    super(new MqttWebSocketController(options));
  }
}

export {
  StompWebSocketClientAdapter,
  type StompWebSocketClientOptions,
} from "./adapters/StompWebSocketClientAdapter";
// 재노출 — Adapter/Controller 는 각자 파일이 정의처. 기존 import 경로 호환용.
export type { IWebSocketClientAdapter, SendArgs } from "./adapters/WebSocketClientAdapter";
export { WebSocketClientAdapter } from "./adapters/WebSocketClientAdapter";
export {
  WindowWebSocketClientAdapter,
  type WindowWebSocketClientOptions,
} from "./adapters/WindowWebSocketClientAdapter";
export { MqttWebSocketController, StompWebSocketController, WindowWebSocketController };
