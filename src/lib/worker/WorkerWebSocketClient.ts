import { Observable, Subject } from "rxjs";
import type { DisconnectInfo } from "../core/CloseInfo";
import { ConnectionState } from "../core/ConnectionState";
import type { NetworkClient } from "../core/NetworkClient";
import type { PubSubAble } from "../core/PubSubAble";
import type { ReconnectInfo } from "../core/Reconnect";
import { randomId } from "../core/randomId";
import type {
  MessageLike,
  WireMessage,
  WorkerClientConfig,
  WorkerCommand,
  WorkerEvent,
} from "./protocol";

export interface WorkerWebSocketClientOptions {
  /**
   * 연결 공유 키. SharedWorker 에서 같은 키를 쓰는 페이지들은 소켓 하나를 함께 쓴다.
   * 기본값은 설정을 직렬화한 값이라, 같은 설정이면 저절로 공유된다.
   */
  key?: string;
  /**
   * 살아 있다는 신호를 워커로 보내는 주기(ms). 기본 15000. `0` 이면 보내지 않는다.
   *
   * SharedWorker 는 포트가 닫혔다는 이벤트를 주지 않는다 — 탭이 크래시하거나 모바일에서
   * 회수되면 `destroy()` 가 불리지 않고, 허브는 그 손잡이를 영원히 들고 있게 된다.
   * 이 신호가 끊기면 허브가 손잡이를 걷어내고 아무도 안 쓰는 소켓을 닫는다.
   */
  pingIntervalMs?: number;
}

/**
 * 워커 안에서 도는 클라이언트의 페이지 쪽 손잡이.
 *
 * 소비자가 워커를 직접 만들어 넘긴다 — 번들러마다 워커 URL 을 다루는 방식이 달라서, 그 선택을
 * 라이브러리가 대신하면 안 된다.
 *
 * ```ts
 * const worker = new SharedWorker(new URL("ws-pack/worker", import.meta.url), { type: "module" });
 * const client = new WorkerWebSocketClient(worker, { protocol: "stomp", options: { brokerURL } });
 * ```
 *
 * 공유 연결에서 `disconnect()` 는 "이 페이지는 더 이상 연결을 원하지 않는다" 는 뜻이다.
 * 같은 키를 쓰는 다른 페이지가 남아 있으면 소켓은 유지된다.
 */
