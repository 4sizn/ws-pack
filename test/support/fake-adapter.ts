import type { IWebSocketClientAdapter, ReconnectConfig, SocketCloseInfo } from "../../src/lib";
import { WebSocketController } from "../../src/lib";

/**
 * 네트워크 없는 어댑터. 컨트롤러의 규칙(상태 전이, 재시도, 취소, 종료)만 떼어 검증하기 위한 것이다.
 *
 * 실제 어댑터와 같은 계약을 지킨다: connect() 는 한 번만 시도하고, signal 이 취소되면 자원을 놓는다.
 * 테스트는 `attempts` 로 시도 횟수를, `releases` 로 반납 횟수를, `signals` 로 어떤 신호를 받았는지 본다.
 */
export class FakeAdapter implements IWebSocketClientAdapter<undefined, string> {
  /** 각 connect() 시도의 결과를 순서대로 정한다. 비어 있으면 성공. */
  readonly outcomes: Array<"ok" | "fail"> = [];
  /** connect() 가 호출된 횟수 */
  attempts = 0;
  /** disconnect()/취소로 자원을 놓은 횟수 */
  releases = 0;
  /** connect() 가 받은 signal 들. 세션이 끝나면 abort 돼야 한다. */
  readonly signals: AbortSignal[] = [];
  /** 연결된 상태인지 (send 방어용) */
  connected = false;
  /** revalidate() 가 돌려줄 값. "hang" 이면 응답하지 않아 신호 기한을 시험한다. */
  liveness: boolean | "hang" = true;
  /** revalidate() 호출 횟수 */
  revalidations = 0;

  #message?: (data: string) => void;
  #error?: (error: Error) => void;
  #close?: (info: SocketCloseInfo) => void;
  #connect?: () => void;

  async connect(signal: AbortSignal): Promise<void> {
    this.attempts += 1;
    this.signals.push(signal);

    const outcome = this.outcomes.shift() ?? "ok";
    if (outcome === "fail") {
      throw new Error(`connect attempt ${this.attempts} failed`);
    }

    if (signal.aborted) {
      throw new Error("aborted before connect finished");
    }
    signal.addEventListener("abort", () => this.#release(), { once: true });

    this.connected = true;
    this.#connect?.();
  }

  async disconnect(): Promise<void> {
    this.#release();
  }

  #release(): void {
    if (!this.connected) return;
    this.connected = false;
    this.releases += 1;
  }

  async revalidate(signal: AbortSignal): Promise<boolean> {
    this.revalidations += 1;
    if (this.liveness !== "hang") return this.liveness;
    return new Promise<boolean>((resolve) => {
      signal.addEventListener("abort", () => resolve(false), { once: true });
    });
  }

  send(data: string): void {
    if (!this.connected) {
      throw new Error("fake adapter is not connected");
    }
    this.sent.push(data);
  }

  readonly sent: string[] = [];

  onMessage(callback: (data: string) => void): void {
    this.#message = callback;
  }
  onError(callback: (error: Error) => void): void {
    this.#error = callback;
  }
  onClose(callback: (info: SocketCloseInfo) => void): void {
    this.#close = callback;
  }
  onConnect(callback: () => void): void {
    this.#connect = callback;
  }

  // ── 테스트가 서버 쪽 사건을 흉내 내는 손잡이 ──────────────

  /** 서버가 메시지를 보냈다 */
  deliver(data: string): void {
    this.#message?.(data);
  }

  /** 어댑터가 런타임 에러를 보고했다 */
  fail(error: Error): void {
    this.#error?.(error);
  }

  /** 소켓이 예기치 않게 닫혔다 */
  drop(info: SocketCloseInfo = { code: 1006 }): void {
    this.connected = false;
    this.#close?.(info);
  }
}

/** FakeAdapter 를 물린 컨트롤러. 어댑터를 밖에서 주입해 사건을 조종한다. */
export class FakeController extends WebSocketController<string, undefined, FakeAdapter> {
  public readonly name = "FakeController";

  constructor(
    private readonly injected: FakeAdapter,
    reconnect?: ReconnectConfig,
  ) {
    super(reconnect);
  }

  protected createAdapter(): FakeAdapter {
    return this.injected;
  }
}
