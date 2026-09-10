import { describe, expect, it } from "bun:test";
import { shouldSendOnEnter } from "../../src/demo/components/sendOnEnter";

/**
 * 한글 IME 로 입력하면 메시지가 두 번 전송되던 결함의 회귀 테스트.
 * 실기기에서 손으로 확인했던 규칙을 여기서 고정한다.
 */
const enter = (overrides: Partial<Parameters<typeof shouldSendOnEnter>[0]> = {}) => ({
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe("Enter 전송 판정", () => {
  it("보통 Enter 는 전송한다", () => {
    expect(shouldSendOnEnter(enter())).toBe(true);
  });

  it("IME 조합 중의 Enter 는 전송하지 않는다 — 이걸 놓치면 두 번 나간다", () => {
    expect(shouldSendOnEnter(enter({ isComposing: true }))).toBe(false);
  });

  it("isComposing 을 안 채우는 브라우저는 keyCode 229 로 판단한다", () => {
    expect(shouldSendOnEnter(enter({ keyCode: 229 }))).toBe(false);
  });

  it("Shift+Enter 는 줄바꿈이라 전송하지 않는다", () => {
    expect(shouldSendOnEnter(enter({ shiftKey: true }))).toBe(false);
  });

  it("Enter 가 아닌 키는 전송하지 않는다", () => {
    expect(shouldSendOnEnter(enter({ key: "a" }))).toBe(false);
    expect(shouldSendOnEnter(enter({ key: "Escape" }))).toBe(false);
  });
});
