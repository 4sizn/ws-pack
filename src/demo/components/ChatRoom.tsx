import { useRoomSession } from "../hooks/useRoomSession";
import { type Protocol, roomAddress, type TransportMode } from "../transport/roomTransport";
import type { ChatRoom as ChatRoomModel, ChatUser } from "../types";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

interface ChatRoomProps {
  chatRoom: ChatRoomModel;
  me: ChatUser;
  /** 이 방이 붙을 방 이름. 바뀌면 세션 인스턴스를 폐기하고 새로 붙는다. */
  room: string;
  protocol: Protocol;
  mode: TransportMode;
  onRoomChange: (room: string) => void;
}

/**
 * 방 하나 = 세션 인스턴스 하나. 이 컴포넌트는 스냅샷을 렌더하고 controls 로 명령만 한다 —
 * 클라이언트 인스턴스는 RoomSession 안에만 있고, 프로토콜 차이는 그 아래 RoomTransport 가 흡수한다.
 * 보낸 메시지도 서버 에코를 받아서 렌더한다 (낙관적 추가 없음).
 */
export function ChatRoom({ chatRoom, me, room, protocol, mode, onRoomChange }: ChatRoomProps) {
  const [snapshot, controls] = useRoomSession(chatRoom, me, room, protocol, mode);

  return (
    <section className="chat-room">
      <ChatHeader
        title={chatRoom.title}
        memberCount={chatRoom.memberCount}
        room={room}
        address={roomAddress(protocol, room)}
        connection={snapshot.connection}
        reconnect={snapshot.reconnect}
        onConnect={controls.connect}
        onDisconnect={controls.disconnect}
        onRoomChange={onRoomChange}
      />
      <MessageList messages={snapshot.messages} />
      {snapshot.lastError && <div className="chat-room__error">{snapshot.lastError}</div>}
      <Composer onSend={controls.send} />
    </section>
  );
}
