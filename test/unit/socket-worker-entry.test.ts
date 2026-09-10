import { afterEach, describe, expect, it } from "bun:test";

/**
 * 워커 진입점은 import 만으로 동작하는 부수 효과 스크립트다.
 *
 * 확인할 것은 하나뿐이다: 전역 스코프를 보고 전용 Worker 와 SharedWorker 를 가려내는가.
 * 전용은 전역 자신이 포트고, SharedWorker 는 connect 이벤트로 포트를 하나씩 받는다.
 * 실제 워커를 띄우지 않고 전역만 흉내 내서, 그 분기만 떼어 본다.
 */

type Listener = (event: { data: unknown }) => void;

class FakePort {
  readonly listeners: Listener[] = [];
  readonly posted: unknown[] = [];
  started = 0;

  addEventListener(_type: "message", listener: Listener): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: "message", listener: Listener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  start(): void {
    this.started += 1;
  }
  /** 페이지가 보낸 명령을 흉내 낸다 */
  deliver(data: unknown): void {
    for (const listener of [...this.listeners]) listener({ data });
  }
}

const globals = globalThis as { self?: unknown };
const originalSelf = globals.self;

afterEach(() => {
  globals.self = originalSelf;
});

/** 진입점을 스코프마다 새로 읽어 온다. 모듈 캐시를 피하려고 질의 문자열을 바꾼다. */
async function loadEntry(tag: string): Promise<void> {
  await import(`../../src/lib/worker/socket-worker.ts?entry=${tag}`);
}

describe("워커 진입점", () => {
  it("전용 Worker 에서는 전역 자신을 포트로 붙인다", async () => {
    const scope = new FakePort();
    globals.self = scope;

    await loadEntry("dedicated");

    expect(scope.listeners.length).toBe(1);
    expect(scope.started).toBe(1);
  });

  it("SharedWorker 에서는 connect 로 받은 포트마다 붙인다", async () => {
    const scope = new FakePort() as FakePort & {
      onconnect: ((event: { ports: FakePort[] }) => void) | null;
    };
    scope.onconnect = null;
    globals.self = scope;

    await loadEntry("shared");

    // 전역 자신에는 붙지 않는다 — 포트는 connect 이벤트로만 온다.
    expect(scope.listeners.length).toBe(0);
    expect(typeof scope.onconnect).toBe("function");

    const first = new FakePort();
    const second = new FakePort();
    scope.onconnect?.({ ports: [first, second] });

    expect(first.listeners.length).toBe(1);
    expect(second.listeners.length).toBe(1);
  });

  it("붙은 포트가 알 수 없는 손잡이 명령을 받아도 죽지 않는다", async () => {
    const scope = new FakePort();
    globals.self = scope;

    await loadEntry("resilient");
    // 붙지 않았다면 아래 전달은 아무 일도 하지 않아 시험이 공허해진다.
    expect(scope.listeners.length).toBe(1);

    expect(() => scope.deliver({ type: "release", handle: "없는-손잡이" })).not.toThrow();
    expect(() =>
      scope.deliver({ type: "unsubscribe", handle: "없는-손잡이", subscription: "x" }),
    ).not.toThrow();
    expect(() => scope.deliver("명령이 아닌 값")).not.toThrow();
  });
});
