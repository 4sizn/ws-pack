import { useState } from "react"
import type { ChatMessage, ChatRoom as ChatRoomModel } from "../types"
import { ChatHeader } from "./ChatHeader"
import { Composer } from "./Composer"
import { MessageList } from "./MessageList"

interface ChatRoomProps {
  room: ChatRoomModel
}

/**
 * UI 전용 채팅방. 전송은 지금 로컬 상태에만 반영한다.
 * 이후 ws-pack 라이브러리의 STOMP 구독으로 교체한다.
 */
export function ChatRoom({ room }: ChatRoomProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(room.messages)

  const handleSend = (text: string) => {
    const message: ChatMessage = {
      id: `${room.id}-local-${Date.now()}`,
      roomId: room.id,
      sender: { id: "me", name: "나", color: "#ffe066" },
      mine: true,
      text,
      sentAt: Date.now(),
      unreadCount: room.memberCount - 1,
      status: room.connection === "connected" ? "sent" : "sending",
    }
    setMessages((current) => [...current, message])
  }

  return (
    <section className="chat-room">
      <ChatHeader title={room.title} memberCount={room.memberCount} connection={room.connection} />
      <MessageList messages={messages} />
      <Composer disabled={room.connection === "disconnected"} onSend={handleSend} />
    </section>
  )
}
