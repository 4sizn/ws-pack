import { useState } from "react";
import { ChatRoom } from "./components/ChatRoom";
import { mockRooms } from "./data/mockRooms";
import type { Protocol } from "./transport/roomTransport";
import type { ChatUser } from "./types";
import "./styles/chat.css";

const me: ChatUser = { id: "me", name: "나", color: "#ffe066" };

/** 3개 인스턴스를 한 방에 모을 때 쓰는 이름. */
const SHARED_ROOM = "ws-pack.shared";

type Rooms = Record<string, string>;

const separated: Rooms = Object.fromEntries(mockRooms.map((room) => [room.id, room.room]));
const shared: Rooms = Object.fromEntries(mockRooms.map((room) => [room.id, SHARED_ROOM]));

const protocolLabel: Record<Protocol, string> = {
  stomp: "STOMP",
  window: "WebSocket",
};

const protocolHint: Record<Protocol, string> = {
  stomp: "RabbitMQ web-stomp (ws://127.0.0.1:15674/ws) — bun run stomp:up",
  window: "순수 WebSocket 에코 서버 (ws://127.0.0.1:8010) — bun run ws:server",
};

/**
 * 검증 시나리오를 두 축으로 전환한다.
 * - 프로토콜: STOMP / 순수 WebSocket. 무엇을 고르든 화면 동작은 같아야 한다.
 * - 방 배치: 분리하면 서로 안 보이고, 합치면 세 방 모두에 도착해야 한다.
 */
export function DemoApp() {
  const [protocol, setProtocol] = useState<Protocol>("stomp");
  const [rooms, setRooms] = useState<Rooms>(separated);
  const isShared = mockRooms.every((room) => rooms[room.id] === SHARED_ROOM);

  const setOne = (roomId: string, room: string) =>
    setRooms((current) => ({ ...current, [roomId]: room }));

  return (
    <main className="demo-page">
      <div className="demo-page__head">
        <h1>ws-pack 데모</h1>
        <p>
          방 3개가 각각 독립된 클라이언트 인스턴스를 쓴다. 한 방을 해제해도 나머지 방의 연결과
          구독은 유지된다.
        </p>

        <div className="topic-switch">
          {(["stomp", "window"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`topic-switch__button${protocol === value ? " topic-switch__button--active" : ""}`}
              onClick={() => setProtocol(value)}
            >
              {protocolLabel[value]}
            </button>
          ))}
          <span className="topic-switch__hint">{protocolHint[protocol]}</span>
        </div>

        <div className="topic-switch">
          <button
            type="button"
            className={`topic-switch__button${isShared ? "" : " topic-switch__button--active"}`}
            onClick={() => setRooms(separated)}
          >
            분리 방
          </button>
          <button
            type="button"
            className={`topic-switch__button${isShared ? " topic-switch__button--active" : ""}`}
            onClick={() => setRooms(shared)}
          >
            동일 방
          </button>
          <span className="topic-switch__hint">
            {isShared
              ? "세 방이 같은 이름. 한 방에서 보내면 세 방 모두에 도착해야 한다."
              : "방마다 다른 이름. 한 방의 메시지가 다른 방에 보이면 안 된다."}
          </span>
        </div>
      </div>

      <div className="room-rail">
        {mockRooms.map((chatRoom) => (
          <ChatRoom
            key={chatRoom.id}
            chatRoom={chatRoom}
            me={me}
            room={rooms[chatRoom.id]}
            protocol={protocol}
            onRoomChange={(next) => setOne(chatRoom.id, next)}
          />
        ))}
      </div>
    </main>
  );
}
