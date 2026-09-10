import type { ConnectionState } from "../types";

const stateLabel: Record<ConnectionState, string> = {
  connected: "연결됨",
  connecting: "연결 중",
  disconnected: "연결 끊김",
};

interface ChatHeaderProps {
  title: string;
  memberCount: number;
  connection: ConnectionState;
}

export function ChatHeader({ title, memberCount, connection }: ChatHeaderProps) {
  return (
    <header className="chat-header">
      <span className="chat-header__title">{title}</span>
      <span className="chat-header__count">{memberCount}</span>
      <span className="chat-header__status">
        <i className={`status-dot status-dot--${connection}`} />
        {stateLabel[connection]}
      </span>
    </header>
  );
}
