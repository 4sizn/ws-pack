/**
 * 소켓이 닫힌 사유. CloseEvent 의 정보를 라이브러리 타입으로 옮겨 담는다.
 *
 * DOM `CloseEvent` 를 그대로 노출하지 않는 이유: 어댑터마다 소켓 구현이 다르고(브라우저 WebSocket,
 * node ws, stompjs 가 합성한 종료 이벤트), 소비자가 알아야 하는 건 "왜 닫혔나" 뿐이다.
 */
export interface SocketCloseInfo {
  /** WebSocket close code. 1000 정상 종료, 1006 비정상 종료, 4001 stompjs 강제 폐기 */
  code?: number;
  reason?: string;
  /** 종료 핸드셰이크가 정상적으로 끝났는가 */
  wasClean?: boolean;
}

/** 연결이 끊긴 사건. 우리가 끊었는지(manual) 를 컨트롤러가 덧붙인다. */
export interface DisconnectInfo extends SocketCloseInfo {
  /** disconnect() 호출로 끊긴 경우 true. 소켓이 예기치 않게 닫힌 경우 false. */
  manual: boolean;
}
