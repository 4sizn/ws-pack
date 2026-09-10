import { Observable, Subject } from "rxjs";
import type { DisconnectInfo } from "../core/CloseInfo";
import { ConnectionState } from "../core/ConnectionState";
import type { NetworkClient } from "../core/NetworkClient";
import type { PubSubAble } from "../core/PubSubAble";
import type { ReconnectInfo } from "../core/Reconnect";
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
  readonly #handle = crypto.randomUUID();
  readonly #pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
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

  constructor(
    target: Worker | SharedWorker | MessagePort,
    config: WorkerClientConfig,
    options: WorkerWebSocketClientOptions = {},
  ) {
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

  /** destination 구독 (STOMP/MQTT). unsubscribe 하면 워커 쪽 구독도 풀린다. */
  public subscribe(destination: string, options?: unknown): Observable<WireMessage> {
    return new Observable<WireMessage>((observer) => {
      const id = crypto.randomUUID();
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

  /** 이 손잡이를 놓는다. 마지막 사용자면 워커가 연결도 닫는다. */
  public dispose(): void {
    this.#post({ type: "release", handle: this.#handle });
    for (const subject of this.#subscribers.values()) subject.complete();
    this.#subscribers.clear();
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
