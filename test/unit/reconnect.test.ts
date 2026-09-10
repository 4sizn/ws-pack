import { describe, expect, it } from "bun:test";
import {
  computeReconnectDelay,
  DEFAULT_RECONNECT_CONFIG,
  ReconnectTimeMode,
  resolveReconnectConfig,
} from "../../src/lib/core/Reconnect";

describe("재연결 정책", () => {
  it("넘기지 않은 값은 기본값으로 채운다", () => {
    expect(resolveReconnectConfig()).toEqual(DEFAULT_RECONNECT_CONFIG);
    expect(resolveReconnectConfig({ maxAttempts: 2 })).toEqual({
      ...DEFAULT_RECONNECT_CONFIG,
      maxAttempts: 2,
    });
  });

  it("INTERVAL 은 시도 횟수와 무관하게 같은 간격을 준다", () => {
    const config = resolveReconnectConfig({ timeMode: ReconnectTimeMode.INTERVAL, delay: 300 });
    expect([1, 2, 5].map((attempt) => computeReconnectDelay(config, attempt))).toEqual([
      300, 300, 300,
    ]);
  });

  it("EXPONENTIAL 은 2배씩 늘리고 maxDelay 에서 멈춘다", () => {
    const config = resolveReconnectConfig({ delay: 100, maxDelay: 500 });
    expect([1, 2, 3, 4, 5].map((attempt) => computeReconnectDelay(config, attempt))).toEqual([
      100, 200, 400, 500, 500,
    ]);
  });

  it("첫 시도(0 이하)도 기본 지연으로 계산한다 — 음수 지수가 되면 안 된다", () => {
    const config = resolveReconnectConfig({ delay: 100 });
    expect(computeReconnectDelay(config, 0)).toBe(100);
    expect(computeReconnectDelay(config, -1)).toBe(100);
  });
});
