import { WorkerHub } from "./hub";
import type { MessageLike } from "./protocol";

/**
 * 워커 진입점. 전용 Worker 와 SharedWorker 를 한 파일로 다룬다 — 소비자가 어느 생성자로 만들든
 * 같은 스크립트를 가리킬 수 있어야 하기 때문이다.
 *
 * ```ts
 * new Worker(new URL("ws-pack/worker", import.meta.url), { type: "module" });
 * new SharedWorker(new URL("ws-pack/worker", import.meta.url), { type: "module" });
 * ```
 *
 * 전용 Worker 는 전역 자신이 포트고, SharedWorker 는 connect 이벤트로 포트를 하나씩 받는다.
 * 후자에서만 연결 공유가 의미를 갖는다 — 탭이 여러 개여도 소켓은 하나가 된다.
 */
const hub = new WorkerHub();

interface SharedScope {
  onconnect: ((event: { ports: MessageLike[] }) => void) | null;
}

const scope = self as unknown as SharedScope & MessageLike;

if ("onconnect" in scope) {
  scope.onconnect = (event) => {
    for (const port of event.ports) hub.attach(port);
  };
} else {
  hub.attach(scope);
}
