/**
 * 연결 수명 훅. 플러그인이 필요한 것만 구현한다.
 *
 * Controller 는 이 이름들만 보고 부른다 — 특정 플러그인 클래스인지 확인하지 않는다.
 * 확인하는 순간 사용자가 만든 플러그인은 훅을 못 받고, 확장점이라는 말이 거짓이 된다.
 */
export interface PluginLifecycleHooks {
  onBeforeConnect?(): void | Promise<void>;
  onAfterConnect?(): void | Promise<void>;
  onBeforeDisconnect?(): void | Promise<void>;
  onAfterDisconnect?(): void | Promise<void>;
  /** connect() 실패, 또는 연결 후 어댑터가 보고하는 런타임 에러 */
  onError?(error: Error): void | Promise<void>;
}

export abstract class AbstractPlugin implements PluginLifecycleHooks {
  public abstract readonly name: string;

  /**
   * 선택 훅. 구현한 플러그인만 호출된다.
   * 메서드가 아니라 선택 프로퍼티로 선언하는 이유는, 구현하지 않은 플러그인에서
   * "있는데 아무것도 안 하는 메서드" 가 아니라 아예 없는 상태가 되게 하기 위해서다.
   */
  public onBeforeConnect?: () => void | Promise<void>;
  public onAfterConnect?: () => void | Promise<void>;
  public onBeforeDisconnect?: () => void | Promise<void>;
  public onAfterDisconnect?: () => void | Promise<void>;
  public onError?: (error: Error) => void | Promise<void>;
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
export interface WebSocketMonitorHandlers extends PluginLifecycleHooks {
  onAttach?(): void;
  onDetach?(): void;
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

  /** 연결 전 단계에서 호출되는 훅 */
  public onBeforeConnect = async (): Promise<void> => {
    await this.#handlers.onBeforeConnect?.();
  };

  /** 연결 후 단계에서 호출되는 훅 */
  public onAfterConnect = async (): Promise<void> => {
    await this.#handlers.onAfterConnect?.();
  };

  /** 연결 해제 전 단계에서 호출되는 훅 */
  public onBeforeDisconnect = async (): Promise<void> => {
    await this.#handlers.onBeforeDisconnect?.();
  };

  /** 연결 해제 후 단계에서 호출되는 훅 */
  public onAfterDisconnect = async (): Promise<void> => {
    await this.#handlers.onAfterDisconnect?.();
  };

  /** connect() 실패, 또는 연결 후 어댑터가 보고하는 런타임 에러 발생 시 호출되는 훅 */
  public onError = async (error: Error): Promise<void> => {
    await this.#handlers.onError?.(error);
  };
}
