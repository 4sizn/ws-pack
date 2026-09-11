import {
  BehaviorSubject,
  catchError,
  concat,
  defer,
  distinctUntilChanged,
  EMPTY,
  finalize,
  firstValueFrom,
  from,
  ignoreElements,
  type Observable,
  repeat,
  retry,
  Subject,
  type Subscription,
  switchMap,
  take,
  tap,
  throwError,
  timer,
} from "rxjs";
import { AbstractController } from "../abstract/AbstractController";
import type { IWebSocketClientAdapter, SendArgs } from "../adapters/WebSocketClientAdapter";
import {
  WindowWebSocketClientAdapter,
  type WindowWebSocketClientOptions,
} from "../adapters/WindowWebSocketClientAdapter";
import type { DisconnectInfo, SocketCloseInfo } from "../CloseInfo";
import { ConnectionState } from "../ConnectionState";
import type { AbstractPlugin } from "../plugins/AbstractPlugin";
import {
  nextReconnectDelay,
  type ReconnectConfig,
  type ReconnectInfo,
  type ResolvedReconnectConfig,
  resolveReconnectConfig,
} from "../Reconnect";

type PluginHook = "onBeforeConnect" | "onAfterConnect" | "onBeforeDisconnect" | "onAfterDisconnect";

/**
 * 연결/종료 "의도". 상태 플래그 대신 의도를 스트림에 실어 한 줄로 세운다.
 * `done` 은 호출자의 Promise 로 이어지며, 다음 의도에 밀려나면 값 없이 complete 한다(조용히 resolve).
 */
interface Intent {
  kind: "connect" | "disconnect";
  done: Subject<void>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 구조 관계: Client -> Controller -> Adapter.
 * Controller는 연결 정책(재연결/백오프)과 ConnectionState 를 소유한다. Adapter는 "한 번 연결 시도"만 한다.
 *
 * 수명 관리 규칙은 두 개뿐이다.
 * 1. 의도는 스트림으로 직렬화한다 — `switchMap` 이므로 새 의도가 들어오면 이전 흐름은 구독 해제된다.
 *    "지금 종료 중인가" 같은 플래그를 따로 들지 않는다.
 * 2. 연결의 수명은 AbortSignal 하나로 표현한다 — 흐름이 구독 해제되면 finalize 가 abort 하고,
 *    어댑터는 그 신호만 보고 시도 중이든 연결됐든 소켓을 놓는다. 주인 없는 소켓이 남지 않는다.
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

  /** 연결/종료 의도. 하나의 스트림으로 직렬화된다. */
  readonly #intent$ = new Subject<Intent>();
  /** 어댑터가 알려주는 소켓 종료. 연결 수명 스트림이 이 신호를 보고 다음 시도로 넘어간다. */
  readonly #socketClosed$ = new Subject<SocketCloseInfo>();

  readonly #connectionState$ = new BehaviorSubject<ConnectionState>(ConnectionState.IDLE);
  readonly #connectSubject = new Subject<void>();
  readonly #disconnectSubject = new Subject<DisconnectInfo>();
  readonly #errorSubject = new Subject<Error>();
  readonly #messageSubject = new Subject<TMessage>();
  readonly #reconnectAttemptSubject = new Subject<ReconnectInfo>();
  readonly #maxReconnectReachedSubject = new Subject<void>();

  /** 의도 처리 구독. destroy() 가 이걸 끊으면 진행 중인 세션도 finalize 를 거쳐 정리된다. */
  readonly #intents: Subscription;

  /** 폐기된 인스턴스인지. 되돌릴 수 없는 종착 상태라 연결 상태와 따로 둔다. */
  #destroyed = false;

