/**
 * @description MQTT.js 클라이언트의 error 이벤트
 *
 * MQTT 는 소켓 오류와 프로토콜 오류(CONNACK 거절 등)를 같은 error 이벤트로 보낸다.
 * 원인 에러를 그대로 들고 다닌다 — StompWebsocketError / WindowWebsocketError 와 같은 형태.
 */
export class MqttWebsocketError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly cause: Error;
  public readonly details?: unknown;

  constructor(message: string, cause: Error, details?: unknown) {
    super(message);
    this.name = "MqttWebsocketError";
    this.code = "MQTT_WEBSOCKET_ERROR";
    this.timestamp = new Date();
    this.cause = cause;
    this.details = details;
  }
}
