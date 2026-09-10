import type { IMessage, StompConfig } from "@stomp/stompjs";
import { BehaviorSubject, distinctUntilChanged, type Observable, Subject } from "rxjs";
import { AbstractController } from "../abstract/AbstractController";
import { ConnectionState } from "../ConnectionState";
import type { AbstractPlugin } from "../plugins/AbstractPlugin";
import { WebSocketMonitorPlugin } from "../plugins/AbstractPlugin";
import type { IWebSocketClientAdapter } from "../WebSocketClient";
import { StompWebSocketClientAdapter } from "../WebSocketClient";

type PluginHook = "onBeforeConnect" | "onAfterConnect" | "onBeforeDisconnect" | "onAfterDisconnect";

/**
 * @template TMessage 이 프로토콜의 메시지 페이로드 타입 (Window: string, Stomp: IMessage 등).
 * 구체 타입은 서브클래스(Window/Stomp/Mqtt)가 정한다 — base는 프로토콜을 모른다.
 */
export abstract class WebSocketController<TMessage = string> extends AbstractController {
  // 플러그인 관리
  readonly #plugins = new Map<string, AbstractPlugin>();
  protected adapter?: IWebSocketClientAdapter<unknown, TMessage>;

  readonly #connectionState$ = new BehaviorSubject<ConnectionState>(ConnectionState.IDLE);
  readonly #connectSubject = new Subject<void>();
  readonly #disconnectSubject = new Subject<void>();
  readonly #errorSubject = new Subject<Error>();
  readonly #messageSubject = new Subject<TMessage>();

  // ============================================
  // Public Observable Streams
  // ============================================

  /** 현재 연결 상태를 구독할 수 있는 공개 스트림 (읽기 전용). */
  public get connectionState$(): Observable<ConnectionState> {
    return this.#connectionState$.asObservable();
  }

  /** 연결 상태가 "바뀔 때"만 emit (연속 중복 값 제거). */
  public get connectionChanges$(): Observable<ConnectionState> {
    return this.#connectionState$.pipe(distinctUntilChanged());
  }

  /** 연결 성공 이벤트 */
  public get connect$(): Observable<void> {
    return this.#connectSubject.asObservable();
  }

  /** 연결 해제 이벤트 */
  public get disconnect$(): Observable<void> {
    return this.#disconnectSubject.asObservable();
  }

  /** connect() 실패 + 연결 중 어댑터가 보고하는 런타임 에러 */
  public get error$(): Observable<Error> {
    return this.#errorSubject.asObservable();
  }

  /** 수신한 모든 메시지. 타입은 프로토콜별 서브클래스가 정한다. */
  public get message$(): Observable<TMessage> {
    return this.#messageSubject.asObservable();
  }

  /** 현재 연결 상태 값 (동기 조회). */
  public get connectionState(): ConnectionState {
    return this.#connectionState$.value;
  }

  /**
   * 프로토콜별 Adapter 생성. 각 서브클래스(Stomp/Window/Mqtt)가 자기 Adapter를 만든다.
   * 연결 옵션은 각 서브클래스 생성자에서 이미 받아 저장해뒀으므로 여기선 인자가 없다.
   * 구조 관계: Client -> Controller -> Adapter. Controller만 Adapter의 구체 클래스를 안다.
   */
  protected abstract createAdapter(): IWebSocketClientAdapter<unknown, TMessage>;

