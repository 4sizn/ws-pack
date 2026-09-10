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
import { onAbort } from "../abort";
import type { SocketCloseInfo } from "../CloseInfo";
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
 * connect(signal) 은 "한 번" 시도한다: CONNECTED 프레임이면 resolve, 그 전에 STOMP ERROR /
 * WebSocket error / close 가 오면 reject. 재시도는 Controller가 한다.
 *
 * 이 연결의 수명은 `signal` 이 정한다. abort 되면 — 시도 중이든 이미 연결됐든 — 소켓을 놓는다.
 * 세대 카운터나 "종료 요청됨" 플래그를 따로 두지 않는 이유: 취소 여부를 판단하는 지점이
 * 여러 개가 되는 순간 어긋나고, 어긋나면 주인 없는 소켓이 남는다.
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
  readonly #closeCallbacks = new Set<(info: SocketCloseInfo) => void>();

  readonly #subscriptions = new Set<SubscriptionRecord>();

  constructor(options: StompWebSocketClientOptions) {
    super();
    this.#options = options;
  }

  public async connect(signal: AbortSignal): Promise<void> {
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

    // 이전 시도가 남긴 소켓을 먼저 놓는다 (연결 누수 방지).
    await this.disconnect();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      // 취소된 시도의 콜백은 흘리지 않는다. 판단 기준은 신호 하나뿐이다.
      const live = () => !signal.aborted;

      const config: StompConfig = {
        ...stompConfig,
        // stompjs 자체 재연결 비활성화 — Controller가 ReconnectConfig 로 재시도한다.
        reconnectDelay: 0,

        onConnect: (_frame: IFrame) => {
          if (!live()) return;
          // 재연결이면 살아 있는 구독을 새 세션에 다시 건다
          for (const record of this.#subscriptions) {
            this.#attach(record);
          }
          settle(resolve);
          for (const cb of this.#connectCallbacks) cb();
        },

        onStompError: (frame: IFrame) => {
          if (!live()) return;
          const error = new StompStompError(frame.headers.message ?? "STOMP ERROR frame", frame);
          for (const cb of this.#errorCallbacks) cb(error);
          settle(() => reject(error));
        },

        onWebSocketError: (event: Event) => {
          if (!live()) return;
          const error = new StompWebsocketError("WebSocket error", event);
          for (const cb of this.#errorCallbacks) cb(error);
          settle(() => reject(error));
        },

        // 소켓이 닫히는 모든 경우에 한 번 온다. 수동/비수동 판단은 Controller 상태로.
        onWebSocketClose: (event: CloseEvent) => {
          if (!live()) return;
          settle(() =>
            reject(
              new Error(
                `WebSocket closed before STOMP connected (code=${event.code}, reason=${event.reason})`,
              ),
            ),
          );
          const info: SocketCloseInfo = {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          };
          for (const cb of this.#closeCallbacks) cb(info);
        },

        // 구독 없이 도착한 메시지도 message$ 로 흘린다
        onUnhandledMessage: (message: IMessage) => {
          if (!live()) return;
          for (const cb of this.#messageCallbacks) cb(message);
        },
      };

      // 주입된 client 가 있으면 그걸 쓰고 설정만 덮어쓴다. 없으면 새로 만든다.
      const stomp = client ?? new StompClient();
      stomp.configure(config);
      this.client = stomp;

      // 연결의 수명 = signal 의 수명. 이미 취소됐다면 activate 자체를 하지 않는다.
      onAbort(signal, () => {
        settle(() => reject(abortReason(signal)));
        void this.#release(stomp);
      });
      if (signal.aborted) return;

      try {
        stomp.activate();
      } catch (error) {
        settle(() => reject(error));
      }
    });
  }

  /**
   * 연결 종료. 소유권을 먼저 놓고, 소켓 정리는 로컬에서 끝낸다. 이미 놓았으면 아무 일도 하지 않는다.
   */
  public async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    await this.#release(client);
  }

  /**
   * 소켓 반납. 두 단계로 나뉘고 순서가 의미를 가진다.
   *
   * 1. 우아한 종료 시도: `deactivate()` 는 DISCONNECT 프레임을 소켓에 쓴다. 그 프레임에 대한
   *    브로커의 RECEIPT 를 기다리는 Promise 는 **의도적으로 await 하지 않는다.** 네트워크가
   *    끊긴 상태에서는 응답이 영원히 오지 않고, 기다리면 종료가 끝나지 않는다.
   * 2. 로컬 폐기: `deactivate({ force: true })` 는 소켓 핸들을 즉시 버린다. 상대와 무관하게
   *    항상 유한 시간에 끝나므로, 이 단계의 완료를 "끊겼다" 의 기준으로 삼는다.
   *
   * `WebSocket.close()` 는 버퍼에 남은 데이터를 먼저 내보내므로, 1번 직후에 폐기해도 프레임은 나간다.
   */
  async #release(client: StompClient): Promise<void> {
    if (this.client === client) {
      this.client = undefined;
    }
    for (const record of this.#subscriptions) {
      record.stompSubscription = undefined;
    }
    void client.deactivate().catch(() => {});
    await client.deactivate({ force: true });
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

  public onClose(callback: (info: SocketCloseInfo) => void): void {
    this.#closeCallbacks.add(callback);
  }

  /** stompjs 소켓의 readyState (StompSocketState). 소켓이 없으면 CLOSED. */
  public networkStatus(): number {
    return this.client?.webSocket?.readyState ?? StompSocketState.CLOSED;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("connect aborted");
}
