/**
 * 취소는 플랫폼 표준(AbortSignal)으로 표현한다. 자체 플래그/세대 카운터를 두지 않는 이유:
 * 그런 변수는 "누가 언제 무효화됐는가"를 각 호출부가 다시 해석해야 하고, 해석이 틀리면
 * 아무도 소유하지 않는 소켓이 남는다. AbortSignal 은 그 판단을 한 곳(signal.aborted)으로 모은다.
 */

/**
 * 이미 취소된 신호면 즉시, 아니면 취소 시점에 한 번 실행한다.
 * `addEventListener` 는 이미 abort 된 신호에 대해 콜백을 부르지 않으므로 그 구멍을 막는다.
 */
export function onAbort(signal: AbortSignal, callback: () => void): void {
  if (signal.aborted) {
    callback();
    return;
  }
  signal.addEventListener("abort", callback, { once: true });
}
