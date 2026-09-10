import type { KeyboardEvent } from "react";
import { useState } from "react";
import { shouldSendOnEnter } from "./sendOnEnter";

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

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const sendNow = shouldSendOnEnter({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    });
    if (!sendNow) return;
    event.preventDefault();
    send();
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
