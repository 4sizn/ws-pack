export type { IWebSocketClientAdapter, SendArgs } from "./core/adapters/WebSocketClientAdapter";
export { WebSocketClientAdapter } from "./core/adapters/WebSocketClientAdapter";
export type { DisconnectInfo, SocketCloseInfo } from "./core/CloseInfo";
export { ConnectionState } from "./core/ConnectionState";
export {
  MqttWebSocketController,
  StompWebSocketController,
  WebSocketController,
  WindowWebSocketController,
} from "./core/controllers/NetworkController";
export { MqttWebsocketError } from "./core/errors/MqttWebsocketError";
export { StompStompError } from "./core/errors/StompStompError";
export { StompWebsocketError } from "./core/errors/StompWebsocketError";
export { WindowWebsocketError } from "./core/errors/WindowWebsocketError";
export type { NetworkClient } from "./core/NetworkClient";
export type { PubSubAble } from "./core/PubSubAble";
export {
  AbstractPlugin,
  type Logger,
  LoggingPlugin,
  type PluginLifecycleHooks,
  type WebSocketMonitorHandlers,
  WebSocketMonitorPlugin,
} from "./core/plugins/AbstractPlugin";
export type { ReconnectConfig, ReconnectInfo } from "./core/Reconnect";
export { ReconnectTimeMode } from "./core/Reconnect";
export { randomId } from "./core/randomId";
export type {
  MqttMessage,
  MqttSendOptions,
  MqttSubscribeOptions,
  MqttWebSocketClientOptions,
  StompSendOptions,
  StompWebSocketClientOptions,
  WindowWebSocketClientOptions,
} from "./core/WebSocketClient";
export {
  MqttWebSocketClient,
  StompWebSocketClient,
  WebSocketClient,
  WindowWebSocketClient,
} from "./core/WebSocketClient";

// 워커 기반 사용 — 소비자가 new Worker / new SharedWorker 로 만든 워커에 붙인다.
export {
  type CreateWorkerClientOptions,
  createWorkerClient,
  defaultClientFactory,
  type HubClient,
  type HubClientFactory,
  type MessageLike,
  supportedWorkerModes,
  type WireMessage,
  type WorkerClientConfig,
  type WorkerClientSelection,
  type WorkerCommand,
  type WorkerEvent,
  WorkerHub,
  type WorkerMode,
  WorkerWebSocketClient,
  type WorkerWebSocketClientOptions,
} from "./worker";
