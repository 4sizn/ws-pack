import {
  type IFrame,
  type IMessage,
  Client as StompClient,
  type StompConfig,
  StompSocketState,
} from "@stomp/stompjs";
import { StompStompError } from "../errors/StompStompError";
import { StompWebsocketError } from "../errors/StompWebsocketError";
import type { AbstractPlugin, Logger } from "../plugins/AbstractPlugin";
import type { ReconnectConfig } from "../Reconnect";
import { WebSocketClientAdapter } from "./WebSocketClientAdapter";

/**
 * 어댑터가 덮어쓰는 stompjs 콜백/재연결 필드. 사용자가 넘겨도 무시되므로 타입에서 뺀다.
 * - reconnectDelay/reconnectTimeMode/maxReconnectDelay: stompjs 자체 재연결은 내부 버그로 끄고
 *   Controller의 ReconnectConfig 로 대체한다.
 * - onConnect 등 콜백: 어댑터가 onConnect/onError/onClose 로 변환해 흘린다.
 */
type ManagedStompConfigKeys =
  | "reconnectDelay"
  | "reconnectTimeMode"
  | "maxReconnectDelay"
  | "onConnect"
  | "onDisconnect"
  | "onStompError"
  | "onWebSocketError"
  | "onWebSocketClose";

export interface StompWebSocketClientOptions extends Omit<StompConfig, ManagedStompConfigKeys> {
  /** 이미 만들어진 stompjs Client 를 주입. 없으면 어댑터가 내부에서 기본 생성한다. */
  client?: StompClient;
  /** 재연결 정책 (Controller가 소비) */
  reconnect?: ReconnectConfig;
  logger?: Logger;
  plugins?: AbstractPlugin[];
}

/**
 * @stomp/stompjs 를 감싸는 어댑터. stompjs 타입이 등장하는 유일한 어댑터 파일.
 *
 * connect() 는 "한 번" 시도한다: CONNECTED 프레임이면 resolve, 그 전에 STOMP ERROR /
 * WebSocket error / close 가 오면 reject. 재시도는 Controller가 한다.
 */
export class StompWebSocketClientAdapter extends WebSocketClientAdapter<
  StompClient,
  StompWebSocketClientOptions,
  IMessage
> {
  readonly #options: StompWebSocketClientOptions;

  readonly #connectCallbacks = new Set<() => void>();
  readonly #messageCallbacks = new Set<(message: IMessage) => void>();
  readonly #errorCallbacks = new Set<(error: Error) => void>();
  readonly #closeCallbacks = new Set<() => void>();

  constructor(options: StompWebSocketClientOptions) {
    super();
    this.#options = options;
  }

  public async connect(): Promise<void> {
    // 이전 클라이언트가 살아 있으면 먼저 정리 (연결 누수 방지)
    if (this.client?.active) {
      await this.client.deactivate();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const {
        client,
        reconnect: _reconnect,
        logger: _logger,
        plugins: _plugins,
        ...stompConfig
      } = this.#options;

      const config: StompConfig = {
        ...stompConfig,
        // stompjs 자체 재연결 비활성화 — Controller가 ReconnectConfig 로 재시도한다.
        reconnectDelay: 0,

        onConnect: (_frame: IFrame) => {
          settle(resolve);
          for (const cb of this.#connectCallbacks) cb();
        },

        onStompError: (frame: IFrame) => {
          const error = new StompStompError(frame.headers.message ?? "STOMP ERROR frame", frame);
          for (const cb of this.#errorCallbacks) cb(error);
          settle(() => reject(error));
        },

        onWebSocketError: (event: Event) => {
          const error = new StompWebsocketError("WebSocket error", event);
          for (const cb of this.#errorCallbacks) cb(error);
          settle(() => reject(error));
        },

        // 소켓이 닫히는 모든 경우에 한 번 온다 (deactivate 포함). 수동/비수동 판단은 Controller 상태로.
        onWebSocketClose: (event: CloseEvent) => {
          settle(() =>
            reject(
              new Error(
                `WebSocket closed before STOMP connected (code=${event.code}, reason=${event.reason})`,
              ),
            ),
          );
          for (const cb of this.#closeCallbacks) cb();
        },
      };

      // 주입된 client 가 있으면 그걸 쓰고 설정만 덮어쓴다. 없으면 새로 만든다.
      if (client) {
        client.configure(config);
        this.client = client;
      } else {
        this.client = new StompClient(config);
      }

      this.client.activate();
    });
  }

  public async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.deactivate();
  }

  // TODO(3단계): SendArgs<TSend> 를 별도 제네릭으로 풀고 publish(destination, body, headers) 로 구현
  public send(): void {
    throw new Error("Method not implemented.");
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
