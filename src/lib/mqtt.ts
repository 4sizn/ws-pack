import { MqttWebSocketClient } from "./core/MqttWebSocketClient";
import { registerProtocolClient } from "./core/protocolRegistry";

/**
 * MQTT 진입점.
 *
 * 이 모듈을 import 하면 MQTT 구현이 등록되고, 워커 허브와 createWorkerClient 도 쓸 수 있게 된다.
 * `mqtt` 에 대한 의존은 이 경로에만 있다 — 브라우저 번들로 360KB 가 넘으므로, 쓰지 않는 소비자가
 * 받지 않는 것이 중요하다.
 */
registerProtocolClient("mqtt", (options) => new MqttWebSocketClient(options) as never);

export {
  type MqttMessage,
  type MqttSendOptions,
  type MqttSubscribeOptions,
  MqttWebSocketClientAdapter,
  type MqttWebSocketClientOptions,
} from "./core/adapters/MqttWebSocketClientAdapter";
export { MqttWebSocketController } from "./core/controllers/MqttWebSocketController";
export { MqttWebsocketError } from "./core/errors/MqttWebsocketError";
export { MqttWebSocketClient } from "./core/MqttWebSocketClient";