export class WorkerWebSocketClient
  implements NetworkClient<WireMessage, unknown>, PubSubAble<WireMessage, unknown>
{
  readonly #port: MessageLike;
  readonly #handle = randomId();
  readonly #pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  readonly #answers = new Map<
    string,
    { resolve: (alive: boolean) => void; reject: (error: Error) => void }
  >();
  /** 구독. `stale` 이후 같은 구독을 다시 열 수 있게 destination 까지 들고 있는다. */
  readonly #subscriptions = new Map<
    string,
    { subject: Subject<WireMessage>; destination: string; options?: unknown }
  >();
  readonly #config: WorkerClientConfig;
  readonly #key: string;
  readonly #pingIntervalMs: number;

  readonly #connectionState$ = new Subject<ConnectionState>();
  readonly #connectSubject = new Subject<void>();
  readonly #disconnectSubject = new Subject<DisconnectInfo>();
  readonly #errorSubject = new Subject<Error>();
  readonly #messageSubject = new Subject<WireMessage>();
  readonly #reconnectSubject = new Subject<ReconnectInfo>();
  readonly #exhaustedSubject = new Subject<void>();

  #state: ConnectionState = ConnectionState.IDLE;
  #reconnect: ReconnectInfo = { attempts: 0, maxAttempts: 0, isReconnecting: false };
  #commands = 0;
  #destroyed = false;
  /**
   * 이 페이지가 연결을 원하는가. 허브의 `wanted` 와 같은 뜻이고, 손잡이를 다시 열 때 복원한다.
   * 연결 상태(`#state`)와 다른 값이다 — 원하지만 아직 끊겨 있을 수 있다.
   */
  #wanted = false;
  #ping: ReturnType<typeof setInterval> | undefined;
  #lifecycle: (() => void) | undefined;

  constructor(
    target: Worker | SharedWorker | MessagePort,
    config: WorkerClientConfig,
    options: WorkerWebSocketClientOptions = {},
  ) {
    this.#port = toPort(target);
    this.#config = config;
    this.#key = options.key ?? JSON.stringify(config);
    this.#pingIntervalMs = options.pingIntervalMs ?? 15_000;
    this.#port.addEventListener("message", (event) => this.#receive(event.data as WorkerEvent));
    this.#port.start?.();

    this.#post({ type: "open", handle: this.#handle, key: this.#key, config });
    this.#startPing();
    this.#watchPageLifecycle();
  }

  public connect(): Promise<void> {
    if (this.#destroyed) {
      return Promise.reject(new Error("WorkerWebSocketClient has been destroyed"));
    }
    this.#wanted = true;
    return this.#request((command) => ({ type: "connect", handle: this.#handle, command }));
  }

  public disconnect(): Promise<void> {
    this.#wanted = false;
    return this.#request((command) => ({ type: "disconnect", handle: this.#handle, command }));
  }

  /**
   * 전송. 워커까지 갔다 오므로 실패는 반환된 Promise 로만 알 수 있다 —
   * 같은 프로세스의 클라이언트가 즉시 throw 하는 것과 다른 점이다.
   */
  public send(data: string, options?: unknown): Promise<void> {
    return this.#request((command) => ({
      type: "send",
      handle: this.#handle,
      command,
      data,
      options,
    }));
  }

  /**
   * 워커에게 연결 확인을 시킨다. 확인 자체는 소켓을 쥔 워커가 하고, 결과만 건너온다.
   */
  public async revalidate(timeoutMs?: number): Promise<boolean> {
    if (this.#destroyed) return false;
    return this.#ask((command) => ({
      type: "revalidate",
      handle: this.#handle,
      command,
      timeoutMs,
    }));
  }

  /** destination 구독 (STOMP/MQTT). unsubscribe 하면 워커 쪽 구독도 풀린다. */
  public subscribe(destination: string, options?: unknown): Observable<WireMessage> {
    return new Observable<WireMessage>((observer) => {
      const id = randomId();
      const subject = new Subject<WireMessage>();
      this.#subscriptions.set(id, { subject, destination, options });
      const inner = subject.subscribe(observer);

      this.#post({
        type: "subscribe",
        handle: this.#handle,
        subscription: id,
        destination,
        options,
      });

      return () => {
        inner.unsubscribe();
        this.#subscriptions.delete(id);
        this.#post({ type: "unsubscribe", handle: this.#handle, subscription: id });
      };
    });
  }

  /**
   * 이 손잡이를 놓는다. 마지막 사용자면 워커가 연결도 닫는다.
   * 직접 연결 클라이언트의 destroy() 와 같은 자리다 — 소비자 코드가 둘을 갈아 끼울 수 있어야 한다.
   */
  public destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    this.#stopPing();
    this.#lifecycle?.();
    this.#lifecycle = undefined;

    this.#post({ type: "release", handle: this.#handle });
    for (const entry of this.#subscriptions.values()) entry.subject.complete();
    this.#subscriptions.clear();

    this.#connectionState$.complete();
    this.#connectSubject.complete();
    this.#disconnectSubject.complete();
    this.#errorSubject.complete();
    this.#messageSubject.complete();
    this.#reconnectSubject.complete();
    this.#exhaustedSubject.complete();
  }

  public get connectionState(): ConnectionState {
    return this.#state;
  }

  public get reconnectInfo(): ReconnectInfo {
    return this.#reconnect;
  }

  public get connectionState$(): Observable<ConnectionState> {
    return this.#connectionState$.asObservable();
  }

  public get connectionChanges$(): Observable<ConnectionState> {
    return this.#connectionState$.asObservable();
  }

  public get connect$(): Observable<void> {
    return this.#connectSubject.asObservable();
  }

  public get disconnect$(): Observable<DisconnectInfo> {
    return this.#disconnectSubject.asObservable();
  }

  public get error$(): Observable<Error> {
    return this.#errorSubject.asObservable();
  }

  public get message$(): Observable<WireMessage> {
    return this.#messageSubject.asObservable();
  }

  public get reconnectAttempt$(): Observable<ReconnectInfo> {
    return this.#reconnectSubject.asObservable();
  }

  public get maxReconnectReached$(): Observable<void> {
    return this.#exhaustedSubject.asObservable();
  }

  /** ack 의 alive 값을 돌려받는 요청. revalidate 처럼 결과가 있는 명령에 쓴다. */
  #ask(build: (command: string) => WorkerCommand): Promise<boolean> {
    const command = `${this.#handle}:${++this.#commands}`;
    const settled = new Promise<boolean>((resolve, reject) => {
      this.#answers.set(command, { resolve, reject });
    });
    this.#post(build(command));
    return settled;
  }

  #request(build: (command: string) => WorkerCommand): Promise<void> {
    const command = `${this.#handle}:${++this.#commands}`;
    const settled = new Promise<void>((resolve, reject) => {
      this.#pending.set(command, { resolve, reject });
    });
    this.#post(build(command));
    return settled;
  }

  #post(command: WorkerCommand): void {
    this.#port.postMessage(command);
  }

  #receive(event: WorkerEvent): void {
    if (event.handle !== this.#handle) return;

    switch (event.type) {
      case "ack": {
        const answer = this.#answers.get(event.command);
        if (answer) {
          this.#answers.delete(event.command);
          if (event.error) answer.reject(new Error(event.error));
          else answer.resolve(event.alive === true);
          return;
        }
        const pending = this.#pending.get(event.command);
        this.#pending.delete(event.command);
        if (!pending) return;
        if (event.error) pending.reject(new Error(event.error));
        else pending.resolve();
        return;
      }
      case "state":
        this.#state = event.state;
        this.#connectionState$.next(event.state);
        return;
      case "opened":
        this.#connectSubject.next();
        return;
      case "closed":
        this.#disconnectSubject.next(event.info);
        return;
      case "error":
        this.#errorSubject.next(toError(event.name, event.message));
        return;
      case "message":
        this.#messageSubject.next(event.message);
        return;
      case "subscription":
        this.#subscriptions.get(event.subscription)?.subject.next(event.message);
        return;
      case "reconnect":
        this.#reconnect = event.info;
        this.#reconnectSubject.next(event.info);
        return;
      case "exhausted":
        this.#exhaustedSubject.next();
        return;
      case "stale":
        // 허브가 이 손잡이를 걷어냈다. 페이지는 살아 있으므로 같은 아이디로 다시 연다.
        this.#reopen();
        return;
    }
  }

  /**
   * 손잡이를 다시 연다. 걷어내진 뒤(`stale`)와 bfcache 복귀 뒤에 쓴다.
   *
   * 허브는 손잡이만 기억하므로 구독과 연결 의사는 페이지가 복원해야 한다.
   * 스트림 객체는 그대로 둔다 — 소비자가 들고 있는 구독이 끊기면 안 된다.
   */
  #reopen(): void {
    if (this.#destroyed) return;

    this.#post({ type: "open", handle: this.#handle, key: this.#key, config: this.#config });
    for (const [id, entry] of this.#subscriptions) {
      this.#post({
        type: "subscribe",
        handle: this.#handle,
        subscription: id,
        destination: entry.destination,
        options: entry.options,
      });
    }
    if (this.#wanted) {
      // 결과를 기다리는 호출자가 없다. 실패는 error$ 로 나간다.
      this.#post({
        type: "connect",
        handle: this.#handle,
        command: `${this.#handle}:reopen:${++this.#commands}`,
      });
    }
    this.#startPing();
  }

  #startPing(): void {
    if (this.#pingIntervalMs <= 0 || this.#ping !== undefined) return;
    this.#ping = setInterval(() => {
      this.#post({ type: "ping", handle: this.#handle });
    }, this.#pingIntervalMs);
    (this.#ping as { unref?: () => void }).unref?.();
  }

  #stopPing(): void {
    if (this.#ping === undefined) return;
    clearInterval(this.#ping);
    this.#ping = undefined;
  }

  /**
   * 페이지가 사라질 때 손잡이를 놓는다.
   *
   * `beforeunload` 가 아니라 `pagehide` 를 쓴다 — 모바일 사파리는 탭을 백그라운드로 보낼 때
   * `beforeunload` 를 주지 않는다. bfcache 로 들어간 경우(`persisted`)에는 페이지가 되살아날
   * 수 있으므로, 돌아오면 `pageshow` 에서 다시 연다.
   */
  #watchPageLifecycle(): void {
    if (typeof addEventListener !== "function") return;

    const hide = (event: PageTransitionEvent) => {
      if (this.#destroyed) return;
      this.#stopPing();
      this.#post({ type: "release", handle: this.#handle });
      if (!event.persisted) this.#lifecycle?.();
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) this.#reopen();
    };

    addEventListener("pagehide", hide);
    addEventListener("pageshow", show);
    this.#lifecycle = () => {
      removeEventListener("pagehide", hide);
      removeEventListener("pageshow", show);
    };
  }
}

/** Worker 는 자기 자신이 포트, SharedWorker 는 `port` 를 쓴다. */
function toPort(target: Worker | SharedWorker | MessagePort): MessageLike {
  return "port" in target ? (target.port as MessageLike) : (target as MessageLike);
}

/** 워커 너머의 에러는 클래스가 아니라 이름과 메시지로만 건너온다. 이름은 살려 둔다. */
function toError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
