/**
 * 무작위 식별자.
 *
 * `crypto.randomUUID()` 는 보안 컨텍스트에서만 존재한다. `http://localhost` 은 보안 취급이지만
 * `http://192.168.0.x` 는 아니어서, 같은 코드가 개발 기기에서는 되고 같은 네트워크의 폰에서는
 * 그 자리에서 TypeError 로 죽는다. 그래서 있으면 쓰고, 없으면 난수로 만든다.
 *
 * 여기서 필요한 건 충돌하지 않는 이름뿐이다 — 암호학적 강도가 필요한 값에는 쓰지 않는다.
 */
export function randomId(): string {
  const source = globalThis.crypto;

  if (typeof source?.randomUUID === "function") {
    return source.randomUUID();
  }

  if (typeof source?.getRandomValues === "function") {
    const bytes = source.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
