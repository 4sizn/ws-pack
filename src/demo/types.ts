export type MessageStatus = "sending" | "sent" | "failed";

export interface ChatUser {
  id: string;
  name: string;
  /** 아바타 배경으로 쓰이는 색상 (이미지 대신 사용) */
  color: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  sender: ChatUser;
  /** 내가 보낸 메시지인지 여부. 말풍선 정렬과 색을 결정한다. */
  mine: boolean;
  text: string;
  /** epoch milliseconds */
  sentAt: number;
  /** 아직 읽지 않은 상대방 수. 0이면 표시하지 않는다. */
  unreadCount: number;
  status: MessageStatus;
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface ChatRoom {
  id: string;
  title: string;
  memberCount: number;
  connection: ConnectionState;
  messages: ChatMessage[];
}
