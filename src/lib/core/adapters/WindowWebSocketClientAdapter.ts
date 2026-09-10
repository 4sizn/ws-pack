import type { SocketCloseInfo } from "../CloseInfo";
import type { AbstractPlugin, Logger } from "../plugins/AbstractPlugin";
import type { ReconnectConfig } from "../Reconnect";
import { WebSocketClientAdapter } from "./WebSocketClientAdapter";

/** 브라우저 내장 `WebSocket` 생성자가 받는 인자 타입 (url, protocols) */
type BrowserWebSocketArgs = ConstructorParameters<typeof WebSocket>;

export interface WindowWebSocketClientOptions {
  /** `new WebSocket(url, protocols)` 의 url과 동일한 타입 */
  url: BrowserWebSocketArgs[0];
  /** `new WebSocket(url, protocols)` 의 protocols와 동일한 타입 */
  protocols?: BrowserWebSocketArgs[1];
  /** 이미 만들어진 WebSocket 인스턴스를 주입. 없으면 어댑터가 내부에서 기본 생성한다. */
  client?: WebSocket;
  /** 재연결 정책 (Controller가 소비) */
  reconnect?: ReconnectConfig;
  logger?: Logger;
  plugins?: AbstractPlugin[];
}

// TODO: 브라우저 WebSocket 실제 연결 구현
export class WindowWebSocketClientAdapter extends WebSocketClientAdapter<
  WebSocket,
  WindowWebSocketClientOptions
> {
  // TODO: 실제 WebSocket 생성 시 이 옵션을 사용한다 (connect()가 아직 구현 안 됨)
  constructor(_options: WindowWebSocketClientOptions) {
    super();
  }

  public connect(_signal: AbortSignal, _config?: WindowWebSocketClientOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
  public disconnect(): Promise<void> {
    throw new Error("Method not implemented.");
  }
  public send(_data: string): void {
    throw new Error("Method not implemented.");
  }
  public onMessage(_callback: (data: string) => void): void {
    throw new Error("Method not implemented.");
  }
  public onError(_callback: (error: Error) => void): void {
    throw new Error("Method not implemented.");
  }
  public onClose(_callback: (info: SocketCloseInfo) => void): void {
    throw new Error("Method not implemented.");
  }
  public onConnect(_callback: () => void): void {
    throw new Error("Method not implemented.");
  }
  public networkStatus(): number {
    throw new Error("Method not implemented.");
  }
}
