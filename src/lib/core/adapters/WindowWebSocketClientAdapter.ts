import { abortReason, onAbort } from "../abort";
import type { SocketCloseInfo } from "../CloseInfo";
import { WindowWebsocketError } from "../errors/WindowWebsocketError";
import type { AbstractPlugin, Logger } from "../plugins/AbstractPlugin";
import type { ReconnectConfig } from "../Reconnect";
import { WebSocketClientAdapter } from "./WebSocketClientAdapter";

/** 브라우저 내장 `WebSocket` 생성자가 받는 인자 타입 (url, protocols) */
type BrowserWebSocketArgs = ConstructorParameters<typeof WebSocket>;

export interface WindowWebSocketClientOptions {
  /** `new WebSocket(url, protocols)` 의 url과 동일한 타입 */
  url: BrowserWebSocketArgs[0];
  /** `new WebSocket(url, protocols)` 의 protocols와 동일한 타입 */
  protocols?: BrowserWebSocketArgs[1];
  /** 이미 만들어진 WebSocket 인스턴스를 주입. 없으면 어댑터가 내부에서 기본 생성한다. */
  client?: WebSocket;
  /** 재연결 정책 (Controller가 소비) */
  reconnect?: ReconnectConfig;
  logger?: Logger;
  plugins?: AbstractPlugin[];
}

/** `WebSocket.readyState` 의 CLOSED. 소켓이 없을 때 돌려줄 값이라 상수로 둔다. */
const READY_STATE_CLOSED = 3;

/**
 * 브라우저 내장 WebSocket 어댑터. destination 개념이 없어 연결 하나가 곧 채널 하나다.
 *
 * connect(signal) 은 "한 번" 시도한다: open 이면 resolve, 그 전에 error/close 가 오면 reject.
 * 재시도는 Controller 가 한다.
 *
 * 이 연결의 수명은 `signal` 이 정한다. abort 되면 — 시도 중이든 이미 열렸든 — 소켓을 놓는다.
 * STOMP 어댑터와 같은 규칙이라, 두 프로토콜의 수명 관리가 한 가지 방식으로 통일된다.
 */
export class WindowWebSocketClientAdapter extends WebSocketClientAdapter<
  WebSocket,
  WindowWebSocketClientOptions
> {
  readonly #options: WindowWebSocketClientOptions;

  readonly #connectCallbacks = new Set<() => void>();
  readonly #messageCallbacks = new Set<(data: string) => void>();
  readonly #errorCallbacks = new Set<(error: Error) => void>();
  readonly #closeCallbacks = new Set<(info: SocketCloseInfo) => void>();

  /** 현재 소켓에 건 리스너 해제 함수. 소켓을 놓을 때 콜백부터 끊는다. */
  #detach?: () => void;

  constructor(options: WindowWebSocketClientOptions) {
    super();
    this.#options = options;
  }

  public async connect(signal: AbortSignal): Promise<void> {
    const { url, protocols, client } = this.#options;

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

      let socket: WebSocket;
      try {
        socket = client ?? new WebSocket(url, protocols);
      } catch (error) {
        // 잘못된 URL 등 생성 자체가 실패하는 경우
        settle(() => reject(error));
        return;
      }
      this.client = socket;

      const onOpen = () => {
        if (!live()) return;
        settle(resolve);
        for (const cb of this.#connectCallbacks) cb();
      };

      const onMessage = (event: MessageEvent) => {
        if (!live()) return;
        // 문자열 프레임만 다룬다. 바이너리는 이 어댑터의 계약(TMessage = string) 밖이다.
        if (typeof event.data !== "string") return;
        for (const cb of this.#messageCallbacks) cb(event.data);
      };

      const onError = (event: Event) => {
        if (!live()) return;
        const error = new WindowWebsocketError("WebSocket error", event);
        for (const cb of this.#errorCallbacks) cb(error);
        settle(() => reject(error));
      };

      const onClose = (event: CloseEvent) => {
        if (!live()) return;
        settle(() =>
          reject(
            new Error(`WebSocket closed before open (code=${event.code}, reason=${event.reason})`),
          ),
        );
        const info: SocketCloseInfo = {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        };
        for (const cb of this.#closeCallbacks) cb(info);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      this.#detach = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };

      // 연결의 수명 = signal 의 수명. 이미 취소됐다면 그대로 접는다.
      onAbort(signal, () => {
        settle(() => reject(abortReason(signal)));
        this.#release(socket);
      });
      if (signal.aborted) return;

      // 주입된 소켓이 이미 열려 있으면 open 이벤트는 오지 않는다.
      if (socket.readyState === WebSocket.OPEN) {
        onOpen();
      }
    });
  }

  /**
   * 연결 종료. 소유권을 먼저 놓고, 소켓 정리는 로컬에서 끝낸다. 이미 놓았으면 아무 일도 하지 않는다.
   *
   * `close()` 는 종료 핸드셰이크를 시작할 뿐이고 그 완료는 상대에게 달렸다. 그 완료를 기다리지
   * 않는 이유는 STOMP 어댑터와 같다 — 끊는다는 로컬 결정이 상대 응답에 인질로 잡히면 안 된다.
   */
  public async disconnect(): Promise<void> {
    const socket = this.client;
    this.client = undefined;
    if (!socket) return;
    this.#release(socket);
  }

  /** 리스너부터 끊고 소켓을 닫는다. 닫힌 뒤 오는 이벤트는 이미 우리 것이 아니다. */
  #release(socket: WebSocket): void {
    if (this.client === socket) {
      this.client = undefined;
    }
    this.#detach?.();
    this.#detach = undefined;
    // CLOSING/CLOSED 에 close() 를 불러도 무해하다 (사양상 no-op).
    socket.close();
  }

  public send(data: string): void {
    if (this.client?.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.client.send(data);
  }

  public onConnect(callback: () => void): void {
    this.#connectCallbacks.add(callback);
  }

  public onMessage(callback: (data: string) => void): void {
    this.#messageCallbacks.add(callback);
  }

  public onError(callback: (error: Error) => void): void {
    this.#errorCallbacks.add(callback);
  }

  public onClose(callback: (info: SocketCloseInfo) => void): void {
    this.#closeCallbacks.add(callback);
  }

  /**
   * 순수 WebSocket 은 프로토콜 차원의 왕복 수단이 없다. ping/pong 프레임은 브라우저 API 로
   * 보낼 수 없고, 애플리케이션 ping 은 서버가 약속해 줘야 성립한다.
   * 그래서 여기서는 소켓이 이미 닫혔는지까지만 본다 — 상대만 사라진 half-open 은 잡지 못한다.
   */
  public async revalidate(_signal: AbortSignal): Promise<boolean> {
    return this.client?.readyState === WebSocket.OPEN;
  }

  /** 브라우저 소켓의 readyState. 소켓이 없으면 CLOSED. */
  public networkStatus(): number {
    return this.client?.readyState ?? READY_STATE_CLOSED;
  }
}
