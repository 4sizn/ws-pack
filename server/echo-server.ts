import WebSocket from "ws";

/**
 * 데모용 순수 WebSocket 서버. destination 개념이 없으므로 방은 접속 URL 로 정한다:
 * `ws://127.0.0.1:8010/?room=<name>` 으로 붙은 참가자끼리만 서로의 메시지를 받는다.
 *
 * 발신자에게도 되돌려 보낸다 — 데모가 낙관적 추가 없이 서버 에코만 렌더하기 때문이고,
 * STOMP 브로커의 fanout 과 규칙을 맞추기 위함이다.
 */
interface ServerConfig {
  port: number;
  host: string;
}

const config: ServerConfig = {
  port: 8010,
  // 같은 네트워크의 다른 기기(폰)에서도 붙을 수 있게 모든 인터페이스에 연다. 데모용 서버다.
  host: "0.0.0.0",
};

const wss = new WebSocket.Server(config);
const rooms = new Map<WebSocket, string>();

console.log(`WebSocket 서버가 ws://localhost:${config.port} 에서 실행 중입니다`);

wss.on("connection", (ws: WebSocket, request) => {
  const room = new URL(request.url ?? "/", "ws://localhost").searchParams.get("room") ?? "";
  rooms.set(ws, room);
  console.log(`클라이언트 연결: room=${room || "(없음)"} (현재 ${rooms.size}개)`);

  ws.on("message", (message: WebSocket.RawData) => {
    const payload = message.toString();
    for (const [client, joined] of rooms) {
      if (joined === room && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });

  ws.on("close", () => {
    rooms.delete(ws);
    console.log(`클라이언트 종료: room=${room || "(없음)"} (남은 ${rooms.size}개)`);
  });

  ws.on("error", (error: Error) => {
    rooms.delete(ws);
    console.error("WebSocket 오류:", error);
  });
});

wss.on("error", (error: Error) => {
  console.error("서버 오류:", error);
});
