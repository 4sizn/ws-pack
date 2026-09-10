import { type WebSocket, WebSocketServer } from "ws";

/**
 * 테스트용 최소 STOMP 브로커 (WebSocket 위).
 *
 * 실제 RabbitMQ 를 띄우지 않는 이유: 테스트가 네트워크와 도커에 의존하면 느리고, 무엇보다
 * "브로커가 응답을 멈춘다", "소켓이 예고 없이 끊긴다" 같은 고장을 만들 수 없다.
 * 이 브로커는 그 고장을 명령 하나로 만든다.
 *
 * 지원 프레임: CONNECT/STOMP, SUBSCRIBE, UNSUBSCRIBE, SEND, DISCONNECT.
 */

const NULL = "\0";

interface Session {
  socket: WebSocket;
  /** subscription id -> destination */
  subscriptions: Map<string, string>;
}

interface Frame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

export class TestStompBroker {
  #server?: WebSocketServer;
  readonly #sessions = new Set<Session>();
  #messageId = 0;
  /** true 면 들어오는 프레임을 전부 무시한다 (브로커 무응답 재현) */
  #mute = false;

  get url(): string {
    const address = this.#server?.address();
    if (!address || typeof address === "string") {
      throw new Error("broker is not listening");
    }
    return `ws://127.0.0.1:${address.port}`;
  }

  /** 현재 열려 있는 클라이언트 연결 수. 소켓 누수 검증의 기준값. */
  get connectionCount(): number {
    return this.#sessions.size;
  }

  /** 브로커가 인지한 구독 수. "받을 준비가 됐는가" 를 판정하는 기준. */
  get subscriptionCount(): number {
    let total = 0;
    for (const session of this.#sessions) total += session.subscriptions.size;
    return total;
  }

  async start(): Promise<void> {
    const server = new WebSocketServer({ port: 0 });
    this.#server = server;
    await new Promise<void>((resolve) => server.once("listening", resolve));

    server.on("connection", (socket) => {
      const session: Session = { socket, subscriptions: new Map() };
      this.#sessions.add(session);

      socket.on("message", (raw) => {
        if (this.#mute) return;
        for (const frame of parse(raw.toString())) {
          this.#handle(session, frame);
        }
      });
      socket.on("close", () => this.#sessions.delete(session));
      socket.on("error", () => this.#sessions.delete(session));
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
    for (const session of [...this.#sessions]) {
      session.socket.terminate();
      this.#sessions.delete(session);
    }
  }

  /**
   * 들어오는 프레임을 무시한다. 소켓은 열려 있지만 어떤 응답도 오지 않는다 —
   * "종료가 브로커 응답을 기다리면 영영 끝나지 않는다" 를 재현하는 상태.
   */
  mute(): void {
    this.#mute = true;
  }

  #handle(session: Session, frame: Frame): void {
    switch (frame.command) {
      case "CONNECT":
      case "STOMP":
        // heart-beat 0,0 으로 협상해 테스트에서 하트비트 타이밍을 배제한다.
        this.#send(session, "CONNECTED", { version: "1.2", "heart-beat": "0,0" }, "");
        return;

      case "SUBSCRIBE": {
        const { id, destination } = frame.headers;
        if (id && destination) session.subscriptions.set(id, destination);
        return;
      }

      case "UNSUBSCRIBE":
        session.subscriptions.delete(frame.headers.id);
        return;

      case "SEND":
        this.#fanout(frame.headers.destination, frame.body);
        return;

      case "DISCONNECT": {
        const receipt = frame.headers.receipt;
        if (receipt) this.#send(session, "RECEIPT", { "receipt-id": receipt }, "");
        session.socket.close();
        return;
      }
    }
  }

  /** destination 을 구독 중인 모든 세션에 MESSAGE 를 보낸다 (발신자 포함). */
  #fanout(destination: string, body: string): void {
    if (!destination) return;
    for (const session of this.#sessions) {
      for (const [id, subscribed] of session.subscriptions) {
        if (subscribed !== destination) continue;
        this.#send(
          session,
          "MESSAGE",
          {
            subscription: id,
            "message-id": `msg-${++this.#messageId}`,
            destination,
            "content-type": "text/plain",
          },
          body,
        );
      }
    }
  }

  #send(session: Session, command: string, headers: Record<string, string>, body: string): void {
    const lines = Object.entries(headers).map(([key, value]) => `${key}:${value}`);
    session.socket.send(`${command}\n${lines.join("\n")}\n\n${body}${NULL}`);
  }
}

/** 한 번에 여러 프레임이 붙어 올 수 있다. NULL 로 잘라서 각각 파싱한다. */
function parse(payload: string): Frame[] {
  return payload
    .split(NULL)
    .map((chunk) => chunk.replace(/^\n+/, ""))
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [head, body = ""] = chunk.split("\n\n");
      const [command, ...headerLines] = head.split("\n");
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const separator = line.indexOf(":");
        if (separator > 0) headers[line.slice(0, separator)] = line.slice(separator + 1);
      }
      return { command, headers, body };
    });
}
