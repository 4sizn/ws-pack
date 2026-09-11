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
  readonly #subscribers = new Map<string, Subject<WireMessage>>();

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

  constructor(
    target: Worker | SharedWorker | MessagePort,
    config: WorkerClientConfig,
    options: WorkerWebSocketClientOptions = {},
  ) {
    assertCloneable(config);

    this.#port = toPort(target);
    this.#port.addEventListener("message", (event) => this.#receive(event.data as WorkerEvent));
    this.#port.start?.();

    this.#post({
      type: "open",
      handle: this.#handle,
      key: options.key ?? JSON.stringify(config),
      config,
    });
  }

  public connect(): Promise<void> {
    if (this.#destroyed) {
      return Promise.reject(new Error("WorkerWebSocketClient has been destroyed"));
    }
    return this.#request((command) => ({ type: "connect", handle: this.#handle, command }));
  }

  public disconnect(): Promise<void> {
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
      this.#subscribers.set(id, subject);
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
        this.#subscribers.delete(id);
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

    this.#post({ type: "release", handle: this.#handle });
    for (const subject of this.#subscribers.values()) subject.complete();
    this.#subscribers.clear();

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
        this.#subscribers.get(event.subscription)?.next(event.message);
        return;
      case "reconnect":
        this.#reconnect = event.info;
        this.#reconnectSubject.next(event.info);
        return;
      case "exhausted":
        this.#exhaustedSubject.next();
        return;
    }
  }
}

/**
 * 워커로 볼 설정에 복제 불가능한 값이 있는지 확인한다.
 *
 * `url`/`brokerURL`/`username`/`password` 는 Resolvable 로 함수를 받을 수 있지만,
 * 워커 경로는 `postMessage` 를 타므로 함수가 복제되지 않는다. 조용히 잘리기 전에 명확히 실패한다.
 */
function assertCloneable(config: WorkerClientConfig): void {
  const options = config.options as Record<string, unknown>;
  for (const key of ["url", "brokerURL", "username", "password"] as const) {
    if (typeof options[key] === "function") {
      throw new Error(
        `${config.protocol}.${key}에 함수를 넘길 수 없다. 워커 경로는 구조화 복제(structured clone)를 타므로 팩토리 대신 문자열/값을 사용한다.`,
      );
    }
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
