import { registerProtocolClient } from "./protocolRegistry";
import { WindowWebSocketClient } from "./WebSocketClient";

/**
 * 순수 WebSocket 구현을 등록한다.
 *
 * 외부 라이브러리를 쓰지 않으므로 코어 진입점과 워커 허브 양쪽에서 기본으로 싣는다 —
 * 페이지에서만 등록하면 워커 안에서는 등록되지 않은 프로토콜이 된다(실제로 그렇게 깨졌다).
 */
registerProtocolClient("window", (options) => new WindowWebSocketClient(options) as never);
