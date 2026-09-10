/**
 * @description 브라우저 WebSocket 의 error 이벤트
 *
 * WebSocket 의 error 이벤트는 사유를 담지 않는다. 사유는 뒤따르는 close 의 code 에 있으므로
 * 여기서는 원본 이벤트만 그대로 들고 다닌다 — StompWebsocketError 와 같은 형태.
 */
export class WindowWebsocketError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly event: Event;
  public readonly details?: unknown;

  constructor(message: string, event: Event, details?: unknown) {
    super(message);
    this.name = "WindowWebsocketError";
    this.code = "WINDOW_WEBSOCKET_ERROR";
    this.timestamp = new Date();
    this.event = event;
    this.details = details;
  }
}
