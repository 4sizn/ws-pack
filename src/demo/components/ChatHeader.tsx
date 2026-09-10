import type { KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import type { ReconnectInfo } from "../../lib";
import { ConnectionState } from "../../lib";

const stateLabel: Record<ConnectionState, string> = {
  [ConnectionState.IDLE]: "대기",
  [ConnectionState.CONNECTING]: "연결 중",
  [ConnectionState.OPEN]: "연결됨",
  [ConnectionState.RECONNECTING]: "재연결 중",
  [ConnectionState.CLOSING]: "종료 중",
  [ConnectionState.CLOSED]: "연결 끊김",
};

interface ChatHeaderProps {
  title: string;
  memberCount: number;
  destination: string;
  connection: ConnectionState;
  reconnect: ReconnectInfo;
  onConnect: () => void;
  onDisconnect: () => void;
  onDestinationChange: (destination: string) => void;
}

export function ChatHeader({
  title,
  memberCount,
  destination,
  connection,
  reconnect,
  onConnect,
  onDisconnect,
  onDestinationChange,
}: ChatHeaderProps) {
  // 타이핑 중에 매 글자마다 재연결하지 않도록, 커밋(Enter/blur) 시점에만 상위로 올린다.
  const [draft, setDraft] = useState(destination);
  useEffect(() => setDraft(destination), [destination]);

  const commit = () => {
    const next = draft.trim();
    if (!next || next === destination) {
      setDraft(destination);
      return;
    }
    onDestinationChange(next);
  };

  const canConnect = connection === ConnectionState.IDLE || connection === ConnectionState.CLOSED;
  const canDisconnect =
    connection === ConnectionState.CONNECTING ||
    connection === ConnectionState.OPEN ||
    connection === ConnectionState.RECONNECTING;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  };

  return (
    <header className="chat-header">
      <div className="chat-header__row">
        <span className="chat-header__title">{title}</span>
        <span className="chat-header__count">{memberCount}</span>
        <span className="chat-header__status">
          <i className={`status-dot status-dot--${connection.toLowerCase()}`} />
          {stateLabel[connection]}
          {connection === ConnectionState.RECONNECTING && (
            <span>
              {" "}
              {reconnect.attempts}/{reconnect.maxAttempts}
            </span>
          )}
        </span>
      </div>

      <div className="chat-header__row chat-header__row--sub">
        <input
          className="chat-header__destination"
          value={draft}
          spellCheck={false}
          aria-label={`${title} destination`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="chat-header__action"
          disabled={!canConnect}
          onClick={onConnect}
        >
          연결
        </button>
        <button
          type="button"
          className="chat-header__action"
          disabled={!canDisconnect}
          onClick={onDisconnect}
        >
          해제
        </button>
      </div>
    </header>
  );
}
