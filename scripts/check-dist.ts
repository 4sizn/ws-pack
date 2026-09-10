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
  "StompWebSocketClient",
  "WindowWebSocketClient",
  "MqttWebSocketClient",
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

// 워커 진입점은 부수 효과 스크립트라 import 만 확인한다 (워커 밖에서는 self 가 없어 실행하지 않는다)
const workerEntry = (pkg.exports as Record<string, { import: string }>)["./worker"].import;
check(existsSync(resolve(root, workerEntry)), `워커 진입점 없음: ${workerEntry}`);

if (failures.length > 0) {
  console.error("산출물 검증 실패:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `산출물 검증 통과: export ${Object.keys(api).length}개, 진입점 ${Object.keys(pkg.exports).length}개`,
);
