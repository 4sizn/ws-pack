import { registerProtocolClient } from "./core/protocolRegistry";
import { StompWebSocketClient } from "./core/StompWebSocketClient";

/**
 * STOMP 진입점.
 *
 * 이 모듈을 import 하면 STOMP 구현이 등록되고, 워커 허브와 createWorkerClient 도 쓸 수 있게 된다.
 * `@stomp/stompjs` 에 대한 의존은 이 경로에만 있다 — 쓰지 않는 소비자는 받지 않는다.
 */
registerProtocolClient("stomp", (options) => new StompWebSocketClient(options) as never);

export {
  type StompSendOptions,
  StompWebSocketClientAdapter,
  type StompWebSocketClientOptions,
} from "./core/adapters/StompWebSocketClientAdapter";
export { StompWebSocketController } from "./core/controllers/StompWebSocketController";
export { StompStompError } from "./core/errors/StompStompError";
export { StompWebsocketError } from "./core/errors/StompWebsocketError";
export { StompWebSocketClient } from "./core/StompWebSocketClient";
