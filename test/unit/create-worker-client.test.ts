import { afterEach, describe, expect, it } from "bun:test";
import type { WorkerClientConfig } from "../../src/lib";
import { createWorkerClient, supportedWorkerModes } from "../../src/lib";

/**
 * 폴백 규칙만 확인한다. 실제 워커를 띄우지 않고, 전역에 생성자가 있는지 없는지만 바꿔 가며 본다 —
 * iOS Safari 에 SharedWorker 가 없는 상황이 정확히 그 모양이다.
 */

const config: WorkerClientConfig = {
  protocol: "window",
  options: { url: "ws://example.invalid" },
};

const globals = globalThis as {
  SharedWorker?: unknown;
  Worker?: unknown;
};
const original = { SharedWorker: globals.SharedWorker, Worker: globals.Worker };

/** 생성자를 흉내만 낸다. 팩토리가 무엇을 고르는지가 시험 대상이라 실제 워커는 필요 없다. */
class FakePort {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  start(): void {}
}
class FakeSharedWorker {
  port = new FakePort();
}
class FakeWorker extends FakePort {}

afterEach(() => {
  globals.SharedWorker = original.SharedWorker;
  globals.Worker = original.Worker;
});

describe("워커 모드 선택", () => {
  it("SharedWorker 가 있으면 공유를 고른다", () => {
    globals.SharedWorker = FakeSharedWorker;
    globals.Worker = FakeWorker;

    const chosen = createWorkerClient({ config, workerUrl: "worker.js" });

    expect(chosen.mode).toBe("shared");
    expect(chosen.skipped).toEqual([]);
  });

  it("SharedWorker 가 없으면 전용 Worker 로 내려가고 이유를 남긴다", () => {
    globals.SharedWorker = undefined;
    globals.Worker = FakeWorker;

    const chosen = createWorkerClient({ config, workerUrl: "worker.js" });

    expect(chosen.mode).toBe("dedicated");
    expect(chosen.skipped).toEqual([{ mode: "shared", reason: "이 환경에 SharedWorker 가 없다" }]);
  });

  it("워커 주소가 없으면 워커 모드를 아예 건너뛴다", () => {
    globals.SharedWorker = FakeSharedWorker;
    globals.Worker = FakeWorker;

    const chosen = createWorkerClient({ config });

    expect(chosen.mode).toBe("main");
    expect(chosen.skipped.map((entry) => entry.mode)).toEqual(["shared", "dedicated"]);
  });

  it("선호 순서를 뒤집으면 그대로 따른다", () => {
    globals.SharedWorker = FakeSharedWorker;
    globals.Worker = FakeWorker;

    const chosen = createWorkerClient({
      config,
      workerUrl: "worker.js",
      prefer: ["dedicated", "shared"],
    });

    expect(chosen.mode).toBe("dedicated");
  });

  it("메인 스레드만 남아도 클라이언트는 나온다", () => {
    globals.SharedWorker = undefined;
    globals.Worker = undefined;

    const chosen = createWorkerClient({ config, workerUrl: "worker.js" });

    expect(chosen.mode).toBe("main");
    expect(chosen.client.connectionState).toBeDefined();
  });

  it("supportedWorkerModes 는 이 환경에서 가능한 것만 알려준다", () => {
    globals.SharedWorker = undefined;
    globals.Worker = FakeWorker;

    expect(supportedWorkerModes()).toEqual(["dedicated", "main"]);
  });
});
