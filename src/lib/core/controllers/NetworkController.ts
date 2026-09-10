import type { IMessage, StompHeaders } from "@stomp/stompjs";
import {
  BehaviorSubject,
  defer,
  distinctUntilChanged,
  EmptyError,
  firstValueFrom,
  from,
  type Observable,
  retry,
  Subject,
  takeUntil,
  timer,
} from "rxjs";
import { AbstractController } from "../abstract/AbstractController";
import {
  type StompSendOptions,
  StompWebSocketClientAdapter,
  type StompWebSocketClientOptions,
} from "../adapters/StompWebSocketClientAdapter";
import type { IWebSocketClientAdapter, SendArgs } from "../adapters/WebSocketClientAdapter";
import {
  WindowWebSocketClientAdapter,
  type WindowWebSocketClientOptions,
} from "../adapters/WindowWebSocketClientAdapter";
import { ConnectionState } from "../ConnectionState";
import type { PubSubAble } from "../PubSubAble";
import type { AbstractPlugin } from "../plugins/AbstractPlugin";
import { WebSocketMonitorPlugin } from "../plugins/AbstractPlugin";
import {
  computeReconnectDelay,
  type ReconnectConfig,
  type ReconnectInfo,
  type ResolvedReconnectConfig,
  resolveReconnectConfig,
} from "../Reconnect";

type PluginHook = "onBeforeConnect" | "onAfterConnect" | "onBeforeDisconnect" | "onAfterDisconnect";

