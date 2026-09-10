import type { IMessage } from "@stomp/stompjs";
import { ReconnectTimeMode, StompWebSocketClient } from "../../lib";
import type { ChatMessage, ChatUser } from "../types";

/**
 * 데모용 브로커 접속 정보. 기본값은 docker-compose.test.yml 의 RabbitMQ web-stomp.
 * `bun run stomp:up` 으로 띄운 뒤 `bun run dev`.
 */
const brokerURL = import.meta.env.VITE_STOMP_URL ?? "ws://127.0.0.1:15674/ws";
const login = import.meta.env.VITE_STOMP_LOGIN ?? "test";
const passcode = import.meta.env.VITE_STOMP_PASSCODE ?? "test";

/**
 * 방 하나당 클라이언트 인스턴스 하나. 인스턴스끼리 소켓/구독/재연결 상태를 전혀 공유하지 않는다.
 * 한 방을 끊어도 나머지 두 방은 그대로 붙어 있는 게 이 데모의 확인 포인트다.
 */
export function createRoomClient(): StompWebSocketClient {
  return new StompWebSocketClient({
    brokerURL,
    connectHeaders: { login, passcode },
    reconnect: {
      maxAttempts: 5,
      delay: 1000,
      timeMode: ReconnectTimeMode.EXPONENTIAL,
      maxDelay: 10_000,
    },
  });
}

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
 * 수신 프레임을 화면 모델로 변환. 다른 도구가 같은 destination 에 쏜 평문도 버리지 않고 그대로 보여준다.
 */
export function toChatMessage(frame: IMessage, roomId: string, clientId: string): ChatMessage {
  const payload = parse(frame.body);

  if (!payload) {
    return {
      id: `${roomId}-raw-${crypto.randomUUID()}`,
      roomId,
      sender: unknownSender,
      mine: false,
      text: frame.body,
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
