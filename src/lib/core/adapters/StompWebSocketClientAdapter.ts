import {
  type IFrame,
  type IMessage,
  type IPublishParams,
  Client as StompClient,
  type StompConfig,
  type StompHeaders,
  StompSocketState,
  type StompSubscription,
} from "@stomp/stompjs";
import { Observable, type Subscriber } from "rxjs";
import { StompStompError } from "../errors/StompStompError";
import { StompWebsocketError } from "../errors/StompWebsocketError";
import type { PubSubAble } from "../PubSubAble";
import type { AbstractPlugin, Logger } from "../plugins/AbstractPlugin";
import type { ReconnectConfig } from "../Reconnect";
import { WebSocketClientAdapter } from "./WebSocketClientAdapter";

/**
 * 어댑터가 덮어쓰는 stompjs 콜백/재연결 필드. 사용자가 넘겨도 무시되므로 타입에서 뺀다.
 * - reconnectDelay/reconnectTimeMode/maxReconnectDelay: stompjs 자체 재연결은 내부 버그로 끄고
 *   Controller의 ReconnectConfig 로 대체한다.
 * - onConnect 등 콜백: 어댑터가 onConnect/onError/onClose/onMessage 로 변환해 흘린다.
 */
type ManagedStompConfigKeys =
  | "reconnectDelay"
  | "reconnectTimeMode"
  | "maxReconnectDelay"
  | "onConnect"
  | "onDisconnect"
  | "onStompError"
  | "onWebSocketError"
  | "onWebSocketClose"
  | "onUnhandledMessage";

export interface StompWebSocketClientOptions extends Omit<StompConfig, ManagedStompConfigKeys> {
  /** 이미 만들어진 stompjs Client 를 주입. 없으면 어댑터가 내부에서 기본 생성한다. */
  client?: StompClient;
  /** 재연결 정책 (Controller가 소비) */
  reconnect?: ReconnectConfig;
  logger?: Logger;
  plugins?: AbstractPlugin[];
}

/** send(body, options) 의 options. stompjs publish 파라미터에서 body 계열만 뺀 것. */
export type StompSendOptions = Omit<IPublishParams, "body" | "binaryBody">;

interface SubscriptionRecord {
  destination: string;
  headers?: StompHeaders;
  observer: Subscriber<IMessage>;
  /** 현재 stompjs 구독. 재연결되면 새로 갈아끼운다. */
  stompSubscription?: StompSubscription;
}

/**
 * @stomp/stompjs 를 감싸는 어댑터. stompjs 타입이 등장하는 유일한 어댑터 파일.
 *
 * connect() 는 "한 번" 시도한다: CONNECTED 프레임이면 resolve, 그 전에 STOMP ERROR /
 * WebSocket error / close 가 오면 reject. 재시도는 Controller가 한다.
 *
 * subscribe(destination) 로 만든 구독은 어댑터가 기억해서, 재연결 후 CONNECTED 가 오면 자동으로 다시 건다.
 */
