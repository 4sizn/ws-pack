import type { Observable } from "rxjs";
import type { SendArgs } from "./adapters/WebSocketClientAdapter";
import type { WindowWebSocketClientOptions } from "./adapters/WindowWebSocketClientAdapter";
import type { DisconnectInfo } from "./CloseInfo";
import type { ConnectionState } from "./ConnectionState";
import type { WebSocketController } from "./controllers/NetworkController";
import { WindowWebSocketController } from "./controllers/NetworkController";
import type { NetworkClient } from "./NetworkClient";
import type { ReconnectInfo } from "./Reconnect";

/**
 * 구조 관계 : Client -> Controller -> Adapter
 * Client는 Controller만 들고 있고, Adapter의 존재/구체 클래스는 Controller만 안다.
 * 공개 API 표면. 모든 동작/스트림은 Controller 로 위임한다.
 *
 * @template TController 구체 Controller 타입. 서브클래스가 프로토콜 전용 메서드를 캐스팅 없이 부르기 위해 좁혀 쓴다.
 */
export class WebSocketClient<
  TMessage = string,
  TSend = undefined,
  TController extends WebSocketController<TMessage, TSend> = WebSocketController<TMessage, TSend>,
> implements NetworkClient<TMessage, TSend>
{
  protected readonly controller: TController;

  constructor(controller: TController) {
    this.controller = controller;
  }

  public connect(): Promise<void> {
    return this.controller.connect();
  }

  public disconnect(): Promise<void> {
    return this.controller.disconnect();
  }

  /** OPEN 이 아니면 throw. */
  public send(data: string, ...args: SendArgs<TSend>): void {
    this.controller.send(data, ...args);
  }

  public get connectionState$(): Observable<ConnectionState> {
    return this.controller.connectionState$;
  }

  public get connectionChanges$(): Observable<ConnectionState> {
    return this.controller.connectionChanges$;
  }

  public get connectionState(): ConnectionState {
    return this.controller.connectionState;
  }

  public get connect$(): Observable<void> {
    return this.controller.connect$;
  }

  public get disconnect$(): Observable<DisconnectInfo> {
    return this.controller.disconnect$;
  }

  public get error$(): Observable<Error> {
    return this.controller.error$;
  }

  public get message$(): Observable<TMessage> {
    return this.controller.message$;
  }

  public get reconnectAttempt$(): Observable<ReconnectInfo> {
    return this.controller.reconnectAttempt$;
  }

  public get maxReconnectReached$(): Observable<void> {
    return this.controller.maxReconnectReached$;
  }

  public get reconnectInfo(): ReconnectInfo {
    return this.controller.reconnectInfo;
  }

  /**
   * 지금 연결이 정말 살아 있는지 확인한다. 살아 있으면 true, 아니면 재연결을 시작하고 false.
   * 포그라운드 복귀나 네트워크 전환 같은 신호를 받은 쪽에서 부른다.
   */
  public revalidate(timeoutMs?: number): Promise<boolean> {
    return this.controller.revalidate(timeoutMs);
  }

  /**
   * 인스턴스 폐기. 연결을 놓고 스트림을 완료한다. 컴포넌트 언마운트처럼 인스턴스를 버릴 때 부른다.
   * 부르지 않으면 내부 구독과 플러그인이 계속 남는다.
   */
  public destroy(): void {
    this.controller.destroy();
  }
}

export class WindowWebSocketClient extends WebSocketClient<string> {
  constructor(options: WindowWebSocketClientOptions) {
    super(new WindowWebSocketController(options));
  }
}

// 재노출 — Adapter/Controller 는 각자 파일이 정의처. 기존 import 경로 호환용.
export type { IWebSocketClientAdapter, SendArgs } from "./adapters/WebSocketClientAdapter";
export { WebSocketClientAdapter } from "./adapters/WebSocketClientAdapter";
export {
  type WindowHeartbeatConfig,
  WindowWebSocketClientAdapter,
  type WindowWebSocketClientOptions,
} from "./adapters/WindowWebSocketClientAdapter";
export { WindowWebSocketController };
