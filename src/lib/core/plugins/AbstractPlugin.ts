export abstract class AbstractPlugin {
  public abstract readonly name: string;
  /**
   * 플러그인이 컨트롤러에 연결될 때의 초기화 로직
   */
  protected abstract onAttach(): void;

  /**
   * 플러그인이 컨트롤러에서 분리될 때의 정리 로직
   */
  protected abstract onDetach(): void;

  /**
   * Controller가 플러그인을 등록할 때 호출하는 공개 진입점.
   */
  public attach(): void {
    this.onAttach();
  }

  /**
   * Controller가 플러그인을 해제할 때 호출하는 공개 진입점.
   */
  public detach(): void {
    this.onDetach();
  }
}

export class TopicPlugin extends AbstractPlugin {
  public readonly name = "TopicPlugin";

  protected onAttach(): void {
    throw new Error("Method not implemented.");
  }
  protected onDetach(): void {
    throw new Error("Method not implemented.");
  }
}

export type Logger = Pick<Console, "log" | "error" | "warn">;

export class LoggingPlugin extends AbstractPlugin {
  public readonly name = "LoggingPlugin";
  #logger: Logger;

  constructor(logger: Logger) {
    super();
    this.#logger = logger;
  }

  protected onAttach(): void {
    this.#logger.log(`[${this.name}] attached`);
  }
  protected onDetach(): void {
    this.#logger.log(`[${this.name}] detached`);
  }
}

/**
 * WebSocketMonitorPlugin 생성자로 주입하는 핸들러 모음.
 * 모두 선택 사항이고, 넘기지 않은 훅은 아무 동작도 하지 않는다.
 */
export interface WebSocketMonitorHandlers {
  onAttach?(): void;
  onDetach?(): void;
  onBeforeConnect?(): void | Promise<void>;
  onAfterConnect?(): void | Promise<void>;
  onBeforeDisconnect?(): void | Promise<void>;
  onAfterDisconnect?(): void | Promise<void>;
}

/**
 * 웹소켓에서 다루고있는 이벤트를 기반으로 데이터 모니터링을 할수 있는 플러그인
 */
export class WebSocketMonitorPlugin extends AbstractPlugin {
  public readonly name = "WebSocketMonitorPlugin";
  readonly #handlers: WebSocketMonitorHandlers;

  constructor(handlers: WebSocketMonitorHandlers = {}) {
    super();
    this.#handlers = handlers;
  }

  protected onAttach(): void {
    this.#handlers.onAttach?.();
  }

  protected onDetach(): void {
    this.#handlers.onDetach?.();
  }

  /**
   * 연결 전 단계에서 호출되는 훅
   */
  public async onBeforeConnect(): Promise<void> {
    await this.#handlers.onBeforeConnect?.();
  }

  /**
   * 연결 후 단계에서 호출되는 훅
   */
  public async onAfterConnect(): Promise<void> {
    await this.#handlers.onAfterConnect?.();
  }

  /**
   * 연결 해제 전 단계에서 호출되는 훅
   */
  public async onBeforeDisconnect(): Promise<void> {
    await this.#handlers.onBeforeDisconnect?.();
  }

  /**
   * 연결 해제 후 단계에서 호출되는 훅
   */
  public async onAfterDisconnect(): Promise<void> {
    await this.#handlers.onAfterDisconnect?.();
  }
}
