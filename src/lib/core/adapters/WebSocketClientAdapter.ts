/**
 * Adapter 계층 공통 계약.
 *
 * 구조 관계: Client -> Controller -> Adapter.
 * Adapter는 외부 라이브러리(브라우저 WebSocket, @stomp/stompjs, mqtt.js)를 아는 유일한 계층이다.
 * 재연결 정책과 연결 상태는 Controller가 소유하므로 Adapter는 "한 번 연결 시도"만 책임진다 —
 * connect()는 성공 시 resolve, 실패 시 reject 하고 스스로 재시도하지 않는다.
 *
 * @template TSend    send() 의 두 번째 인자 타입. undefined 면 send(data) 한 개 인자 (Window).
 *                    STOMP 처럼 destination/headers 가 필요하면 그 옵션 타입 (StompSendOptions).
 * @template TMessage 수신 메시지 타입 (Window: string, Stomp: IMessage).
 */

export type SendArgs<TSend> = TSend extends undefined ? [] : [options: TSend];

export interface IWebSocketClientAdapter<TSend = undefined, TMessage = string> {
  /** 단일 연결 시도. 성공하면 resolve, 실패하면 reject. 재시도는 Controller 몫. */
  connect(): Promise<void>;
  /** 연결 종료. 종료 완료 후 resolve. */
  disconnect(): Promise<void>;
  /** 연결 안 된 상태면 throw. 연결 여부 판단은 Controller 가 먼저 한다. */
  send(data: string, ...args: SendArgs<TSend>): void;
  onMessage(callback: (data: TMessage) => void): void;
  onError(callback: (error: Error) => void): void;
  /** 소켓이 닫혔을 때 (수동/비수동 구분 없음 — 판단은 Controller 상태로) */
  onClose(callback: () => void): void;
  onConnect(callback: () => void): void;
}

/**
 * @template T 감싸는 외부 라이브러리 클라이언트 타입 (WebSocket, stompjs Client 등)
 * @template C 이 어댑터의 옵션 타입
 */
export abstract class WebSocketClientAdapter<T, C, TMessage = string, TSend = undefined>
  implements IWebSocketClientAdapter<TSend, TMessage>
{
  protected client?: T;

  public abstract connect(config?: C): Promise<void>;
  public abstract disconnect(): Promise<void>;
  public abstract send(data: string, ...args: SendArgs<TSend>): void;
  public abstract onMessage(callback: (data: TMessage) => void): void;
  public abstract onError(callback: (error: Error) => void): void;
  public abstract onClose(callback: () => void): void;
  public abstract onConnect(callback: () => void): void;
  /** 어댑터 내장 상태값 (브라우저 readyState / StompSocketState 등). Controller의 ConnectionState와 별개. */
  public abstract networkStatus(): number;
}
