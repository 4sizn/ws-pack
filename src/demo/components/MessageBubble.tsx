import type { ChatMessage } from "../types"
import { formatTime } from "../utils/format"
import { Avatar } from "./Avatar"

interface MessageBubbleProps {
  message: ChatMessage
  /** 직전 메시지와 발신자가 같으면 이름과 아바타를 생략한다. */
  showSender: boolean
}

export function MessageBubble({ message, showSender }: MessageBubbleProps) {
  const { mine, sender, text, sentAt, unreadCount, status } = message

  return (
    <div className={`message-row${mine ? " message-row--mine" : ""}`}>
      {!mine &&
        (showSender ? (
          <Avatar user={sender} />
        ) : (
          <div className="avatar" style={{ background: "transparent" }} />
        ))}

      <div className="message-body">
        {!mine && showSender && <span className="message-sender">{sender.name}</span>}

        <div className="bubble-line">
          <div className={`bubble${mine ? " bubble--mine" : ""}`}>{text}</div>
          <div className="bubble-meta">
            {unreadCount > 0 && <span className="bubble-meta__unread">{unreadCount}</span>}
            <span>{formatTime(sentAt)}</span>
            {status === "failed" && <span className="bubble-meta__status">전송 실패</span>}
            {status === "sending" && <span>전송 중</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
