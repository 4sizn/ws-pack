import { ConnectionState } from "../../lib";
import { useRoomSession } from "../hooks/useRoomSession";
import type { ChatRoom as ChatRoomModel, ChatUser } from "../types";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

interface ChatRoomProps {
  room: ChatRoomModel;
  me: ChatUser;
  /** 이 방이 붙을 destination. 바뀌면 세션 인스턴스를 폐기하고 새로 붙는다. */
  destination: string;
  onDestinationChange: (destination: string) => void;
}

/**
 * 방 하나 = 세션 인스턴스 하나. 이 컴포넌트는 스냅샷을 렌더하고 controls 로 명령만 한다 —
 * StompWebSocketClient 인스턴스는 RoomSession 안에만 있다.
 * 보낸 메시지도 브로커 에코를 받아서 렌더한다 (낙관적 추가 없음).
 */
export function ChatRoom({ room, me, destination, onDestinationChange }: ChatRoomProps) {
  const [snapshot, controls] = useRoomSession(room, me, destination);

  return (
    <section className="chat-room">
      <ChatHeader
        title={room.title}
        memberCount={room.memberCount}
        destination={destination}
        connection={snapshot.connection}
        reconnect={snapshot.reconnect}
        onConnect={controls.connect}
        onDisconnect={controls.disconnect}
        onDestinationChange={onDestinationChange}
      />
      <MessageList messages={snapshot.messages} />
      {snapshot.lastError && <div className="chat-room__error">{snapshot.lastError}</div>}
      <Composer disabled={snapshot.connection !== ConnectionState.OPEN} onSend={controls.send} />
    </section>
  );
}
