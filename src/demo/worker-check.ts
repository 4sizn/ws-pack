import { WorkerWebSocketClient } from "../lib";

/**
 * SharedWorker 안에서 도는 클라이언트를 실제 브라우저에서 확인하는 페이지.
 *
 * 확인 포인트는 하나다: 탭을 두 개 열어도 에코 서버에 잡히는 연결이 하나여야 한다.
 * 같은 키를 쓰는 손잡이들은 워커 안에서 소켓 하나를 공유하기 때문이다.
 */
const output = document.getElementById("log") as HTMLPreElement;
const lines: string[] = [];
const log = (line: string) => {
  lines.push(`${new Date().toLocaleTimeString("ko-KR")}  ${line}`);
  output.textContent = lines.join("\n");
};

const worker = new SharedWorker(new URL("../lib/worker/socket-worker.ts", import.meta.url), {
  type: "module",
  name: "ws-pack",
});

const client = new WorkerWebSocketClient(
  worker,
  { protocol: "window", options: { url: "ws://127.0.0.1:8010/?room=worker-check" } },
  { key: "worker-check" },
);

client.connectionChanges$.subscribe((state) => log(`상태: ${state}`));
client.error$.subscribe((error) => log(`에러: ${error.name} ${error.message}`));
client.message$.subscribe((message) => log(`수신: ${message.body}`));

await client.connect();
log("연결 완료 — 이 탭의 손잡이가 열렸다");

const tab = Math.random().toString(36).slice(2, 6);
await client.send(`탭 ${tab} 이 보냄`);
log(`전송: 탭 ${tab}`);

window.addEventListener("beforeunload", () => client.destroy());
