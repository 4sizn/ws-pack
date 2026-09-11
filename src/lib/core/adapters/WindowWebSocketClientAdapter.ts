import { abortReason, onAbort, type Resolvable, resolveWithSignal, toError } from "../abort";
import type { SocketCloseInfo } from "../CloseInfo";
import { WindowWebsocketError } from "../errors/WindowWebsocketError";
import type { AbstractPlugin, Logger } from "../plugins/AbstractPlugin";
import type { ReconnectConfig } from "../Reconnect";
import { WebSocketClientAdapter } from "./WebSocketClientAdapter";

/** 브라우저 내장 `WebSocket` 생성자가 받는 인자 타입 (url, protocols) */
type BrowserWebSocketArgs = ConstructorParameters<typeof WebSocket>;

/**
 * 애플리케이션 하트비트 설정.
 *
 * 죽은 연결을 알아채는 보편적인 방법은 주기적 왕복(하트비트)이다 — STOMP 는 `heart-beat`,
 * MQTT 는 keepalive/PINGREQ 를 프로토콜이 직접 갖고 있고, Socket.IO 같은 라이브러리도 자체
 * ping/pong 을 돌린다. 순수 WebSocket 만 그 수단이 없다: 브라우저 API 로는 ping 프레임을
 * 보낼 수 없어서, 서버와 약속한 애플리케이션 메시지로 대신할 수밖에 없다.
 *
 * 그래서 값은 전부 문자열과 숫자다 — 함수로 받으면 워커로 넘길 때 구조화 복제가 실패한다.
 */
export interface WindowHeartbeatConfig {
  /** ping 을 보내는 주기(ms) */
  intervalMs: number;
  /** ping 을 보낸 뒤 응답을 기다리는 시간(ms). 지나면 연결이 죽은 것으로 보고 소켓을 닫는다. */
  timeoutMs: number;
  /** 서버에 보낼 ping 메시지 */
  ping: string;
  /**
   * 응답으로 인정할 메시지. 생략하면 **아무 수신 메시지나** 살아 있다는 증거로 본다
   * (에코 서버처럼 ping 을 그대로 돌려주는 경우 포함).
   */
  pong?: string;
}

export interface WindowWebSocketClientOptions {
  /** `new WebSocket(url, protocols)` 의 url. 문자열 또는 시도마다 평가되는 팩토리. */
  url: Resolvable<BrowserWebSocketArgs[0]>;
  /** `new WebSocket(url, protocols)` 의 protocols와 동일한 타입 */
  protocols?: BrowserWebSocketArgs[1];
  /** 이미 만들어진 WebSocket 인스턴스를 주입. 없으면 어댑터가 내부에서 기본 생성한다. */
  client?: WebSocket;
  /** 재연결 정책 (Controller가 소비) */
  reconnect?: ReconnectConfig;
  logger?: Logger;
  plugins?: AbstractPlugin[];
  /**
   * 애플리케이션 하트비트. 서버가 ping 에 응답해 주기로 약속돼 있을 때만 설정한다.
   * 설정하면 revalidate() 도 이 왕복으로 답한다 — 없으면 소켓이 닫혔는지까지만 본다.
   */
  heartbeat?: WindowHeartbeatConfig;
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

  /** 하트비트 주기 타이머 */
  #beat?: ReturnType<typeof setInterval>;
  /** 응답을 기다리는 중인 ping 들. 응답이 오면 전부 풀린다. */
  readonly #waiting = new Set<(alive: boolean) => void>();

  constructor(options: WindowWebSocketClientOptions) {
    super();
    this.#options = options;
  }

