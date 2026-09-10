import { createServer, type Server } from "node:http";
import { Duplex } from "node:stream";
import { Aedes } from "aedes";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * 테스트용 MQTT 브로커 (WebSocket 위, aedes).
 *
 * STOMP 쪽은 프레임이 텍스트라 직접 구현했지만 MQTT 는 바이너리 패킷이라 브로커를 손으로 만들면
 * 검증 대상이 아닌 코드에서 버그가 난다. 대신 고장 주입에 필요한 손잡이(연결 끊기, 무응답)만
 * 이 클래스가 쥔다.
 */
export class TestMqttBroker {
  #broker?: Aedes;
  #http?: Server;
  #wss?: WebSocketServer;
  readonly #sockets = new Set<WebSocket>();
  /** clientId -> 구독 필터 수 */
  readonly #subscriptions = new Map<string, number>();
  #muted = false;

  get url(): string {
    const address = this.#http?.address();
    if (!address || typeof address === "string") {
      throw new Error("broker is not listening");
    }
    return `ws://127.0.0.1:${address.port}`;
  }

  /** 살아 있는 클라이언트 연결 수. 소켓 누수 판정 기준. */
  get connectionCount(): number {
    return this.#sockets.size;
  }

  /** 브로커가 인지한 구독 수. "받을 준비가 됐는가" 판정 기준. */
  get subscriptionCount(): number {
    let total = 0;
    for (const count of this.#subscriptions.values()) total += count;
    return total;
  }

  async start(): Promise<void> {
    const broker = await Aedes.createBroker();
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    this.#broker = broker;
    this.#http = http;
    this.#wss = wss;

    broker.on("subscribe", (subscriptions, client) => {
      this.#subscriptions.set(
        client.id,
        (this.#subscriptions.get(client.id) ?? 0) + subscriptions.length,
      );
    });
    broker.on("unsubscribe", (subscriptions, client) => {
      const left = (this.#subscriptions.get(client.id) ?? 0) - subscriptions.length;
      this.#subscriptions.set(client.id, Math.max(left, 0));
    });
    broker.on("clientDisconnect", (client) => this.#subscriptions.delete(client.id));
    broker.on("clientError", (client) => this.#subscriptions.delete(client.id));

    wss.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
      socket.on("error", () => this.#sockets.delete(socket));
      broker.handle(this.#toDuplex(socket));
    });

    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    this.killConnections();
    this.#wss?.close();
    const broker = this.#broker;
    const http = this.#http;
    this.#broker = undefined;
    this.#http = undefined;
    this.#wss = undefined;
    if (broker) await new Promise<void>((resolve) => broker.close(resolve));
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  /** 모든 연결을 종료 핸드셰이크 없이 끊는다. 재연결 검증용. */
  killConnections(): void {
    for (const socket of [...this.#sockets]) {
      socket.terminate();
      this.#sockets.delete(socket);
    }
    this.#subscriptions.clear();
  }

  /**
   * 응답을 끊는다. 소켓은 열려 있지만 브로커가 보내는 패킷이 나가지 않는다 —
   * 종료가 상대 응답을 기다리면 영영 끝나지 않는 상황의 재현.
   */
  mute(): void {
    this.#muted = true;
  }

  /**
   * ws 소켓을 aedes 가 받는 Duplex 로 잇는다.
   * `ws` 의 createWebSocketStream 은 Bun 에서 아직 동작하지 않아 직접 잇는다.
   */
  #toDuplex(socket: WebSocket): Duplex {
    const stream = new Duplex({
      read() {},
      write: (chunk: Buffer, _encoding, callback) => {
        // muted 여도 콜백은 부른다 — 안 부르면 브로커 쪽 쓰기가 역압으로 멈춘다.
        if (!this.#muted) socket.send(chunk);
        callback();
      },
      final(callback) {
        socket.close();
        callback();
      },
      destroy(error, callback) {
        socket.close();
        callback(error);
      },
    });

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      stream.push(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));
    });
    socket.on("close", () => stream.push(null));
    socket.on("error", (error) => stream.destroy(error));

    return stream;
  }
}
