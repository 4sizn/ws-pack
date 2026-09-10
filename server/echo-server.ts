import WebSocket from "ws";

// WebSocket 서버 설정 타입 정의
interface ServerConfig {
  port: number;
}

// 서버 설정
const config: ServerConfig = {
  port: 8010,
};

// WebSocket 서버 생성
const wss = new WebSocket.Server(config);

console.log(`WebSocket 서버가 ws://localhost:${config.port} 에서 실행 중입니다`);

// 클라이언트 연결 처리
wss.on("connection", (ws: WebSocket) => {
  console.log("클라이언트가 연결되었습니다");

  // 클라이언트로부터 메시지 수신
  ws.on("message", (message: WebSocket.RawData) => {
    const messageString = message.toString();
    console.log(`클라이언트로부터 받은 메시지: ${messageString}`);

    // 에코 응답
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(`서버 응답: ${messageString}`);
      }
    }
  });

  // 연결 종료 처리
  ws.on("close", () => {
    console.log("클라이언트 연결이 종료되었습니다");
  });

  // 오류 처리
  ws.on("error", (error: Error) => {
    console.error("WebSocket 오류:", error);
  });

  // 연결 성공 메시지 전송
  ws.send("서버에 연결되었습니다!");
});

// 서버 오류 처리
wss.on("error", (error: Error) => {
  console.error("서버 오류:", error);
});
