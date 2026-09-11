import { EMPTY, map, type Observable, type Subscription } from "rxjs";
import type { DisconnectInfo } from "../core/CloseInfo";
import type { ConnectionState } from "../core/ConnectionState";
import type { NetworkClient } from "../core/NetworkClient";
import { createProtocolClient } from "../core/protocolRegistry";
// 워커 안에서도 순수 WebSocket 은 기본으로 쓸 수 있어야 한다.
import "../core/windowProtocol";
import type { ReconnectInfo } from "../core/Reconnect";
import type {
  MessageLike,
  WireMessage,
  WorkerClientConfig,
  WorkerCommand,
  WorkerEvent,
} from "./protocol";

/**
 * 허브가 다루는 클라이언트의 최소 계약. 프로토콜 차이는 팩토리가 흡수한다 —
 * 데모의 RoomTransport, 계약 테스트의 드라이버와 같은 경계다.
 */
export interface HubClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: string, options?: unknown): void;
  /** 연결이 살아 있는지 확인. 죽었으면 클라이언트가 재연결을 시작한다. */
  revalidate(timeoutMs?: number): Promise<boolean>;
  /** destination 기반 프로토콜만 제공한다. 순수 WebSocket 은 undefined. */
  subscribe?(destination: string, options?: unknown): Observable<WireMessage>;
  readonly connectionChanges$: Observable<ConnectionState>;
  readonly connect$: Observable<void>;
  readonly disconnect$: Observable<DisconnectInfo>;
  readonly error$: Observable<Error>;
  readonly message$: Observable<WireMessage>;
  readonly reconnectAttempt$: Observable<ReconnectInfo>;
  readonly maxReconnectReached$: Observable<void>;
  readonly connectionState: ConnectionState;
}

export type HubClientFactory = (config: WorkerClientConfig) => HubClient;

/** key 로 공유되는 연결 하나. */
interface Connection {
  client: HubClient;
  /** 이 연결을 쓰는 손잡이들 */
  readonly handles: Set<string>;
  /** 지금 연결을 원하는 손잡이들. 비면 소켓을 닫는다. */
  readonly wanted: Set<string>;
}

/** 포트 하나가 연 손잡이. */
interface Handle {
  key: string;
  port: MessageLike;
  /** 이 손잡이에서 마지막으로 소식이 온 시각(ms). 넘기면 죽은 것으로 본다. */
  lastSeen: number;
  readonly streams: Subscription[];
  readonly subscriptions: Map<string, Subscription>;
}

export interface WorkerHubOptions {
  /**
   * 이 시간 동안 손잡이에서 아무 소식이 없으면 죽은 것으로 보고 걷어낸다. 기본 60000ms.
   *
   * 페이지는 `ping` 을 주기적으로 보내지만, 백그라운드 탭에서는 타이머가 조여진다
   * (모바일 사파리는 아예 얼린다). 살아 있는 탭을 잘못 걷어내지 않도록 넉넉히 잡는다 —
   * 잘못 걷어내도 페이지가 `stale` 을 받고 다시 열지만, 그 사이 메시지를 놓친다.
   */
  staleAfterMs?: number;
  /** 걷어내기를 돌리는 주기. 기본 15000ms. 손잡이가 하나도 없으면 타이머도 없다. */
  sweepIntervalMs?: number;
  /** 시계. 테스트가 끼워 넣는다. 기본 `Date.now`. */
  now?: () => number;
}

/**
 * 워커 안에서 연결을 소유하는 허브.
 *
 * 공유 규칙: 같은 key 를 요청한 손잡이들은 연결 하나를 함께 쓴다. SharedWorker 에서 탭이 여러 개여도
 * 소켓은 하나라는 뜻이다. 그래서 connect/disconnect 는 "내가 연결을 원한다/원하지 않는다" 는
 * 의사 표시로 해석한다 — 한 탭이 끊었다고 다른 탭의 연결까지 끊으면 안 된다.
 * 마지막으로 원하는 손잡이가 사라질 때만 실제로 닫는다.
 */
