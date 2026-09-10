import { afterEach, describe, expect, it } from "bun:test";
import { randomId } from "../../src/lib";

/**
 * 보안 컨텍스트가 아닌 곳(http://192.168.x.x 로 연 폰)에서는 crypto.randomUUID 가 아예 없다.
 * 그 자리에서 죽지 않는지가 이 테스트의 전부다.
 */
const cryptoRef = globalThis.crypto as { randomUUID?: unknown; getRandomValues?: unknown };
const original = {
  randomUUID: cryptoRef.randomUUID,
  getRandomValues: cryptoRef.getRandomValues,
};

afterEach(() => {
  cryptoRef.randomUUID = original.randomUUID;
  cryptoRef.getRandomValues = original.getRandomValues;
});

describe("무작위 식별자", () => {
  it("randomUUID 가 있으면 그걸 쓴다", () => {
    expect(randomId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("randomUUID 가 없어도 값을 만든다", () => {
    cryptoRef.randomUUID = undefined;

    const id = randomId();
    expect(id.length).toBeGreaterThan(8);
    expect(randomId()).not.toBe(id);
  });

  it("crypto 자체가 없어도 값을 만든다", () => {
    cryptoRef.randomUUID = undefined;
    cryptoRef.getRandomValues = undefined;

    expect(randomId().length).toBeGreaterThan(8);
  });
});