  public async connect(signal: AbortSignal): Promise<void> {
    const { protocols, client } = this.#options;

    // 이전 시도가 남긴 소켓을 먼저 놓는다 (연결 누수 방지).
    await this.disconnect();

    let url: BrowserWebSocketArgs[0];
    try {
      url = await resolveWithSignal(this.#options.url, signal);
    } catch (error) {
      if (!signal.aborted) {
        for (const cb of this.#errorCallbacks) cb(toError(error));
      }
      throw error;
    }

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
        this.#startHeartbeat(socket);
        settle(resolve);
        for (const cb of this.#connectCallbacks) cb();
      };

      const onMessage = (event: MessageEvent) => {
        if (!live()) return;
        // 문자열 프레임만 다룬다. 바이너리는 이 어댑터의 계약(TMessage = string) 밖이다.
        if (typeof event.data !== "string") return;

        if (this.#consumePong(event.data)) return;
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
    this.#stopHeartbeat();
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
   * 하트비트가 설정돼 있으면 ping 을 한 번 보내 응답으로 확인한다 — 진짜 왕복이다.
   *
   * 없으면 소켓이 이미 닫혔는지까지만 본다. 순수 WebSocket 에는 프로토콜 차원의 ping 이 없고
   * (브라우저 API 로 ping 프레임을 보낼 수 없다) 애플리케이션 ping 은 서버가 약속해 줘야
   * 성립하기 때문이다. 이 경우 상대만 사라진 half-open 은 잡지 못한다.
   */
  public async revalidate(signal: AbortSignal): Promise<boolean> {
    const socket = this.client;
    if (socket?.readyState !== WebSocket.OPEN) return false;

    const heartbeat = this.#options.heartbeat;
    if (!heartbeat) return true;

    return this.#ping(socket, heartbeat, signal);
  }

  /**
   * 주기적 하트비트. 응답이 제한 시간 안에 오지 않으면 소켓을 닫는다 —
   * 닫으면 close 이벤트가 흘러 Controller 의 재연결 경로를 그대로 탄다.
   * 이건 STOMP 의 heart-beat 나 MQTT 의 keepalive 가 하는 일과 같고, 그 둘은 프로토콜이 대신 해 준다.
   */
  #startHeartbeat(socket: WebSocket): void {
    const heartbeat = this.#options.heartbeat;
    if (!heartbeat) return;

    this.#stopHeartbeat();
    this.#beat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), heartbeat.timeoutMs);
      void this.#ping(socket, heartbeat, limit.signal).then((alive) => {
        clearTimeout(timer);
        // 리스너는 그대로 두고 닫는다 — close 이벤트가 나가야 재연결이 시작된다.
        if (!alive && socket.readyState === WebSocket.OPEN) {
          socket.close(4000, "heartbeat timeout");
        }
      });
    }, heartbeat.intervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#beat) clearInterval(this.#beat);
    this.#beat = undefined;
    for (const waiter of this.#waiting) waiter(false);
    this.#waiting.clear();
  }

  /** ping 하나를 보내고 응답을 기다린다. */
  #ping(
    socket: WebSocket,
    heartbeat: WindowHeartbeatConfig,
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (alive: boolean) => {
        if (settled) return;
        settled = true;
        this.#waiting.delete(settle);
        resolve(alive);
      };

      this.#waiting.add(settle);
      onAbort(signal, () => settle(false));

      try {
        socket.send(heartbeat.ping);
      } catch {
        settle(false);
      }
    });
  }

  /**
   * 하트비트 응답이면 삼킨다. 응답을 애플리케이션 메시지로 흘리면 화면에 ping 이 채팅으로 뜬다.
   * `pong` 을 정하지 않았으면 어떤 수신이든 살아 있다는 증거로 보되, 메시지 자체는 그대로 흘린다.
   */
  #consumePong(data: string): boolean {
    if (this.#waiting.size === 0) return false;

    const heartbeat = this.#options.heartbeat;
    const isPong = heartbeat?.pong === undefined ? true : data === heartbeat.pong;
    if (!isPong) return false;

    for (const waiter of [...this.#waiting]) waiter(true);
    // 우리가 보낸 ping 이 그대로 돌아온 것이면 삼킨다.
    return heartbeat?.pong !== undefined || data === heartbeat?.ping;
  }

  /** 브라우저 소켓의 readyState. 소켓이 없으면 CLOSED. */
  public networkStatus(): number {
    return this.client?.readyState ?? READY_STATE_CLOSED;
  }
}
