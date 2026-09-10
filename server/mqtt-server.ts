import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { Aedes } from "aedes";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * 데모용 MQTT 브로커 (WebSocket 위, aedes). 브라우저에서 `ws://127.0.0.1:8011` 로 붙는다.
 *
 * `ws` 의 createWebSocketStream 대신 직접 Duplex 로 잇는다 — Bun 런타임에서 아직 지원되지 않는다.
 */
const PORT = 8011;

const broker = await Aedes.createBroker();
const http = createServer();
const wss = new WebSocketServer({ server: http });

wss.on("connection", (socket: WebSocket) => {
  broker.handle(toDuplex(socket));
});

broker.on("subscribe", (subscriptions, client) => {
  console.log(`구독: ${client.id} → ${subscriptions.map((s) => s.topic).join(", ")}`);
});
broker.on("clientDisconnect", (client) => {
  console.log(`연결 종료: ${client.id}`);
});

http.listen(PORT, "127.0.0.1", () => {
  console.log(`MQTT(WebSocket) 브로커가 ws://127.0.0.1:${PORT} 에서 실행 중입니다`);
});

function toDuplex(socket: WebSocket): Duplex {
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      socket.send(chunk);
      callback();
    },
    final(callback) {
      socket.close();
      callback();
    },
    destroy(error, callback) {
      socket.close();
      callback(error);
    },
  });

  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    stream.push(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));
  });
  socket.on("close", () => stream.push(null));
  socket.on("error", (error) => stream.destroy(error));

  return stream;
}
