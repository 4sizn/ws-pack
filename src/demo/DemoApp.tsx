import { useState } from "react";
import { ChatRoom } from "./components/ChatRoom";
import { mockRooms } from "./data/mockRooms";
import type { ChatUser } from "./types";
import "./styles/chat.css";

const me: ChatUser = { id: "me", name: "나", color: "#ffe066" };

/** 3개 인스턴스를 한 토픽에 모을 때 쓰는 destination. */
const SHARED_DESTINATION = "/topic/ws-pack.shared";

type Destinations = Record<string, string>;

const separated: Destinations = Object.fromEntries(
  mockRooms.map((room) => [room.id, room.destination]),
);
const shared: Destinations = Object.fromEntries(
  mockRooms.map((room) => [room.id, SHARED_DESTINATION]),
);

/**
 * 검증 시나리오 두 가지를 토글로 전환한다.
 * - 분리 토픽: 방마다 다른 destination. 한 방에 보낸 메시지가 다른 방에 안 보여야 정상.
 * - 동일 토픽: 세 방이 같은 destination. 한 방에 보내면 세 방 모두에 보여야 정상
 *   (보낸 방은 mine, 나머지 두 방은 상대 말풍선 — 인스턴스별 clientId 로 구분한다).
 */
export function DemoApp() {
  const [destinations, setDestinations] = useState<Destinations>(separated);
  const isShared = mockRooms.every((room) => destinations[room.id] === SHARED_DESTINATION);

  const setOne = (roomId: string, destination: string) =>
    setDestinations((current) => ({ ...current, [roomId]: destination }));

  return (
    <main className="demo-page">
      <div className="demo-page__head">
        <h1>ws-pack 데모</h1>
        <p>
          방 3개가 각각 독립된 StompWebSocketClient 인스턴스를 쓴다. 한 방을 해제해도 나머지 방의
          연결과 구독은 유지된다.
        </p>
        <div className="topic-switch">
          <button
            type="button"
            className={`topic-switch__button${isShared ? "" : " topic-switch__button--active"}`}
            onClick={() => setDestinations(separated)}
          >
            분리 토픽
          </button>
          <button
            type="button"
            className={`topic-switch__button${isShared ? " topic-switch__button--active" : ""}`}
            onClick={() => setDestinations(shared)}
          >
            동일 토픽
          </button>
          <span className="topic-switch__hint">
            {isShared
              ? "세 방이 같은 destination. 한 방에서 보내면 세 방 모두에 도착해야 한다."
              : "방마다 다른 destination. 한 방의 메시지가 다른 방에 보이면 안 된다."}
          </span>
        </div>
      </div>

      <div className="room-rail">
        {mockRooms.map((room) => (
          <ChatRoom
            key={room.id}
            room={room}
            me={me}
            destination={destinations[room.id]}
            onDestinationChange={(next) => setOne(room.id, next)}
          />
        ))}
      </div>
    </main>
  );
}
