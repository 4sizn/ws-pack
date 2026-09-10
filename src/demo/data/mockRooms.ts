import type { ChatMessage, ChatRoom, ChatUser } from "../types";

const me: ChatUser = { id: "me", name: "나", color: "#ffe066" };

const users: Record<string, ChatUser> = {
  jimin: { id: "jimin", name: "김지민", color: "#8ecae6" },
  sunwoo: { id: "sunwoo", name: "박선우", color: "#c8b6ff" },
  hana: { id: "hana", name: "이하나", color: "#ffb3c1" },
  taeho: { id: "taeho", name: "최태호", color: "#a8dadc" },
  bot: { id: "bot", name: "배포봇", color: "#b7e4c7" },
};

/** 데모 타임스탬프 기준 시각. 렌더 시각과 무관하게 고정한다. */
const base = new Date("2026-09-10T13:00:00+09:00").getTime();
const at = (minutes: number) => base + minutes * 60_000;

let seq = 0;
const msg = (
  roomId: string,
  sender: ChatUser,
  text: string,
  minutes: number,
  unreadCount = 0,
): ChatMessage => ({
  id: `${roomId}-${++seq}`,
  roomId,
  sender,
  mine: sender.id === me.id,
  text,
  sentAt: at(minutes),
  unreadCount,
  status: "sent",
});

export const mockRooms: ChatRoom[] = [
  {
    id: "room-team",
    title: "프론트엔드 팀",
    memberCount: 4,
    connection: "connected",
    messages: [
      msg("room-team", users.jimin, "다들 점심 뭐 드세요?", 0),
      msg("room-team", users.sunwoo, "저는 김치찌개요 🍲", 2),
      msg("room-team", me, "저도 같은 걸로 주문할게요", 3),
      msg("room-team", users.hana, "오늘 스탠드업은 2시로 미뤄졌습니다", 5),
      msg("room-team", me, "넵 캘린더 수정했어요", 6, 1),
      msg("room-team", users.jimin, "감사합니다 🙏", 8),
    ],
  },
  {
    id: "room-ws",
    title: "ws-pack 개발",
    memberCount: 3,
    connection: "connecting",
    messages: [
      msg("room-ws", users.taeho, "STOMP 재연결 백오프 얼마로 잡을까요?", 1),
      msg("room-ws", me, "기본 1초에서 최대 30초까지 지수 증가로 생각 중입니다", 2),
      msg("room-ws", users.taeho, "좋네요. jitter도 넣으면 좋겠어요", 4),
      msg("room-ws", me, "RxJS retry 오퍼레이터로 처리하면 깔끔할 듯요", 5),
      msg("room-ws", users.taeho, "그럼 구독 해제 로직만 조심하면 되겠네요", 7, 2),
    ],
  },
  {
    id: "room-deploy",
    title: "배포 알림",
    memberCount: 12,
    connection: "disconnected",
    messages: [
      msg("room-deploy", users.bot, "[staging] v0.4.2 배포가 시작되었습니다", 0),
      msg("room-deploy", users.bot, "[staging] 배포 성공 (2m 14s)", 3),
      msg("room-deploy", users.hana, "스테이징에서 채팅방 스크롤 확인 부탁드려요", 6),
      msg("room-deploy", me, "지금 볼게요", 7),
      msg("room-deploy", users.bot, "[production] 승인 대기 중입니다", 9, 5),
    ],
  },
];
