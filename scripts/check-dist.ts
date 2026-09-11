/**
 * 빌드 산출물이 소비자에게 실제로 쓸 수 있는 모양인지 확인한다.
 *
 * 타입 검사와 테스트가 통과해도 진입점 설정이 틀리면 설치한 쪽에서만 깨진다.
 * package.json 의 exports 를 따라가 실제로 import 해 보고, 공개 API 가 나오는지 본다.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = await Bun.file(resolve(root, "package.json")).json();

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// exports 가 가리키는 파일이 실제로 있는가
for (const [name, entry] of Object.entries(pkg.exports as Record<string, unknown>)) {
  if (typeof entry === "string") continue;
  for (const [condition, target] of Object.entries(entry as Record<string, string>)) {
    check(existsSync(resolve(root, target)), `exports["${name}"].${condition} 없음: ${target}`);
  }
}

// 공개 API 가 실제로 나오는가
const api = await import(
  resolve(root, (pkg.exports as Record<string, { import: string }>)["."].import)
);
const expected = [
  "WindowWebSocketClient",
  "WorkerWebSocketClient",
  "WorkerHub",
  "createWorkerClient",
  "supportedWorkerModes",
  "ConnectionState",
  "ReconnectTimeMode",
  "randomId",
];
for (const name of expected) {
  check(name in api, `공개 API 누락: ${name}`);
}

// 프로토콜 진입점이 각자의 클라이언트를 내놓는가
const stompApi = await import(resolve(root, "./dist/lib/stomp.js"));
check("StompWebSocketClient" in stompApi, "ws-client-pack/stomp 에 StompWebSocketClient 없음");
const mqttApi = await import(resolve(root, "./dist/lib/mqtt.js"));
check("MqttWebSocketClient" in mqttApi, "ws-client-pack/mqtt 에 MqttWebSocketClient 없음");

// 워커 진입점은 부수 효과 스크립트라 존재만 확인한다 (워커 밖에서는 self 가 없어 실행하지 않는다)
for (const name of ["./worker", "./worker/stomp", "./worker/mqtt"]) {
  const entry = (pkg.exports as Record<string, { import: string }>)[name]?.import;
  check(Boolean(entry) && existsSync(resolve(root, entry)), `진입점 없음: ${name}`);
}

/**
 * 진입점 분리의 핵심 약속: 코어와 워커 허브는 프로토콜 라이브러리를 끌어오지 않는다.
 * 이게 깨지면 순수 WebSocket 만 쓰는 소비자도 stompjs 와 mqtt 를 받게 된다 —
 * 타입 검사도 테스트도 통과하므로, 번들을 직접 읽어서 확인한다.
 */
const protocolLibraries = ["@stomp/stompjs", "mqtt"];
const mustStayClean = ["./dist/lib/index.js", "./dist/lib/worker.js"];
for (const file of mustStayClean) {
  const source = await Bun.file(resolve(root, file)).text();
  for (const library of protocolLibraries) {
    check(
      !new RegExp(`from\\s*["']${library.replace("/", "\\/")}["']`).test(source),
      `${file} 가 ${library} 를 직접 import 한다 — 진입점 분리가 깨졌다`,
    );
  }
}

// 반대로 프로토콜 진입점은 자기 라이브러리를 가지고 있어야 한다
const protocolEntries: Array<[string, string]> = [
  ["./dist/lib/stomp.js", "@stomp/stompjs"],
  ["./dist/lib/mqtt.js", "mqtt"],
];
for (const [file, library] of protocolEntries) {
  const source = await Bun.file(resolve(root, file)).text();
  check(source.includes(library), `${file} 에 ${library} 가 없다`);
}

if (failures.length > 0) {
  console.error("산출물 검증 실패:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `산출물 검증 통과: export ${Object.keys(api).length}개, 진입점 ${Object.keys(pkg.exports).length}개`,
);