export class WorkerHub {
  readonly #connections = new Map<string, Connection>();
  readonly #handles = new Map<string, Handle>();
  readonly #createClient: HubClientFactory;
  readonly #staleAfterMs: number;
  readonly #sweepIntervalMs: number;
  readonly #now: () => number;
  /** 걷어내기 타이머. 손잡이가 있을 때만 돈다. */
  #sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(
    createClient: HubClientFactory = defaultClientFactory,
    options: WorkerHubOptions = {},
  ) {
    this.#createClient = createClient;
    this.#staleAfterMs = options.staleAfterMs ?? 60_000;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? 15_000;
    this.#now = options.now ?? Date.now;
  }

  /** 포트 하나를 붙인다. 포트가 보내는 명령을 처리하고, 포트가 닫히면 그 손잡이들을 정리한다. */
  public attach(port: MessageLike): () => void {
    const listener = (event: MessageEvent) => {
      this.handle(event.data as WorkerCommand, port);
    };
    port.addEventListener("message", listener);
    port.start?.();

    return () => {
      port.removeEventListener?.("message", listener);
      for (const [handleId, handle] of this.#handles) {
        if (handle.port === port) this.#release(handleId);
      }
    };
  }

  /** 명령 하나를 처리한다. 포트 없이도 부를 수 있어 테스트가 쉽다. */
  public handle(command: WorkerCommand, port: MessageLike): void {
    // 어떤 명령이든 그 손잡이가 살아 있다는 증거다. ping 은 주고받을 게 없을 때를 위한 것이다.
    this.#touch(command.handle);

    switch (command.type) {
      case "open":
        this.#open(command.handle, command.key, command.config, port);
        return;
      case "release":
        this.#release(command.handle);
        return;
      case "ping":
        return;
      case "connect":
        void this.#connect(command.handle, command.command);
        return;
      case "disconnect":
        void this.#disconnect(command.handle, command.command);
        return;
      case "send":
        this.#send(command.handle, command.command, command.data, command.options);
        return;
      case "revalidate":
        void this.#revalidate(command.handle, command.command, command.timeoutMs);
        return;
      case "subscribe":
        this.#subscribe(command.handle, command.subscription, command.destination, command.options);
        return;
      case "unsubscribe":
        this.#unsubscribe(command.handle, command.subscription);
        return;
    }
  }

  /** 지금 살아 있는 연결 수. 공유가 실제로 되는지 확인하는 값. */
  public get connectionCount(): number {
    return this.#connections.size;
  }

  /** 지금 열려 있는 손잡이 수. 걷어내기가 실제로 도는지 확인하는 값. */
  public get handleCount(): number {
    return this.#handles.size;
  }

  /**
   * 소식이 끊긴 손잡이를 걷어낸다. 타이머가 주기적으로 부르고, 테스트는 직접 부른다.
   *
   * 걷어내기 전에 `stale` 을 보낸다 — 포트가 진짜 죽었으면 아무도 못 받고, 얼어 있다 깨어난
   * 페이지는 그걸 보고 같은 아이디로 다시 연다.
   */
  public sweep(): void {
    const deadline = this.#now() - this.#staleAfterMs;
    for (const [handleId, handle] of [...this.#handles]) {
      if (handle.lastSeen > deadline) continue;
      handle.port.postMessage({ type: "stale", handle: handleId } satisfies WorkerEvent);
      this.#release(handleId);
    }
  }

  #open(handleId: string, key: string, config: WorkerClientConfig, port: MessageLike): void {
    if (this.#handles.has(handleId)) return;

    let connection = this.#connections.get(key);
    if (!connection) {
      connection = { client: this.#createClient(config), handles: new Set(), wanted: new Set() };
      this.#connections.set(key, connection);
    }
    connection.handles.add(handleId);

    const handle: Handle = {
      key,
      port,
      lastSeen: this.#now(),
      streams: [],
      subscriptions: new Map(),
    };
    this.#handles.set(handleId, handle);
    this.#startSweeping();

    const send = (event: WorkerEvent) => port.postMessage(event);
    const { client } = connection;

    handle.streams.push(
      client.connectionChanges$.subscribe((state) =>
        send({ type: "state", handle: handleId, state }),
      ),
      client.connect$.subscribe(() => send({ type: "opened", handle: handleId })),
      client.disconnect$.subscribe((info) => send({ type: "closed", handle: handleId, info })),
      client.error$.subscribe((error) =>
        send({ type: "error", handle: handleId, name: error.name, message: error.message }),
      ),
      client.message$.subscribe((message) => send({ type: "message", handle: handleId, message })),
      client.reconnectAttempt$.subscribe((info) =>
        send({ type: "reconnect", handle: handleId, info }),
      ),
      client.maxReconnectReached$.subscribe(() => send({ type: "exhausted", handle: handleId })),
    );
  }

  /** 손잡이가 살아 있다는 것을 기록한다. 모르는 손잡이는 조용히 넘긴다(open 이 아직 안 왔다). */
  #touch(handleId: string): void {
    const handle = this.#handles.get(handleId);
    if (handle) handle.lastSeen = this.#now();
  }

  #startSweeping(): void {
    if (this.#sweeper !== undefined) return;
    this.#sweeper = setInterval(() => this.sweep(), this.#sweepIntervalMs);
    // 워커가 이 타이머 하나 때문에 살아 있을 이유는 없다 (Node/Bun 환경에서만 의미가 있다).
    (this.#sweeper as { unref?: () => void }).unref?.();
  }

  #stopSweeping(): void {
    if (this.#sweeper === undefined) return;
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }

  #release(handleId: string): void {
    const handle = this.#handles.get(handleId);
    if (!handle) return;
    this.#handles.delete(handleId);
    if (this.#handles.size === 0) this.#stopSweeping();

    for (const stream of handle.streams) stream.unsubscribe();
    for (const subscription of handle.subscriptions.values()) subscription.unsubscribe();

    const connection = this.#connections.get(handle.key);
    if (!connection) return;
    connection.handles.delete(handleId);
    connection.wanted.delete(handleId);

    if (connection.handles.size === 0) {
      this.#connections.delete(handle.key);
      void connection.client.disconnect();
      return;
    }
    if (connection.wanted.size === 0) {
      void connection.client.disconnect();
    }
  }

  async #connect(handleId: string, commandId: string): Promise<void> {
    const found = this.#find(handleId);
    if (!found) return;
    const { handle, connection } = found;

    connection.wanted.add(handleId);
    try {
      await connection.client.connect();
      this.#ack(handleId, handle, commandId);
    } catch (error) {
      this.#ack(handleId, handle, commandId, error);
    }
  }

  async #disconnect(handleId: string, commandId: string): Promise<void> {
    const found = this.#find(handleId);
    if (!found) return;
    const { handle, connection } = found;

    connection.wanted.delete(handleId);
    // 아직 이 연결을 원하는 손잡이가 남아 있으면 소켓은 그대로 둔다.
    if (connection.wanted.size > 0) {
      this.#ack(handleId, handle, commandId);
      return;
    }

    try {
      await connection.client.disconnect();
      this.#ack(handleId, handle, commandId);
    } catch (error) {
      this.#ack(handleId, handle, commandId, error);
    }
  }

  #send(handleId: string, commandId: string, data: string, options?: unknown): void {
    const found = this.#find(handleId);
    if (!found) return;
    try {
      found.connection.client.send(data, options);
      this.#ack(handleId, found.handle, commandId);
    } catch (error) {
      this.#ack(handleId, found.handle, commandId, error);
    }
  }

  async #revalidate(handleId: string, commandId: string, timeoutMs?: number): Promise<void> {
    const found = this.#find(handleId);
    if (!found) return;
    const alive = await found.connection.client.revalidate(timeoutMs);
    found.handle.port.postMessage({
      type: "ack",
      handle: handleId,
      command: commandId,
      alive,
    } satisfies WorkerEvent);
  }

  #subscribe(
    handleId: string,
    subscriptionId: string,
    destination: string,
    options?: unknown,
  ): void {
    const found = this.#find(handleId);
    if (!found) return;
    const { handle, connection } = found;

    const stream = connection.client.subscribe?.(destination, options);
    if (!stream) {
      handle.port.postMessage({
        type: "error",
        handle: handleId,
        name: "UnsupportedOperation",
        message: "this protocol has no destination subscribe",
      } satisfies WorkerEvent);
      return;
    }

    handle.subscriptions.set(
      subscriptionId,
      stream.subscribe((message) =>
        handle.port.postMessage({
          type: "subscription",
          handle: handleId,
          subscription: subscriptionId,
          message,
        } satisfies WorkerEvent),
      ),
    );
  }

  #unsubscribe(handleId: string, subscriptionId: string): void {
    const handle = this.#handles.get(handleId);
    handle?.subscriptions.get(subscriptionId)?.unsubscribe();
    handle?.subscriptions.delete(subscriptionId);
  }

  #find(handleId: string): { handle: Handle; connection: Connection } | undefined {
    const handle = this.#handles.get(handleId);
    if (!handle) return undefined;
    const connection = this.#connections.get(handle.key);
    if (!connection) return undefined;
    return { handle, connection };
  }

  #ack(handleId: string, handle: Handle, commandId: string, error?: unknown): void {
    const message: WorkerEvent = {
      type: "ack",
      handle: handleId,
      command: commandId,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    };
    handle.port.postMessage(message);
  }
}

