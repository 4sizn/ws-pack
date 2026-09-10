import { map, type Observable, type Subscription } from "rxjs";
import type { DisconnectInfo } from "../core/CloseInfo";
import type { ConnectionState } from "../core/ConnectionState";
import type { ReconnectInfo } from "../core/Reconnect";
import {
  MqttWebSocketClient,
  StompWebSocketClient,
  WindowWebSocketClient,
} from "../core/WebSocketClient";
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
  readonly streams: Subscription[];
  readonly subscriptions: Map<string, Subscription>;
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

  constructor(createClient: HubClientFactory = defaultClientFactory) {
    this.#createClient = createClient;
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
    switch (command.type) {
      case "open":
        this.#open(command.handle, command.key, command.config, port);
        return;
      case "release":
        this.#release(command.handle);
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

  #open(handleId: string, key: string, config: WorkerClientConfig, port: MessageLike): void {
    if (this.#handles.has(handleId)) return;

    let connection = this.#connections.get(key);
    if (!connection) {
      connection = { client: this.#createClient(config), handles: new Set(), wanted: new Set() };
      this.#connections.set(key, connection);
    }
    connection.handles.add(handleId);

    const handle: Handle = { key, port, streams: [], subscriptions: new Map() };
    this.#handles.set(handleId, handle);

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

  #release(handleId: string): void {
    const handle = this.#handles.get(handleId);
    if (!handle) return;
    this.#handles.delete(handleId);

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

/** 설정을 실제 클라이언트로 바꾼다. 프로토콜 타입이 등장하는 유일한 곳. */
export function defaultClientFactory(config: WorkerClientConfig): HubClient {
  switch (config.protocol) {
    case "window": {
      const client = new WindowWebSocketClient(config.options);
      return withMessages(client, client.message$.pipe(map((body) => ({ body }))));
    }
    case "stomp": {
      const client = new StompWebSocketClient(config.options);
      return withMessages(
        client,
        client.message$.pipe(map(toWireMessage)),
        (destination, options) =>
          client
            .subscribe(destination, options as Parameters<typeof client.subscribe>[1])
            .pipe(map(toWireMessage)),
      );
    }
    case "mqtt": {
      const client = new MqttWebSocketClient(config.options);
      return withMessages(
        client,
        client.message$.pipe(
          map((message) => ({ body: message.body, destination: message.topic })),
        ),
        (destination, options) =>
          client
            .subscribe(destination, options as Parameters<typeof client.subscribe>[1])
            .pipe(map((message) => ({ body: message.body, destination: message.topic }))),
      );
    }
  }
}

/** 프로토콜별 클라이언트를 HubClient 모양으로 맞춘다. */
function withMessages(
  client: {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(data: string, ...args: never[]): void;
    connectionChanges$: Observable<ConnectionState>;
    connect$: Observable<void>;
    disconnect$: Observable<DisconnectInfo>;
    error$: Observable<Error>;
    reconnectAttempt$: Observable<ReconnectInfo>;
    maxReconnectReached$: Observable<void>;
    connectionState: ConnectionState;
  },
  message$: Observable<WireMessage>,
  subscribe?: (destination: string, options?: unknown) => Observable<WireMessage>,
): HubClient {
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    send: (data, options) =>
      (client.send as (data: string, options?: unknown) => void)(data, options),
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