/** disconnect() 가 진행 중인 재시도를 끊었을 때 내부적으로 쓰는 신호. 밖으로 안 나간다. */
class ReconnectAbortedError extends Error {
  constructor() {
    super("reconnect aborted by disconnect()");
    this.name = "ReconnectAbortedError";
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 구조 관계: Client -> Controller -> Adapter.
 * Controller는 연결 정책(재연결/백오프)과 ConnectionState 를 소유한다. Adapter는 "한 번 연결 시도"만 한다.
 *
 * @template TMessage 이 프로토콜의 메시지 페이로드 타입 (Window: string, Stomp: IMessage 등).
 * @template TSend    send() 두 번째 인자 타입 (Window: 없음, Stomp: StompSendOptions).
 * @template TAdapter 구체 Adapter 타입. 서브클래스가 프로토콜 전용 메서드(예: STOMP subscribe)를
 *                    캐스팅 없이 부르기 위해 좁혀 쓴다. base 는 인터페이스만 본다.
 */
export abstract class WebSocketController<
  TMessage = string,
  TSend = undefined,
  TAdapter extends IWebSocketClientAdapter<TSend, TMessage> = IWebSocketClientAdapter<
    TSend,
    TMessage
  >,
> extends AbstractController {
  // 플러그인 관리
  readonly #plugins = new Map<string, AbstractPlugin>();
  protected adapter?: TAdapter;

  // 재연결 정책
  readonly #reconnect: ResolvedReconnectConfig;
  #reconnectAttempts = 0;
  readonly #stopReconnect$ = new Subject<void>();

  readonly #connectionState$ = new BehaviorSubject<ConnectionState>(ConnectionState.IDLE);
  readonly #connectSubject = new Subject<void>();
  readonly #disconnectSubject = new Subject<void>();
  readonly #errorSubject = new Subject<Error>();
  readonly #messageSubject = new Subject<TMessage>();
  readonly #reconnectAttemptSubject = new Subject<ReconnectInfo>();
  readonly #maxReconnectReachedSubject = new Subject<void>();

  constructor(reconnect?: ReconnectConfig) {
    super();
    this.#reconnect = resolveReconnectConfig(reconnect);
  }

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

  /** 연결 성공 이벤트 (최초 연결 + 재연결 성공 모두) */
  public get connect$(): Observable<void> {
    return this.#connectSubject.asObservable();
  }

  /** 연결이 끊긴 이벤트 (수동 disconnect + 예기치 않은 끊김 모두) */
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

  /** 재시도 1회마다 emit (대기 시작 시점) */
  public get reconnectAttempt$(): Observable<ReconnectInfo> {
    return this.#reconnectAttemptSubject.asObservable();
  }

  /** 최대 재시도 횟수 소진. 이후 상태는 CLOSED. */
  public get maxReconnectReached$(): Observable<void> {
    return this.#maxReconnectReachedSubject.asObservable();
  }

  /** 현재 연결 상태 값 (동기 조회). */
  public get connectionState(): ConnectionState {
    return this.#connectionState$.value;
  }

  /** 현재 재연결 정보 (동기 조회). */
  public get reconnectInfo(): ReconnectInfo {
    return {
      attempts: this.#reconnectAttempts,
      maxAttempts: this.#reconnect.maxAttempts,
      isReconnecting: this.connectionState === ConnectionState.RECONNECTING,
    };
  }

  // ============================================
  // Connection Lifecycle
  // ============================================

  /**
   * 프로토콜별 Adapter 생성. 각 서브클래스(Stomp/Window/Mqtt)가 자기 Adapter를 만든다.
   * 연결 옵션은 각 서브클래스 생성자에서 이미 받아 저장해뒀으므로 여기선 인자가 없다.
   * Controller만 Adapter의 구체 클래스를 안다.
   */
  protected abstract createAdapter(): TAdapter;

  /**
   * 연결 시작. IDLE 또는 CLOSED(재시도 소진 후) 에서만 동작하고, 그 외 상태면 무시한다.
   * 첫 시도 실패 시 ReconnectConfig 대로 재시도하고, 전부 실패하면 CLOSED 로 가며 reject 한다.
   * 재시도 도중 disconnect() 가 불리면 조용히 resolve 한다 (에러 아님).
   */
  public async connect(): Promise<void> {
    const state = this.connectionState;
    if (state !== ConnectionState.IDLE && state !== ConnectionState.CLOSED) {
      return;
    }

    const adapter = this.ensureAdapter();
    this.#setState(ConnectionState.CONNECTING);

    // onBeforeConnect 만 연결을 거부(throw)할 수 있다. 거부되면 상태를 되돌리고 그대로 던진다.
    try {
      await this.dispatch("onBeforeConnect");
    } catch (error) {
      this.#setState(state);
      throw error;
    }

    const error = await this.#establish(adapter);
    if (error) {
      throw error;
    }
  }

  /**
   * 연결 종료. 진행 중인 재시도도 끊는다. IDLE/CLOSED/CLOSING 이면 무시.
   */
  public async disconnect(): Promise<void> {
    const state = this.connectionState;
    if (
      state === ConnectionState.IDLE ||
      state === ConnectionState.CLOSED ||
      state === ConnectionState.CLOSING
    ) {
      return;
    }

    // 진행 중인 재시도 루프 중단 (CONNECTING/RECONNECTING 이었을 때)
    this.#stopReconnect$.next();

    const wasOpen = state === ConnectionState.OPEN;
    this.#setState(ConnectionState.CLOSING);
    if (wasOpen) {
      // 플러그인이 throw 해도 종료는 계속한다 — 상태가 CLOSING 에 갇히면 안 된다
      await this.#dispatchSafe("onBeforeDisconnect");
    }

    try {
      await this.adapter?.disconnect();
    } finally {
      this.#reconnectAttempts = 0;
      this.#setState(ConnectionState.IDLE);
      this.#disconnectSubject.next();
    }

    if (wasOpen) {
      await this.#dispatchSafe("onAfterDisconnect");
    }
  }

  /**
   * 메시지 전송. OPEN 이 아니면 throw — 큐잉하지 않는다. 필요하면 호출 측이 connect$ 를 기다린다.
   */
  public send(data: string, ...args: SendArgs<TSend>): void {
    if (this.connectionState !== ConnectionState.OPEN || !this.adapter) {
      throw new Error(`[${this.name}] cannot send: connection is ${this.connectionState}`);
    }
    this.adapter.send(data, ...args);
  }

  public destroy?(): void {
    throw new Error("Method not implemented.");
  }

  /**
   * Adapter 는 한 번만 만들고, 콜백도 그때 한 번만 건다 (connect() 재호출 시 중복 등록 방지).
   * 서브클래스가 연결 전에 어댑터 기능(예: STOMP subscribe 예약)을 써야 할 때도 이걸 부른다.
   */
  protected ensureAdapter(): TAdapter {
    if (this.adapter) {
      return this.adapter;
    }
    const adapter = this.createAdapter();
    adapter.onMessage((data) => this.#messageSubject.next(data));
    adapter.onError((error) => {
      void this.#emitError(error);
    });
    adapter.onClose(() => {
      void this.#handleUnexpectedClose();
    });
    this.adapter = adapter;
    return adapter;
  }

  /**
   * 재시도 포함 연결 확립. 성공하면 OPEN + connect$ + onAfterConnect 까지 처리하고 undefined 반환.
   * 재시도 소진이면 CLOSED + maxReconnectReached$ + error$ 처리 후 그 에러를 반환.
   * disconnect() 로 중단됐으면 상태를 건드리지 않고 undefined 반환 (disconnect() 가 상태를 IDLE 로 마무리한다).
   */
  async #establish(adapter: TAdapter): Promise<Error | undefined> {
    try {
      await this.#connectWithRetry(adapter);
    } catch (error) {
      if (error instanceof ReconnectAbortedError) {
        return undefined;
      }
      // 각 시도의 원인 에러는 어댑터 onError 콜백을 통해 이미 error$ 로 나갔다.
      // 여기선 "재시도 소진" 이라는 별개 사건을 한 번만 알린다 (같은 에러 중복 emit 방지).
      const failure = new Error(
        `Maximum reconnection attempts (${this.#reconnect.maxAttempts}) reached`,
        { cause: error },
      );
      this.#setState(ConnectionState.CLOSED);
      this.#maxReconnectReachedSubject.next();
      await this.#emitError(failure);
      return failure;
    }

    this.#reconnectAttempts = 0;
    this.#setState(ConnectionState.OPEN);
    this.#connectSubject.next();
    // 연결은 이미 성립했다. 플러그인 실패가 연결을 실패로 만들면 안 되므로 error$ 로만 흘린다.
    await this.#dispatchSafe("onAfterConnect");
    return undefined;
  }

  /**
   * adapter.connect() 를 ReconnectConfig 대로 재시도한다.
   * - maxAttempts 는 "첫 시도를 제외한" 재시도 횟수다 (총 시도 = 1 + maxAttempts).
   * - 재시도 대기 시작 시 RECONNECTING 으로 바꾸고 reconnectAttempt$ 를 emit 한다.
   * - disconnect() 가 #stopReconnect$ 를 쏘면 ReconnectAbortedError 로 빠져나온다.
   */
  async #connectWithRetry(adapter: TAdapter): Promise<void> {
    const attempt$ = defer(() => from(adapter.connect())).pipe(
      retry({
        count: this.#reconnect.maxAttempts,
        delay: (_error, retryCount) => {
          this.#reconnectAttempts = retryCount;
          this.#setState(ConnectionState.RECONNECTING);
          this.#reconnectAttemptSubject.next(this.reconnectInfo);
          return timer(computeReconnectDelay(this.#reconnect, retryCount));
        },
      }),
      takeUntil(this.#stopReconnect$),
    );

    try {
      await firstValueFrom(attempt$);
    } catch (error) {
      // takeUntil 이 emit 전에 스트림을 닫으면 firstValueFrom 은 EmptyError 를 던진다 = disconnect() 로 중단됨
      if (error instanceof EmptyError) {
        throw new ReconnectAbortedError();
      }
      throw error;
    }
  }

  /**
   * OPEN 상태에서 소켓이 끊기면 자동 재연결에 들어간다.
   * CONNECTING/RECONNECTING 중의 close 는 재시도 루프가 이미 처리하므로 무시하고,
   * CLOSING/IDLE 의 close 는 수동 disconnect 이므로 무시한다.
   */
  async #handleUnexpectedClose(): Promise<void> {
    if (this.connectionState !== ConnectionState.OPEN || !this.adapter) {
      return;
    }
    this.#setState(ConnectionState.RECONNECTING);
    this.#disconnectSubject.next();
    await this.#establish(this.adapter);
  }

  async #emitError(error: Error): Promise<void> {
    this.#errorSubject.next(error);
    await this.dispatchError(error);
  }

  #setState(next: ConnectionState): void {
    this.#connectionState$.next(next);
  }

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

  /** 플러그인이 throw 해도 상태 머신을 멈추지 않고 error$ 로 돌린다. onBeforeConnect 를 제외한 모든 훅에 사용. */
  async #dispatchSafe(hook: PluginHook): Promise<void> {
    try {
      await this.dispatch(hook);
    } catch (error) {
      await this.#emitError(toError(error));
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

  constructor(private readonly options: WindowWebSocketClientOptions) {
    super(options.reconnect);
    for (const plugin of options.plugins ?? []) {
      this.addPlugin(plugin);
    }
  }

  protected createAdapter(): IWebSocketClientAdapter<undefined, string> {
    return new WindowWebSocketClientAdapter(this.options);
  }
}

export class StompWebSocketController
  extends WebSocketController<IMessage, StompSendOptions, StompWebSocketClientAdapter>
  implements PubSubAble<IMessage, StompHeaders>
{
  public readonly name = "StompWebSocketController";

  constructor(private readonly options: StompWebSocketClientOptions) {
    super(options.reconnect);
    for (const plugin of options.plugins ?? []) {
      this.addPlugin(plugin);
    }
  }

  protected createAdapter(): StompWebSocketClientAdapter {
    return new StompWebSocketClientAdapter(this.options);
  }

  /**
   * STOMP destination 구독. connect() 전에 불러도 되고(연결되면 걸림), 재연결되면 자동으로 다시 걸린다.
   * 반환 Observable 을 unsubscribe 하면 STOMP 구독도 해제된다.
   */
  public subscribe(destination: string, headers?: StompHeaders): Observable<IMessage> {
    return this.ensureAdapter().subscribe(destination, headers);
  }
}

export class MqttWebSocketController extends WebSocketController<string> {
  public readonly name = "MqttWebSocketController";

  // TODO: MqttWebSocketClientAdapter 구현되면 options 타입 정의 + createAdapter 연결
  constructor(_options: unknown) {
    super();
  }

  protected createAdapter(): IWebSocketClientAdapter<undefined, string> {
    throw new Error("Method not implemented.");
  }
}