/**
 * 설정을 실제 클라이언트로 바꾼다.
 *
 * 프로토콜 구현은 등록소에서 가져온다 — 허브가 세 프로토콜을 직접 참조하면, 워커 번들이
 * 쓰지도 않는 라이브러리를 끌고 들어온다. 워커 파일에서 `import "ws-pack/worker/stomp"` 처럼
 * 필요한 것만 등록한다.
 */
export function defaultClientFactory(config: WorkerClientConfig): HubClient {
  const client = createProtocolClient(config.protocol, config.options) as ProtocolClient;

  switch (config.protocol) {
    case "window":
      return withMessages(client, client.message$.pipe(map((body) => ({ body: String(body) }))));
    case "stomp":
      return withMessages(
        client,
        client.message$.pipe(map((message) => toWireMessage(message as StompLike))),
        (destination, options) =>
          client
            .subscribe?.(destination, options)
            .pipe(map((message) => toWireMessage(message as StompLike))) ?? EMPTY,
      );
    case "mqtt":
      return withMessages(
        client,
        client.message$.pipe(map((message) => toMqttWire(message as MqttLike))),
        (destination, options) =>
          client.subscribe?.(destination, options).pipe(map((m) => toMqttWire(m as MqttLike))) ??
          EMPTY,
      );
  }
}