  constructor(reconnect?: ReconnectConfig) {
    super();
    this.#reconnect = resolveReconnectConfig(reconnect);
    // 마지막 의도가 이긴다. 이전 흐름의 정리는 그 흐름의 finalize 가 책임진다.
    this.#intents = this.#intent$.pipe(switchMap((intent) => this.#run(intent))).subscribe();
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

  /** 연결이 끊긴 이벤트. 수동 종료인지(manual)와 close code/reason 을 함께 준다. */
  public get disconnect$(): Observable<DisconnectInfo> {
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
   * 연결 시작. OPEN 에 도달하면 resolve, 재시도까지 모두 실패하면 reject.
   * 이미 연결 중이거나 연결된 상태면 아무 일도 하지 않는다.
   * 연결되기 전에 disconnect() 가 끼어들면 조용히 resolve 한다 (에러 아님).
   */
  public connect(): Promise<void> {
    if (this.#destroyed) {
      return Promise.reject(new Error(`[${this.name}] controller has been destroyed`));
    }

    const state = this.connectionState;
    // 이미 연결 중이거나 연결돼 있으면 의도를 발행하지 않는다.
    // 발행하는 순간 switchMap 이 지금 돌고 있는 세션을 대체하고, 그 세션의 finalize 가
    // 살아 있는 연결을 놓아 버린다 — 아무것도 바꾸지 않는 의도가 연결을 끊는 셈이 된다.
    if (state !== ConnectionState.IDLE && state !== ConnectionState.CLOSED) {
      return Promise.resolve();
    }
    return this.#intend("connect");
  }

  /**
   * 연결 종료. 진행 중인 재시도도 함께 끊긴다.
   *
   * onBeforeDisconnect 는 소켓이 아직 열려 있는 동안 부르고, 그 다음에 종료 의도를 발행한다.
   * 플러그인이 throw 하거나 오래 걸려도 종료 자체는 진행된다.
   */
  public async disconnect(): Promise<void> {
    if (this.#destroyed) return;

    const state = this.connectionState;
    // 끊을 것이 없으면 의도를 발행하지 않는다 (같은 이유로 무의미한 대체를 만들지 않는다).
    if (state === ConnectionState.IDLE || state === ConnectionState.CLOSED) {
      return;
    }

    const wasOpen = state === ConnectionState.OPEN;
    if (wasOpen) {
      await this.#dispatchSafe("onBeforeDisconnect");
    }

    await this.#intend("disconnect");

    if (wasOpen) {
      await this.#dispatchSafe("onAfterDisconnect");
    }
  }

  /**
   * 지금 연결이 정말 살아 있는지 확인한다. 살아 있으면 true, 아니면 재연결을 시작하고 false.
   *
   * 언제 부를지는 이 라이브러리가 정하지 않는다 — 포그라운드 복귀, 네트워크 전환 같은 신호는
   * 실행 환경마다 다르고(워커에는 document 가 없다) 앱마다 정책이 다르다. 신호를 받은 쪽이 부른다.
   *
   * @param timeoutMs 왕복 응답을 기다리는 시간. 지나면 죽은 것으로 본다.
   */
  public async revalidate(timeoutMs = 3000): Promise<boolean> {
    if (this.#destroyed) return false;

    if (this.connectionState !== ConnectionState.OPEN) {
      if (this.connectionState === ConnectionState.CLOSED) {
        this.#reconnectAttempts = 0;
        // 오류는 error$ / maxReconnectReached$ 로 이미 나가므로 여기선 조용히 넘긴다.
        void this.connect().catch(() => {});
      }
      return false;
    }

    if (!this.adapter) return false;

    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), timeoutMs);
    let alive: boolean;
    try {
      alive = await this.adapter.revalidate(limit.signal);
    } catch {
      alive = false;
    } finally {
      clearTimeout(timer);
    }

    if (alive) return true;

    // 죽은 연결은 소켓이 닫힌 것과 같은 사건으로 취급한다 — 재연결 경로를 하나로 유지한다.
    this.#socketClosed$.next({ reason: "revalidate failed" });
    return false;
  }

  /**
   * 메시지 전송. OPEN 이 아니면 throw — 큐잉하지 않는다. 필요하면 호출 측이 connect$ 를 기다린다.
   */
  public send(data: string, ...args: SendArgs<TSend>): void {
    if (this.#destroyed) {
      throw new Error(`[${this.name}] cannot send: controller has been destroyed`);
    }
    if (this.connectionState !== ConnectionState.OPEN || !this.adapter) {
      throw new Error(`[${this.name}] cannot send: connection is ${this.connectionState}`);
    }
    this.adapter.send(data, ...args);
  }

  /**
   * 인스턴스 폐기. 연결을 놓고, 스트림을 완료하고, 플러그인을 뗀다. 다시 쓰지 않는다.
   *
   * 의도 구독을 끊는 것으로 시작하는 이유: 진행 중인 세션이 그 순간 구독 해제되고,
   * 세션의 finalize 가 signal 을 abort 해서 어댑터가 소켓을 놓는다 — 종료 경로가 하나로 유지된다.
   *
   * 두 번 불러도 안전하고, 폐기 후의 connect() 는 조용히 무시되는 대신 거부된다.
   * 살아 있다고 착각한 채 기다리는 호출자를 만들지 않기 위해서다.
   */
  public destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    this.#intents.unsubscribe();
    void this.adapter?.disconnect();

    for (const name of [...this.#plugins.keys()]) {
      this.removePlugin(name);
    }

    this.#intent$.complete();
    this.#socketClosed$.complete();
    this.#connectionState$.complete();
    this.#connectSubject.complete();
    this.#disconnectSubject.complete();
    this.#errorSubject.complete();
    this.#messageSubject.complete();
    this.#reconnectAttemptSubject.complete();
    this.#maxReconnectReachedSubject.complete();
  }

  /** 폐기 여부. 폐기된 인스턴스는 연결도 전송도 받지 않는다. */
  public get destroyed(): boolean {
    return this.#destroyed;
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
    adapter.onClose((info) => this.#socketClosed$.next(info));
    this.adapter = adapter;
    return adapter;
  }

  /** 의도 하나를 발행하고, 그 결과를 Promise 로 돌려준다. */
  #intend(kind: Intent["kind"]): Promise<void> {
    const done = new Subject<void>();
    // 발행보다 구독이 먼저다. 밀려나서 값 없이 complete 되면 조용히 resolve 된다.
    const settled = firstValueFrom(done, { defaultValue: undefined });
    this.#intent$.next({ kind, done });
    return settled.then(() => undefined);
  }

  /** 의도 하나의 실행. 목표에 도달한 시점(첫 emit)에 호출자의 Promise 를 풀어준다. */
  #run(intent: Intent): Observable<never> {
    const flow = intent.kind === "connect" ? this.#session() : this.#close();
    return flow.pipe(
      tap({
        next: () => intent.done.complete(),
        error: (error: unknown) => intent.done.error(toError(error)),
      }),
      // 에러는 done 과 error$ 로 이미 나갔다. 의도 스트림 자체는 죽으면 안 된다.
      catchError(() => EMPTY),
      finalize(() => intent.done.complete()),
      ignoreElements(),
    );
  }

  /**
   * 연결 하나의 수명.
   *
   *   시도(백오프 재시도 포함) → OPEN → 소켓이 닫힐 때까지 유지 → (repeat) 다시 시도
   *
   * 이 Observable 이 구독돼 있는 동안만 연결을 소유한다. 구독이 끊기면 finalize 가 abort 하고,
   * 어댑터가 소켓을 놓는다. OPEN 도달 시 값 하나를 emit 해서 connect() 의 Promise 를 푼다.
   */
  #session(): Observable<void> {
    return defer(() => {
      const previous = this.connectionState;
      if (previous !== ConnectionState.IDLE && previous !== ConnectionState.CLOSED) {
        return EMPTY;
      }

      const adapter = this.ensureAdapter();
      const lifetime = new AbortController();
      // 첫 시도인지 재연결인지만 구분하는 지역 상태. 이 흐름 밖으로 나가지 않는다.
      let reconnecting = false;

      return defer(() => {
        this.#setState(reconnecting ? ConnectionState.RECONNECTING : ConnectionState.CONNECTING);
        // onBeforeConnect 만 연결을 거부(throw)할 수 있다. 거부되면 상태를 되돌리고 그대로 던진다.
        return from(this.dispatch("onBeforeConnect")).pipe(
          catchError((error) => {
            this.#setState(previous);
            return throwError(() => toError(error));
          }),
          switchMap(() => this.#attempts(adapter, lifetime.signal)),
        );
      }).pipe(
        switchMap(() => {
          reconnecting = true;
          return concat(this.#opened(), this.#untilClosed());
        }),
        // 소켓이 닫히면 위 흐름이 complete 한다 → 같은 정책으로 다시 시도한다.
        repeat(),
        finalize(() => lifetime.abort()),
      );
    });
  }

  /**
   * adapter.connect() 를 ReconnectConfig 대로 재시도한다.
   * - maxAttempts 는 "첫 시도를 제외한" 재시도 횟수다 (총 시도 = 1 + maxAttempts).
   * - 재시도 대기 시작 시 RECONNECTING 으로 바꾸고 reconnectAttempt$ 를 emit 한다.
   * - 전부 실패하면 CLOSED 로 가고 maxReconnectReached$ / error$ 로 알린 뒤 에러를 던진다.
   */
  #attempts(adapter: TAdapter, signal: AbortSignal): Observable<void> {
    return defer(() => from(adapter.connect(signal))).pipe(
      retry({
        count: this.#reconnect.maxAttempts,
        delay: (_error, retryCount) => {
          this.#reconnectAttempts = retryCount;
          this.#setState(ConnectionState.RECONNECTING);
          this.#reconnectAttemptSubject.next(this.reconnectInfo);
          return timer(nextReconnectDelay(this.#reconnect, retryCount));
        },
      }),
      catchError((cause) => {
        // 각 시도의 원인 에러는 어댑터 onError 콜백을 통해 이미 error$ 로 나갔다.
        // 여기선 "재시도 소진" 이라는 별개 사건을 한 번만 알린다 (같은 에러 중복 emit 방지).
        const failure = new Error(
          `Maximum reconnection attempts (${this.#reconnect.maxAttempts}) reached`,
          { cause },
        );
        return concat(
          defer(() => {
            this.#setState(ConnectionState.CLOSED);
            this.#maxReconnectReachedSubject.next();
            return from(this.#emitError(failure));
          }).pipe(ignoreElements()),
          throwError(() => failure),
        );
      }),
    );
  }

  /** 연결 성립 확정. 상태/이벤트/훅을 처리하고 "열렸다" 는 값 하나를 emit 한다. */
  #opened(): Observable<void> {
    return defer(() => {
      this.#reconnectAttempts = 0;
      this.#setState(ConnectionState.OPEN);
      this.#connectSubject.next();
      // 연결은 이미 성립했다. 플러그인 실패가 연결을 실패로 만들면 안 되므로 error$ 로만 흘린다.
      return from(this.#dispatchSafe("onAfterConnect"));
    });
  }

  /** 소켓이 닫힐 때까지 연결을 유지한다. 닫히면 알리고 complete — 다음 재시도로 넘어간다. */
  #untilClosed(): Observable<never> {
    return this.#socketClosed$.pipe(
      take(1),
      tap((info) => this.#disconnectSubject.next({ ...info, manual: false })),
      ignoreElements(),
    );
  }

  /**
   * 종료. 상태는 여기서 확정한다 — 끊는 건 로컬 결정이라 브로커 응답을 기다리지 않는다.
   * 세션 흐름은 이 의도가 들어온 순간 이미 구독 해제됐고, 그 finalize 의 abort 가 소켓을 놓는다.
   * 여기서 다시 부르는 adapter.disconnect() 는 그 정리가 끝났음을 확인하는 멱등 호출이다.
   */
  #close(): Observable<void> {
    return defer(() => {
      const state = this.connectionState;
      if (state === ConnectionState.IDLE || state === ConnectionState.CLOSED) {
        return EMPTY;
      }

      this.#reconnectAttempts = 0;
      this.#setState(ConnectionState.IDLE);

      return from(this.adapter?.disconnect() ?? Promise.resolve()).pipe(
        tap(() => this.#disconnectSubject.next({ manual: true })),
      );
    });
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

  /** 훅을 가진 플러그인에게만 전달한다. 어떤 클래스인지는 보지 않는다. */
  private async dispatch(hook: PluginHook): Promise<void> {
    for (const plugin of this.#plugins.values()) {
      await plugin[hook]?.();
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
      await plugin.onError?.(error);
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
