import { describe, expect, it } from "bun:test";
import { Subject } from "rxjs";
import { RoomSession, type RoomSnapshot } from "../../src/demo/transport/RoomSession";
import { buildPayload, toChatMessage } from "../../src/demo/transport/roomMessage";
import type { RoomTransport } from "../../src/demo/transport/roomTransport";
import type { ChatMessage, ChatUser } from "../../src/demo/types";
import type { DisconnectInfo, ReconnectInfo } from "../../src/lib";
import { ConnectionState } from "../../src/lib";
import { delay } from "../support/async";

/**
 * 데모의 세션 규칙을 소켓 없이 검증한다.
 *
 * 데모는 이 라이브러리를 어떻게 쓰는지 보여주는 참조 구현이라, 여기서 깨지면 사용법이 틀린 채로
 * 남는다. 전송은 가짜를 끼우고, 세션이 스냅샷을 어떻게 갱신하는지만 본다.
 */

class FakeTransport implements RoomTransport {
  readonly sent: string[] = [];
  released = 0;
  connects = 0;
  disconnects = 0;
  alive = true;
  sendFails?: string;

  readonly incoming$ = new Subject<string>();
  readonly connectionChanges$ = new Subject<ConnectionState>();
  readonly reconnectAttempt$ = new Subject<ReconnectInfo>();
  readonly error$ = new Subject<Error>();
  readonly disconnect$ = new Subject<DisconnectInfo>();
  readonly address = "fake://room";

  async connect(): Promise<void> {
    this.connects += 1;
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
  }
  messages() {
    return this.incoming$.asObservable();
  }
  say(text: string): void {
    if (this.sendFails) throw new Error(this.sendFails);
    this.sent.push(text);
  }
  async revalidate(): Promise<boolean> {
    return this.alive;
  }
  release(): void {
    this.released += 1;
  }
}

const me: ChatUser = { id: "me", name: "나", color: "#fff" };
const seed: ChatMessage[] = [];

function setup() {
  const transport = new FakeTransport();
  const session = new RoomSession({
    roomId: "room-1",
    room: "room-1",
    protocol: "stomp",
    mode: "main",
    me,
    seed,
    createTransport: () => transport,
  });
  const snapshots: RoomSnapshot[] = [];
  session.subscribe((snapshot) => snapshots.push(snapshot));
  return { transport, session, snapshots };
}

describe("방 세션", () => {
  it("도착한 메시지를 화면 모델로 바꿔 스냅샷에 쌓는다", async () => {
    const { transport, session } = setup();
    const payload = buildPayload(
      "someone-else",
      { id: "u", name: "김지민", color: "#0f0" },
      "안녕",
    );

    transport.incoming$.next(JSON.stringify(payload));
    await delay(0);

    const [message] = session.getSnapshot().messages;
    expect(message.text).toBe("안녕");
    expect(message.sender.name).toBe("김지민");
    expect(message.mine).toBe(false);
  });

  it("내가 보낸 메시지는 에코로 돌아와도 내 것으로 표시한다", async () => {
    const { transport, session } = setup();
    session.send("내 말");

    // 브로커 에코를 흉내 낸다: 방금 보낸 payload 가 그대로 돌아온다.
    const echoed = JSON.parse(transport.sent[0]);
    transport.incoming$.next(JSON.stringify(echoed));
    await delay(0);

    expect(session.getSnapshot().messages.at(-1)?.mine).toBe(true);
  });

  it("JSON 이 아닌 메시지도 버리지 않고 그대로 보여준다", async () => {
    const { transport, session } = setup();

    transport.incoming$.next("다른 도구가 보낸 평문");
    await delay(0);

    const message = session.getSnapshot().messages.at(-1);
    expect(message?.text).toBe("다른 도구가 보낸 평문");
    expect(message?.sender.name).toBe("알 수 없음");
  });

  it("상태 변화가 스냅샷에 반영되고, 연결되면 이전 에러가 지워진다", async () => {
    const { transport, session } = setup();

    transport.error$.next(new Error("연결 실패"));
    await delay(0);
    expect(session.getSnapshot().lastError).toBe("연결 실패");

    transport.connectionChanges$.next(ConnectionState.OPEN);
    await delay(0);
    expect(session.getSnapshot().connection).toBe(ConnectionState.OPEN);
    expect(session.getSnapshot().lastError).toBeNull();
  });

  it("예기치 않게 끊기면 close code 를 화면 문구로 남긴다", async () => {
    const { transport, session } = setup();

    transport.disconnect$.next({ manual: false, code: 1006 });
    await delay(0);
    expect(session.getSnapshot().lastError).toContain("1006");

    transport.disconnect$.next({ manual: true });
    await delay(0);
    // 수동 종료는 사고가 아니므로 문구를 덮어쓰지 않는다.
    expect(session.getSnapshot().lastError).toContain("1006");
  });

  it("전송 실패는 스냅샷의 에러로 흘린다", async () => {
    const { transport, session } = setup();
    transport.sendFails = "cannot send: connection is IDLE";

    session.send("보내지지 않을 말");

    expect(session.getSnapshot().lastError).toContain("cannot send");
  });

  it("스냅샷은 매번 새 객체다 — 렌더가 변화를 알아채려면", async () => {
    const { transport, snapshots } = setup();
    transport.incoming$.next("첫 메시지");
    transport.incoming$.next("둘째 메시지");
    await delay(0);

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots.at(-1)).not.toBe(snapshots.at(-2));
  });

  it("폐기하면 연결을 놓고 이후 사건은 무시한다", async () => {
    const { transport, session } = setup();
    session.dispose();

    expect(transport.disconnects).toBe(1);
    expect(transport.released).toBe(1);

    const before = session.getSnapshot().messages.length;
    transport.incoming$.next("폐기 후 도착");
    await delay(0);
    expect(session.getSnapshot().messages.length).toBe(before);
  });

  it("재검증 결과가 거짓이면 화면에 재연결 중임을 알린다", async () => {
    const { transport, session } = setup();
    transport.alive = false;

    expect(await session.revalidate()).toBe(false);
    expect(session.getSnapshot().lastError).toContain("다시 연결");
  });
});

describe("메시지 변환", () => {
  it("보낸 사람과 시각을 담아 직렬화한다", () => {
    const payload = buildPayload("client-1", me, "안녕");

    expect(payload.clientId).toBe("client-1");
    expect(payload.text).toBe("안녕");
    expect(payload.sender).toEqual(me);
    expect(typeof payload.sentAt).toBe("number");
  });

  it("clientId 가 같으면 내 메시지로 판별한다", () => {
    const body = JSON.stringify(buildPayload("client-1", me, "안녕"));

    expect(toChatMessage(body, "room-1", "client-1").mine).toBe(true);
    expect(toChatMessage(body, "room-1", "client-2").mine).toBe(false);
  });

  it("필수 항목이 빠진 JSON 은 평문으로 취급한다", () => {
    const body = JSON.stringify({ text: 42 });

    const message = toChatMessage(body, "room-1", "client-1");
    expect(message.text).toBe(body);
    expect(message.sender.id).toBe("unknown");
  });
});
