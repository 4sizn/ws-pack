import type { ChatMessage, ChatUser } from "../types";

/** 방에 흘리는 메시지 포맷. body 는 이 JSON 의 문자열. */
export interface WirePayload {
  id: string;
  /** 발신 클라이언트 인스턴스 식별자. 내가 보낸 메시지인지 판별하는 유일한 기준. */
  clientId: string;
  sender: ChatUser;
  text: string;
  sentAt: number;
}

export function buildPayload(clientId: string, sender: ChatUser, text: string): WirePayload {
  return { id: crypto.randomUUID(), clientId, sender, text, sentAt: Date.now() };
}

const unknownSender: ChatUser = { id: "unknown", name: "알 수 없음", color: "#dfe4ea" };

/**
 * 수신 본문을 화면 모델로 변환. 다른 도구가 같은 방에 쏜 평문도 버리지 않고 그대로 보여준다.
 */
export function toChatMessage(body: string, roomId: string, clientId: string): ChatMessage {
  const payload = parse(body);

  if (!payload) {
    return {
      id: `${roomId}-raw-${crypto.randomUUID()}`,
      roomId,
      sender: unknownSender,
      mine: false,
      text: body,
      sentAt: Date.now(),
      unreadCount: 0,
      status: "sent",
    };
  }

  return {
    id: `${roomId}-${payload.id}`,
    roomId,
    sender: payload.sender,
    mine: payload.clientId === clientId,
    text: payload.text,
    sentAt: payload.sentAt,
    unreadCount: 0,
    status: "sent",
  };
}

function parse(body: string): WirePayload | null {
  try {
    const value = JSON.parse(body) as Partial<WirePayload>;
    if (typeof value?.text !== "string" || typeof value?.clientId !== "string") {
      return null;
    }
    return {
      id: value.id ?? crypto.randomUUID(),
      clientId: value.clientId,
      sender: value.sender ?? unknownSender,
      text: value.text,
      sentAt: value.sentAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}
