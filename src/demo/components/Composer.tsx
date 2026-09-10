import type { KeyboardEvent } from "react";
import { useState } from "react";

interface ComposerProps {
  disabled?: boolean;
  onSend: (text: string) => void;
}

export function Composer({ disabled = false, onSend }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const canSend = draft.trim().length > 0 && !disabled;

  const send = () => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  };

  // Enter 로 전송하고 Shift+Enter 는 줄바꿈으로 남긴다.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글/일본어 IME 조합 중의 Enter 는 "조합 확정" 이지 전송이 아니다.
    // 이걸 거르지 않으면 확정 Enter 로 한 번, 사용자가 실제로 누른 Enter 로 또 한 번 전송된다.
    // keyCode 229 는 isComposing 을 채우지 않는 구형 브라우저용 같은 신호다.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      <textarea
        className="composer__input"
        rows={1}
        placeholder={disabled ? "연결이 끊겨 전송할 수 없습니다" : "메시지를 입력하세요"}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button type="button" className="composer__send" disabled={!canSend} onClick={send}>
        전송
      </button>
    </div>
  );
}
