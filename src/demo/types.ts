import type { ConnectionState } from "../lib";

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

export type { ConnectionState };

export interface ChatRoom {
  id: string;
  title: string;
  memberCount: number;
  /** 이 방이 붙는 STOMP destination. 방 하나당 클라이언트 인스턴스 하나가 여기에 구독/발행한다. */
  destination: string;
  /** 화면 초기 표시용 과거 메시지. 실시간 메시지는 뒤에 붙는다. */
  messages: ChatMessage[];
}
