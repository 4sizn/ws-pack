import { useEffect, useRef, useState } from "react";
import { idleSnapshot, RoomSession, type RoomSnapshot } from "../transport/RoomSession";
import type { Protocol, TransportMode } from "../transport/roomTransport";
import type { ChatRoom, ChatUser } from "../types";

/** 렌더와 무관한 명령. 스냅샷과 분리해서 넘긴다 — 참조가 안 바뀌므로 리렌더를 유발하지 않는다. */
export interface RoomControls {
  send: (text: string) => void;
  connect: () => void;
  disconnect: () => void;
  revalidate: () => void;
}

/**
 * RoomSession 하나의 수명을 컴포넌트에 묶고, 스냅샷만 렌더로 흘린다.
 * 인스턴스는 ref 안에만 있고 밖으로 나가지 않는다 — 컴포넌트는 controls 로만 명령한다.
 *
 * 방이나 프로토콜이 바뀌면 이전 세션을 폐기하고 새로 만든다. StrictMode 이중 마운트도 같은 경로다.
 */
export function useRoomSession(
  chatRoom: ChatRoom,
  me: ChatUser,
  room: string,
  protocol: Protocol,
  mode: TransportMode,
): [RoomSnapshot, RoomControls] {
  const sessionRef = useRef<RoomSession | null>(null);
  const seed = useRef(chatRoom.messages).current;
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(() => idleSnapshot(seed));

  const roomId = chatRoom.id;

  useEffect(() => {
    const session = new RoomSession({ roomId, room, protocol, mode, me, seed });
    sessionRef.current = session;

    setSnapshot(session.getSnapshot());
    const unsubscribe = session.subscribe(setSnapshot);
    session.start();

    return () => {
      unsubscribe();
      sessionRef.current = null;
      session.dispose();
    };
  }, [roomId, room, protocol, mode, me, seed]);

  const controls = useRef<RoomControls>({
    send: (text) => sessionRef.current?.send(text),
    connect: () => sessionRef.current?.connect(),
    disconnect: () => sessionRef.current?.disconnect(),
    revalidate: () => void sessionRef.current?.revalidate(),
  }).current;

  // 신호원은 앱이 정한다. 라이브러리는 revalidate() 만 제공하고 언제 부를지는 모른다.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible") controls.revalidate();
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
      window.removeEventListener("focus", check);
    };
  }, [controls]);

  return [snapshot, controls];
}