/** 등록소가 돌려주는 클라이언트에서 허브가 쓰는 부분만 좁혀 본다. */
type ProtocolClient = NetworkClient<unknown, never> & {
  subscribe?: (destination: string, options?: unknown) => Observable<unknown>;
};

interface StompLike {
  body: string;
  headers: Record<string, string>;
}

interface MqttLike {
  body: string;
  topic: string;
}

function toMqttWire(message: MqttLike): WireMessage {
  return { body: message.body, destination: message.topic };
}

/** 프로토콜별 클라이언트를 HubClient 모양으로 맞춘다. */
function withMessages(
  client: ProtocolClient,
  message$: Observable<WireMessage>,
  subscribe?: (destination: string, options?: unknown) => Observable<WireMessage>,
): HubClient {
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    send: (data, options) =>
      (client.send as (data: string, options?: unknown) => void)(data, options),
    revalidate: (timeoutMs) => client.revalidate(timeoutMs),
    subscribe,
    connectionChanges$: client.connectionChanges$,
    connect$: client.connect$,
    disconnect$: client.disconnect$,
    error$: client.error$,
    message$,
    reconnectAttempt$: client.reconnectAttempt$,
    maxReconnectReached$: client.maxReconnectReached$,
    get connectionState() {
      return client.connectionState;
    },
  };
}

function toWireMessage(message: { body: string; headers: Record<string, string> }): WireMessage {
  return {
    body: message.body,
    destination: message.headers.destination,
    headers: message.headers,
  };
}