export class StompWebSocketClientAdapter
  extends WebSocketClientAdapter<
    StompClient,
    StompWebSocketClientOptions,
    IMessage,
    StompSendOptions
  >
  implements PubSubAble<IMessage, StompHeaders>
{
  readonly #options: StompWebSocketClientOptions;

  readonly #connectCallbacks = new Set<() => void>();
  readonly #messageCallbacks = new Set<(message: IMessage) => void>();
  readonly #errorCallbacks = new Set<(error: Error) => void>();
  readonly #closeCallbacks = new Set<() => void>();

  readonly #subscriptions = new Set<SubscriptionRecord>();

  /**
   * connect() 호출마다 1 증가. 콜백은 자기 세대가 현재 세대일 때만 동작한다 —
   * 이전 시도의 stompjs Client 가 늦게 쏘는 error/close 가 새 시도에 섞이는 걸 막는다.
   */
  #generation = 0;

  constructor(options: StompWebSocketClientOptions) {
    super();
    this.#options = options;
  }

  public async connect(): Promise<void> {
    const {
      client,
      reconnect: _reconnect,
      logger: _logger,
      plugins: _plugins,
      ...stompConfig
    } = this.#options;

    // 소켓을 만들 방법이 하나도 없으면 stompjs 가 async 내부에서 throw 하고 우리 Promise 는 영원히 pending 이 된다. 미리 거른다.
    if (!client && !stompConfig.brokerURL && !stompConfig.webSocketFactory) {
      throw new Error(
        "StompWebSocketClientOptions requires brokerURL, webSocketFactory, or client",
      );
    }

    // 이전 클라이언트가 살아 있으면 먼저 정리 (연결 누수 방지)
    if (this.client?.active) {
      await this.client.deactivate();
    }

    const generation = ++this.#generation;
    const isCurrent = () => generation === this.#generation;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const config: StompConfig = {
        ...stompConfig,
        // stompjs 자체 재연결 비활성화 — Controller가 ReconnectConfig 로 재시도한다.
        reconnectDelay: 0,

        onConnect: (_frame: IFrame) => {
          if (!isCurrent()) return;
          // 재연결이면 살아 있는 구독을 새 세션에 다시 건다
          for (const record of this.#subscriptions) {
            this.#attach(record);
          }
          settle(resolve);
          for (const cb of this.#connectCallbacks) cb();
        },

        onStompError: (frame: IFrame) => {
          if (!isCurrent()) return;
          const error = new StompStompError(frame.headers.message ?? "STOMP ERROR frame", frame);
          for (const cb of this.#errorCallbacks) cb(error);
          settle(() => reject(error));
        },

        onWebSocketError: (event: Event) => {
          if (!isCurrent()) return;
          const error = new StompWebsocketError("WebSocket error", event);
          for (const cb of this.#errorCallbacks) cb(error);
          settle(() => reject(error));
        },

        // 소켓이 닫히는 모든 경우에 한 번 온다 (deactivate 포함). 수동/비수동 판단은 Controller 상태로.
        onWebSocketClose: (event: CloseEvent) => {
          if (!isCurrent()) return;
          settle(() =>
            reject(
              new Error(
                `WebSocket closed before STOMP connected (code=${event.code}, reason=${event.reason})`,
              ),
            ),
          );
          for (const cb of this.#closeCallbacks) cb();
        },

        // 구독 없이 도착한 메시지도 message$ 로 흘린다
        onUnhandledMessage: (message: IMessage) => {
          if (!isCurrent()) return;
          for (const cb of this.#messageCallbacks) cb(message);
        },
      };

      // 주입된 client 가 있으면 그걸 쓰고 설정만 덮어쓴다. 없으면 새로 만든다.
      if (client) {
        client.configure(config);
        this.client = client;
      } else {
        this.client = new StompClient(config);
      }

      try {
        this.client.activate();
      } catch (error) {
        settle(() => reject(error));
      }
    });
  }

  public async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.deactivate();
  }

  /**
   * destination 으로 publish. Controller 가 OPEN 인지 먼저 확인하지만, 어댑터 단에서도 방어한다.
   */
  public send(body: string, options: StompSendOptions): void {
    if (!this.client?.connected) {
      throw new Error("STOMP client is not connected");
    }
    this.client.publish({ ...options, body });
  }

  /**
   * destination 구독. 아직 연결 전이면 CONNECTED 시점에 걸리고, 재연결되면 자동으로 다시 걸린다.
   * 반환 Observable 을 unsubscribe 하면 STOMP 구독도 해제된다.
   *
   * 같은 destination 을 두 번 subscribe 하면 STOMP 구독도 두 개 생기고, 브로커는 프레임을 각각 보낸다.
   * message$ 는 "수신한 프레임 전부" 라서 그 경우 한 발행이 두 번 보인다 — 구독별로 받으려면 반환 Observable 을 쓴다.
   */
  public subscribe(destination: string, headers?: StompHeaders): Observable<IMessage> {
    return new Observable<IMessage>((observer) => {
      const record: SubscriptionRecord = { destination, headers, observer };
      this.#subscriptions.add(record);

      if (this.client?.connected) {
        this.#attach(record);
      }

      return () => {
        this.#subscriptions.delete(record);
        // 연결이 끊긴 뒤의 unsubscribe 는 stompjs 가 throw 하므로 연결 중일 때만
        if (this.client?.connected) {
          record.stompSubscription?.unsubscribe();
        }
        record.stompSubscription = undefined;
      };
    });
  }

  #attach(record: SubscriptionRecord): void {
    if (!this.client?.connected) return;
    record.stompSubscription = this.client.subscribe(
      record.destination,
      (message) => {
        record.observer.next(message);
        for (const cb of this.#messageCallbacks) cb(message);
      },
      record.headers,
    );
  }

  public onConnect(callback: () => void): void {
    this.#connectCallbacks.add(callback);
  }

  public onMessage(callback: (message: IMessage) => void): void {
    this.#messageCallbacks.add(callback);
  }

  public onError(callback: (error: Error) => void): void {
    this.#errorCallbacks.add(callback);
  }

  public onClose(callback: () => void): void {
    this.#closeCallbacks.add(callback);
  }

  /** stompjs 소켓의 readyState (StompSocketState). 소켓이 없으면 CLOSED. */
  public networkStatus(): number {
    return this.client?.webSocket?.readyState ?? StompSocketState.CLOSED;
  }
}