  public async connect(): Promise<void> {
    // 이미 연결 중이거나 연결된 상태면 재호출 무시 (adapter.connect() 중복 실행 방지)
    if (this.connectionState !== ConnectionState.IDLE) {
      return;
    }

    this.#connectionState$.next(ConnectionState.CONNECTING);
    try {
      this.adapter ??= this.createAdapter();
      this.adapter.onMessage((data) => this.#messageSubject.next(data));
      this.adapter.onError(async (error) => {
        this.#errorSubject.next(error);
        await this.dispatchError(error);
      });

      await this.dispatch("onBeforeConnect");
      await this.adapter.connect();
      this.#connectionState$.next(ConnectionState.OPEN);
      this.#connectSubject.next();
      await this.dispatch("onAfterConnect");
    } catch (error) {
      // 실패 시 IDLE로 되돌려서 다음 connect() 재시도를 막지 않는다.
      this.#connectionState$.next(ConnectionState.IDLE);
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.#errorSubject.next(normalizedError);
      await this.dispatchError(normalizedError);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.connectionState !== ConnectionState.OPEN || !this.adapter) {
      return;
    }
    await this.dispatch("onBeforeDisconnect");
    this.adapter.disconnect();
    this.#connectionState$.next(ConnectionState.IDLE);
    this.#disconnectSubject.next();
    await this.dispatch("onAfterDisconnect");
  }

  public destroy?(): void {
    throw new Error("Method not implemented.");
  }

  // TODO: 재연결 로직(백오프, 재시도 횟수) 붙을 때 reconnectAttempt$ / maxReconnectReached$ 추가
  // — 지금은 재연결 자체가 구현 안 돼 있어서 Subject만 먼저 만들면 아무도 .next()를 안 부르는 죽은 스트림이 된다.

  // ============================================
  // Plugin Management
  // ============================================

  /**
   * 플러그인 추가
   */
  public addPlugin(plugin: AbstractPlugin): void {
    if (this.#plugins.has(plugin.name)) {
      throw new Error(`플러그인이 이미 등록됨: ${plugin.name}`);
    }

    this.#plugins.set(plugin.name, plugin);
    plugin.attach();
    console.log(`[${this.name}] 플러그인 추가: ${plugin.name}`);
  }

  /**
   * 플러그인 제거
   */
  public removePlugin(pluginName: string): void {
    const plugin = this.#plugins.get(pluginName);
    if (!plugin) {
      return;
    }

    plugin.detach();
    this.#plugins.delete(pluginName);
    console.log(`[${this.name}] 플러그인 제거: ${pluginName}`);
  }

  /**
   * 플러그인 조회
   */
  public getPlugin<T extends AbstractPlugin>(pluginName: string): T | undefined {
    return this.#plugins.get(pluginName) as T | undefined;
  }

  /**
   * 등록된 플러그인 이름 목록
   */
  public getPluginNames(): string[] {
    return Array.from(this.#plugins.keys());
  }

  private async dispatch(hook: PluginHook): Promise<void> {
    for (const plugin of this.#plugins.values()) {
      // 연결 생명주기 훅은 WebSocketMonitorPlugin 전용 — 다른 플러그인엔 없다.
      if (plugin instanceof WebSocketMonitorPlugin) {
        await plugin[hook]?.();
      }
    }
  }

  private async dispatchError(error: Error): Promise<void> {
    for (const plugin of this.#plugins.values()) {
      if (plugin instanceof WebSocketMonitorPlugin) {
        await plugin.onError?.(error);
      }
    }
  }
}

export class WindowWebSocketController extends WebSocketController<string> {
  public readonly name = "WindowWebSocketController";

  // TODO: WindowWebSocketClientAdapter 구현되면 this.options로 실제 생성하도록 연결
  constructor(_options: unknown) {
    super();
  }

  protected createAdapter(): IWebSocketClientAdapter<unknown, string> {
    throw new Error("Method not implemented.");
  }
}

export class StompWebSocketController extends WebSocketController<IMessage> {
  public readonly name = "StompWebSocketController";

  constructor(private readonly options: StompConfig) {
    super();
  }

  protected createAdapter(): IWebSocketClientAdapter<unknown, IMessage> {
    return new StompWebSocketClientAdapter(this.options);
  }
}

export class MqttWebSocketController extends WebSocketController<string> {
  public readonly name = "MqttWebSocketController";

  // TODO: MqttWebSocketClientAdapter 구현되면 this.options로 실제 생성하도록 연결
  constructor(_options: unknown) {
    super();
  }

  protected createAdapter(): IWebSocketClientAdapter<unknown, string> {
    throw new Error("Method not implemented.");
  }
}

export type ReconnectConfig = {
  maxReconnectAttempts: number;
  reconnectDelay: number;
};

export interface ReconnectInfo {
  attempts: number;
  maxAttempts: number;
  isReconnecting: boolean;
}
