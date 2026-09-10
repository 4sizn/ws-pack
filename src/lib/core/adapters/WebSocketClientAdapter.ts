import type { SocketCloseInfo } from "../CloseInfo";

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
  /**
   * 단일 연결 시도. 성공하면 resolve, 실패하면 reject. 재시도는 Controller 몫.
   *
   * `signal` 은 이 연결의 수명이다. abort 되면 시도 중이든 이미 연결됐든 어댑터는 소켓을 놓는다.
   * 취소 판단을 어댑터 내부 플래그로 흉내 내지 않고 신호 하나로 통일한다.
   */
  connect(signal: AbortSignal): Promise<void>;
  /**
   * 연결 종료. **로컬 자원(소켓 핸들)을 놓은 시점에 resolve 한다.**
   *
   * 브로커의 종료 확인(RECEIPT, close 프레임)을 기다리면 안 된다. 그 확인은 상대와 네트워크에
   * 달려 있어 도착 보장이 없고, 기다리는 순간 "끊는다"는 로컬 결정이 상대에게 인질로 잡힌다.
   * 우아한 종료 프레임은 보내되(best effort), 그 응답은 기다리지 않는다.
   *
   * 이미 놓은 뒤에 다시 불러도 안전하다 (멱등).
   */
  disconnect(): Promise<void>;
  /** 연결 안 된 상태면 throw. 연결 여부 판단은 Controller 가 먼저 한다. */
  send(data: string, ...args: SendArgs<TSend>): void;
  onMessage(callback: (data: TMessage) => void): void;
  onError(callback: (error: Error) => void): void;
  /** 소켓이 닫혔을 때. 수동/비수동 구분은 Controller 가 자기 상태로 판단한다. */
  onClose(callback: (info: SocketCloseInfo) => void): void;
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

  public abstract connect(signal: AbortSignal, config?: C): Promise<void>;
  public abstract disconnect(): Promise<void>;
  public abstract send(data: string, ...args: SendArgs<TSend>): void;
  public abstract onMessage(callback: (data: TMessage) => void): void;
  public abstract onError(callback: (error: Error) => void): void;
  public abstract onClose(callback: (info: SocketCloseInfo) => void): void;
  public abstract onConnect(callback: () => void): void;
  /** 어댑터 내장 상태값 (브라우저 readyState / StompSocketState 등). Controller의 ConnectionState와 별개. */
  public abstract networkStatus(): number;
}
