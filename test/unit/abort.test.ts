import { describe, expect, it } from "bun:test";
import { abortReason, onAbort } from "../../src/lib/core/abort";

describe("취소 신호", () => {
  it("아직 취소되지 않았으면 취소 시점에 한 번 실행한다", () => {
    const controller = new AbortController();
    let calls = 0;
    onAbort(controller.signal, () => {
      calls += 1;
    });

    expect(calls).toBe(0);
    controller.abort();
    controller.abort(); // 두 번째 abort 는 아무 일도 하지 않는다
    expect(calls).toBe(1);
  });

  it("이미 취소된 신호면 즉시 실행한다 — addEventListener 만으로는 놓치는 구멍", () => {
    const controller = new AbortController();
    controller.abort();

    let calls = 0;
    onAbort(controller.signal, () => {
      calls += 1;
    });

    expect(calls).toBe(1);
  });

  it("취소 사유가 Error 면 그대로, 아니면 Error 로 바꿔 준다", () => {
    const withReason = new AbortController();
    const reason = new Error("stop");
    withReason.abort(reason);
    expect(abortReason(withReason.signal)).toBe(reason);

    const withoutReason = new AbortController();
    withoutReason.abort("문자열 사유");
    const normalized = abortReason(withoutReason.signal);
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toBe("connect aborted");
  });
});
