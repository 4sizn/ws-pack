import { describe, expect, it } from "bun:test";
import {
  computeReconnectDelay,
  DEFAULT_RECONNECT_CONFIG,
  nextReconnectDelay,
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

describe("재연결 지터", () => {
  it("기본으로 켜져 있다 — 끄려면 명시해야 한다", () => {
    expect(resolveReconnectConfig().jitter).toBe(true);
    expect(resolveReconnectConfig({ jitter: false }).jitter).toBe(false);
  });

  it("equal jitter — 기본 지연의 절반부터 전부까지만 준다", () => {
    const config = resolveReconnectConfig({ delay: 1000, maxDelay: 10_000 });
    expect(nextReconnectDelay(config, 1, () => 0)).toBe(500);
    expect(nextReconnectDelay(config, 1, () => 1)).toBe(1000);
    expect(nextReconnectDelay(config, 1, () => 0.5)).toBe(750);
    // 상한에 걸린 지연도 같은 규칙을 따른다
    expect(nextReconnectDelay(config, 5, () => 0)).toBe(5000);
    expect(nextReconnectDelay(config, 5, () => 1)).toBe(10_000);
  });

  it("끄면 기본 지연을 그대로 준다", () => {
    const config = resolveReconnectConfig({ delay: 1000, jitter: false });
    expect([1, 2, 3].map((attempt) => nextReconnectDelay(config, attempt, () => 0))).toEqual([
      1000, 2000, 4000,
    ]);
  });

  it("INTERVAL 도 흔든다 — 무리가 몰리는 건 계산 방식과 무관하다", () => {
    const config = resolveReconnectConfig({ timeMode: ReconnectTimeMode.INTERVAL, delay: 300 });
    expect(nextReconnectDelay(config, 1, () => 0)).toBe(150);
    expect(nextReconnectDelay(config, 9, () => 1)).toBe(300);
  });

  it("실제 난수로도 범위를 벗어나지 않고, 값이 하나로 몰리지 않는다", () => {
    const config = resolveReconnectConfig({ delay: 1000 });
    const draws = Array.from({ length: 200 }, () => nextReconnectDelay(config, 3));
    for (const draw of draws) {
      expect(draw).toBeGreaterThanOrEqual(2000);
      expect(draw).toBeLessThanOrEqual(4000);
    }
    expect(new Set(draws).size).toBeGreaterThan(50);
  });
});
