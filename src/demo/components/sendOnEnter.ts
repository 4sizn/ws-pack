/**
 * Enter 키를 전송으로 볼지 판정한다.
 *
 * 컴포넌트에서 떼어낸 이유는 이 판정이 손으로만 확인되던 규칙이기 때문이다 —
 * 한글 IME 에서 메시지가 두 번 전송되던 결함이 여기서 났고, 되돌아와도 테스트가 잡게 한다.
 */
export interface EnterIntent {
  key: string;
  shiftKey: boolean;
  /** IME 조합 중인지. 조합 확정 Enter 와 사용자가 누른 Enter 를 가르는 유일한 신호 */
  isComposing: boolean;
  /** isComposing 을 채우지 않는 구형 브라우저가 조합 중임을 알리는 값 */
  keyCode?: number;
}

export function shouldSendOnEnter(event: EnterIntent): boolean {
  // 조합 중의 Enter 는 "조합 확정" 이지 전송이 아니다. 거르지 않으면 확정 Enter 로 한 번,
  // 사용자가 실제로 누른 Enter 로 또 한 번 — 같은 메시지가 두 번 나간다.
  if (event.isComposing || event.keyCode === 229) {
    return false;
  }
  // Shift+Enter 는 줄바꿈으로 남긴다.
  return event.key === "Enter" && !event.shiftKey;
}
