import type { Observable } from "rxjs";

/**
 * destination/topic 단위 pub/sub 이 되는 프로토콜의 계약 (STOMP, MQTT).
 * 순수 WebSocket(Window) 은 destination 개념이 없으므로 구현하지 않는다 — send/message$ 만 쓴다.
 *
 * Adapter / Controller / Client 세 계층이 같은 시그니처로 구현해서, 어느 계층을 잡고 있든
 * "이건 pub/sub 되는 놈" 인지 타입으로 판단할 수 있다.
 *
 * publish 는 여기 없다 — send(data, options) 가 TSend 로 destination 을 받는다.
 *
 * @template TMessage          구독으로 받는 메시지 타입 (Stomp: IMessage)
 * @template TSubscribeOptions 구독 옵션 (Stomp: StompHeaders, Mqtt: qos 등). 없으면 undefined
 */
export interface PubSubAble<TMessage, TSubscribeOptions = undefined> {
  /**
   * destination 구독. 연결 전에 불러도 되고(연결되면 걸림), 재연결되면 자동으로 다시 걸린다.
   * 반환 Observable 을 unsubscribe 하면 브로커 구독도 해제된다.
   */
  subscribe(destination: string, options?: TSubscribeOptions): Observable<TMessage>;
}
