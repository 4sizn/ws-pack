// 순수 WebSocket 은 외부 라이브러리가 없으므로 기본으로 등록한다.
import "./core/windowProtocol";

export type { IWebSocketClientAdapter, SendArgs } from "./core/adapters/WebSocketClientAdapter";
export { WebSocketClientAdapter } from "./core/adapters/WebSocketClientAdapter";
export type { WindowHeartbeatConfig } from "./core/adapters/WindowWebSocketClientAdapter";
export type { DisconnectInfo, SocketCloseInfo } from "./core/CloseInfo";
export { ConnectionState } from "./core/ConnectionState";
export {
  WebSocketController,
  WindowWebSocketController,
} from "./core/controllers/NetworkController";
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
export {
  type ProtocolClientFactory,
  type ProtocolName,
  registeredProtocols,
  registerProtocolClient,
} from "./core/protocolRegistry";
export type { ReconnectConfig, ReconnectInfo } from "./core/Reconnect";
export { ReconnectTimeMode } from "./core/Reconnect";
export { randomId } from "./core/randomId";
export type { WindowWebSocketClientOptions } from "./core/WebSocketClient";
export { WebSocketClient, WindowWebSocketClient } from "./core/WebSocketClient";

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
  type WorkerHubOptions,
  type WorkerMode,
  WorkerWebSocketClient,
  type WorkerWebSocketClientOptions,
} from "./worker";
