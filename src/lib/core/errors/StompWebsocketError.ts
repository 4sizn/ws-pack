/**
 * @description StompConfig.onWebSocketError 에러
 */
export class StompWebsocketError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly event: Event;
  public readonly details?: unknown;

  constructor(message: string, event: Event, details?: unknown) {
    super(message);
    this.name = "StompWebsocketError";
    this.code = "STOMP_WEBSOCKET_ERROR";
    this.timestamp = new Date();
    this.event = event;
    this.details = details;
  }
}
