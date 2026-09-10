import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types";
import { formatDateDivider, isSameDay } from "../utils/format";
import { MessageBubble } from "./MessageBubble";

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // 새 메시지가 도착하면 맨 아래로 스크롤한다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length is the intended trigger
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="message-list">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const needsDivider = !previous || !isSameDay(previous.sentAt, message.sentAt);
        const showSender = !previous || previous.sender.id !== message.sender.id || needsDivider;

        return (
          <div key={message.id} style={{ display: "contents" }}>
            {needsDivider && (
              <div className="date-divider">{formatDateDivider(message.sentAt)}</div>
            )}
            <MessageBubble message={message} showSender={showSender} />
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
