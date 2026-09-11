import { type WebSocket, WebSocketServer } from "ws";

/**
 * 테스트용 방 라우팅 에코 서버 (순수 WebSocket).
 *
 * destination 이 없는 프로토콜에서 "방" 은 접속 URL 로 정해진다: `?room=<name>` 으로 붙은
 * 참가자끼리만 서로의 메시지를 받는다. 발신자에게도 되돌려 보내는 것은 STOMP 브로커의
 * fanout 과 같은 규칙을 유지하기 위함이다 — 두 프로토콜이 같은 시나리오를 만족해야 한다.
 */
export class TestEchoServer {
  #server?: WebSocketServer;
  readonly #rooms = new Map<WebSocket, string>();
  #mute = false;
  #accept: (token: string | null) => boolean;
  readonly #onConnect?: (token: string | null) => void;

  constructor(
    options: {
      accept?: (token: string | null) => boolean;
      onConnect?: (token: string | null) => void;
    } = {},
  ) {
    const { accept, onConnect } = options;
    this.#accept = accept ?? (() => true);
    this.#onConnect = onConnect;
  }

  get url(): string {
    const address = this.#server?.address();
    if (!address || typeof address === "string") {
      throw new Error("server is not listening");
    }
    return `ws://127.0.0.1:${address.port}`;
  }

  /** 살아 있는 연결 수. 순수 WebSocket 에서는 이게 곧 수신 대기자 수다. */
  get connectionCount(): number {
    return this.#rooms.size;
  }

  async start(): Promise<void> {
    const server = new WebSocketServer({
      port: 0,
      // 핸드셰이크 단계에서 토큰을 거부하면 브라우저 WebSocket 이 open 이벤트 없이
      // 바로 close 를 받는다. open 이 뒤늦게 뜨면 connect() 가 먼저 resolve 돼
      // 재시도 검증이 흔들리기 때문에, 여기서 미리 끊는다.
      verifyClient: (info, cb) => {
        const token = new URL(info.req.url ?? "/", "ws://localhost").searchParams.get("token");
        this.#onConnect?.(token);
        cb(this.#accept(token));
      },
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.once("listening", resolve));

    server.on("connection", (socket, request) => {
      const room = new URL(request.url ?? "/", "ws://localhost").searchParams.get("room") ?? "";
      this.#rooms.set(socket, room);

      socket.on("message", (raw) => {
        if (this.#mute) return;
        this.#fanout(room, raw.toString());
      });
      socket.on("close", () => this.#rooms.delete(socket));
      socket.on("error", () => this.#rooms.delete(socket));
    });
  }

  async stop(): Promise<void> {
    this.killConnections();
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /** 모든 연결을 종료 핸드셰이크 없이 끊는다 (close code 1006). 재연결 검증용. */
  killConnections(): void {
    for (const socket of [...this.#rooms.keys()]) {
      socket.terminate();
      this.#rooms.delete(socket);
    }
  }

  /** 들어오는 메시지를 무시한다. 소켓은 열려 있지만 어떤 응답도 오지 않는다. */
  mute(): void {
    this.#mute = true;
  }

  /** 다시 응답하게 되돌린다. 무응답 뒤의 회복까지 시험하기 위한 것이다. */
  unmute(): void {
    this.#mute = false;
  }

  #fanout(room: string, payload: string): void {
    for (const [socket, joined] of this.#rooms) {
      if (joined === room && socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }
}
