import type { IMessage, Client as StompClient, StompConfig } from "@stomp/stompjs";
import type { Observable } from "rxjs";
import type { ConnectionState } from "./ConnectionState";
import type { WebSocketController } from "./controllers/NetworkController";
import {
  MqttWebSocketController,
  StompWebSocketController,
  WindowWebSocketController,
} from "./controllers/NetworkController";
import type { AbstractPlugin, Logger } from "./plugins/AbstractPlugin";

/**
 * 구조 관계 : Client -> Controller -> Adapter
 * Client는 Controller만 들고 있고, Adapter의 존재/구체 클래스는 Controller만 안다.
 */

type SendArgs<TSend> = TSend extends undefined ? [] : [options: TSend];

export interface IWebSocketClientAdapter<TSend = undefined, TMessage = string> {
  connect(): Promise<void>;
  disconnect(): void;
  send(data: string, ...args: SendArgs<TSend>): void;
  onMessage(callback: (data: TMessage) => void): void;
  onError(callback: (error: Error) => void): void;
  onClose(callback: () => void): void;
  onConnect(callback: () => void): void;
}

export abstract class WebSocketClientAdapter<T, C, TMessage = string>
  implements IWebSocketClientAdapter<T, TMessage>
{
  protected client?: T;
  protected maxReconnectAttempts: number = 5; // 기본값 5회

  public abstract connect(config?: C): Promise<void>;
  public abstract disconnect(): void;
  public abstract send(): void;
  public abstract onMessage(callback: (data: TMessage) => void): void;
  public abstract onError(callback: (error: Error) => void): void;
  public abstract onClose(callback: () => void): void;
  public abstract onConnect(callback: () => void): void;
  public abstract networkStatus(): number;
}

/** 브라우저 내장 `WebSocket` 생성자가 받는 인자 타입 (url, protocols) */
type BrowserWebSocketArgs = ConstructorParameters<typeof WebSocket>;

export interface WindowWebSocketClientOptions {
  /** `new WebSocket(url, protocols)` 의 url과 동일한 타입 */
  url: BrowserWebSocketArgs[0];
  /** `new WebSocket(url, protocols)` 의 protocols와 동일한 타입 */
  protocols?: BrowserWebSocketArgs[1];
  /** 이미 만들어진 WebSocket 인스턴스를 주입. 없으면 어댑터가 내부에서 기본 생성한다. */
  client?: WebSocket;
  logger?: Logger;
  plugins?: AbstractPlugin[];
}

export class WebSocketClient<C, TMessage = string> {
  #controller: WebSocketController<TMessage>;

  constructor(controller: WebSocketController<TMessage>) {
    this.#controller = controller;
  }

  public connect(config: C): Promise<void> {
    return this.#controller.connect(config);
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
}

export class WindowWebSocketClient extends WebSocketClient<WindowWebSocketClientOptions, string> {
  // TODO: options를 WindowWebSocketController 생성자로 전달 (createAdapter 연결은 다음 단계)
  constructor(_options: WindowWebSocketClientOptions) {
    super(new WindowWebSocketController());
  }
}

export class StompWebSocketClient extends WebSocketClient<StompConfig, IMessage> {
  // TODO: options를 StompWebSocketController 생성자로 전달 (createAdapter 연결은 다음 단계)
  constructor(_options: StompConfig) {
    super(new StompWebSocketController());
  }
}

export class MqttWebSocketClient extends WebSocketClient<unknown, string> {
  // TODO: Mqtt 옵션 타입 정의 + MqttWebSocketClientAdapter 구현 필요
  constructor(_options: unknown) {
    super(new MqttWebSocketController());
  }
}

export class WindowWebSocketClientAdapter extends WebSocketClientAdapter<
  WebSocket,
  WindowWebSocketClientOptions
> {
  public connect(_config?: WindowWebSocketClientOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
  public disconnect(): void {
    throw new Error("Method not implemented.");
  }
  public send(): void {
    throw new Error("Method not implemented.");
  }
  public onMessage(_callback: (data: string) => void): void {
    throw new Error("Method not implemented.");
  }
  public onError(_callback: (error: Error) => void): void {
    throw new Error("Method not implemented.");
  }
  public onClose(_callback: () => void): void {
    throw new Error("Method not implemented.");
  }
  public onConnect(_callback: () => void): void {
    throw new Error("Method not implemented.");
  }
  public networkStatus(): number {
    throw new Error("Method not implemented.");
  }
}

export class StompWebSocketClientAdapter extends WebSocketClientAdapter<
  StompClient,
  StompConfig,
  IMessage
> {
  public connect(_config?: StompConfig): Promise<void> {
    throw new Error("Method not implemented.");
  }
  public disconnect(): void {
    throw new Error("Method not implemented.");
  }
  public send(): void {
    throw new Error("Method not implemented.");
  }
  public onMessage(_callback: (data: IMessage) => void): void {
    throw new Error("Method not implemented.");
  }
  public onError(_callback: (error: Error) => void): void {
    throw new Error("Method not implemented.");
  }
  public onClose(_callback: () => void): void {
    throw new Error("Method not implemented.");
  }
  public onConnect(_callback: () => void): void {
    throw new Error("Method not implemented.");
  }
  public networkStatus(): number {
    throw new Error("Method not implemented.");
  }
}

// 참고: StompWebSocketController / WindowWebSocketController / MqttWebSocketController는
// ./controllers/NetworkController 가 유일한 정의처다 (여기서 중복 정의하지 않는다).
export { MqttWebSocketController, StompWebSocketController, WindowWebSocketController };
