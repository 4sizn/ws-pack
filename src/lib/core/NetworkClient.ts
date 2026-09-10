import type { Observable } from "rxjs";
import type { SendArgs } from "./adapters/WebSocketClientAdapter";
import type { DisconnectInfo } from "./CloseInfo";
import type { ConnectionState } from "./ConnectionState";
import type { ReconnectInfo } from "./Reconnect";

/**
 * 네트워크 클라이언트의 공개 표면.
 *
 * 같은 프로그램을 두 가지 방식으로 돌릴 수 있다: 페이지가 직접 소켓을 들거나(WebSocketClient),
 * 워커 안의 클라이언트를 원격으로 조종하거나(WorkerWebSocketClient). 소비자 코드가 둘을
 * 갈아 끼울 수 있어야 하므로 표면을 타입으로 고정한다.
 *
 * 상속이 아니라 인터페이스인 이유: 두 구현은 상태 머신을 **다른 곳에** 둔다. 직접 연결은
 * 페이지의 Controller 가, 워커 경로는 워커 안의 Controller 가 소유한다. 페이지 쪽에도 Controller 를
 * 상속으로 끌어오면 상태 소유자가 둘이 되고, 워커가 재연결 중인데 페이지는 자기 계산으로
 * 연결됨이라 믿는 어긋남이 생긴다.
 *
 * @template TMessage 수신 메시지 타입
 * @template TSend    send() 의 두 번째 인자 타입. undefined 면 인자 하나
 */
export interface NetworkClient<TMessage, TSend = undefined> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * 전송. 직접 연결은 즉시 실패를 throw 하고, 워커 경로는 왕복이라 Promise 로 알린다 —
   * 어느 쪽이든 `await` 로 같은 코드를 쓸 수 있다.
   */
  send(data: string, ...args: SendArgs<TSend>): void | Promise<void>;

  readonly connectionState: ConnectionState;
  readonly connectionState$: Observable<ConnectionState>;
  readonly connectionChanges$: Observable<ConnectionState>;
  readonly connect$: Observable<void>;
  readonly disconnect$: Observable<DisconnectInfo>;
  readonly error$: Observable<Error>;
  readonly message$: Observable<TMessage>;
  readonly reconnectAttempt$: Observable<ReconnectInfo>;
  readonly maxReconnectReached$: Observable<void>;
  readonly reconnectInfo: ReconnectInfo;

  /**
   * 연결이 정말 살아 있는지 확인한다. 죽었으면 재연결을 시작하고 false 를 준다.
   * 언제 부를지는 앱이 정한다 — 신호원(포그라운드 복귀, 네트워크 전환)이 환경마다 다르기 때문이다.
   */
  revalidate(timeoutMs?: number): Promise<boolean>;

  /**
   * 인스턴스 폐기. 연결을 놓고 스트림을 완료한다. 두 번 불러도 안전하다.
   * 워커 경로에서는 손잡이를 놓는 것이고, 마지막 손잡이면 워커가 연결을 닫는다.
   */
  destroy(): void;
}
