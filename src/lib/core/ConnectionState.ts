/**
 * 서비스에서 쓰는 커넥션 상태.
 *
 * 브라우저 `WebSocket.readyState`(0~3 숫자), stompjs의 `StompSocketState`,
 * `ActivationState`와 값을 절대 섞어 쓰지 않는다. 문자열 리터럴로 정의해서
 * 숫자 상태값과 실수로 비교/할당되는 걸 타입 레벨에서 막는다.
 *
 * WebSocketController가 이 값을 소유하고 `connectionState$`로 구독을 제공한다.
 */
export enum ConnectionState {
  /** 아직 연결을 시도한 적 없음 (초기 상태), 또는 정상적으로 연결 해제된 상태 */
  IDLE = "IDLE",
  /** 최초 연결 시도 중 */
  CONNECTING = "CONNECTING",
  /** 연결됨, 송수신 가능 */
  OPEN = "OPEN",
  /** 연결이 끊겨 재연결 시도 중 (아직 미구현, 재연결 로직 붙을 때 사용) */
  RECONNECTING = "RECONNECTING",
  /** 연결 종료 처리 중 (아직 미구현) */
  CLOSING = "CLOSING",
  /** 연결이 예기치 않게 끊겨 재시도도 실패한 최종 상태 (아직 미구현) */
  CLOSED = "CLOSED",
}
