import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ConnectionState } from "../src/lib";
import { delay, inbox, waitFor, within } from "./support/async";
import { type ChatBackend, type ChatMember, drivers } from "./support/chat";

/**
 * 채팅 시나리오 = 이 라이브러리의 계약.
 *
 * 같은 시나리오를 모든 프로토콜 드라이버에 돌린다. 프로토콜이 바뀌어도 결과는 같아야 한다 —
 * 시나리오 본문에는 destination, STOMP, WebSocket 같은 단어가 나오지 않는다.
 * 드라이버가 미구현이면 그 프로토콜만 skip 되고 시나리오는 그대로 남는다.
 */
for (const driver of drivers) {
  const suite = driver.available ? describe : describe.skip;
  const title = driver.available
    ? `채팅 계약 [${driver.name}]`
    : `채팅 계약 [${driver.name}] — 보류: ${driver.pendingReason}`;

  suite(title, () => {
    let backend: ChatBackend;
    let members: ChatMember[];

    /** 방에 들어가 연결까지 마친 참가자. 정리는 afterEach 가 한다. */
    const join = async (room: string): Promise<ChatMember> => {
      const member = driver.member(backend, room);
      members.push(member);
      await member.connect();
      return member;
    };

    /**
     * 서버가 수신 대기자를 인지할 때까지 기다린다. 이걸 건너뛰면 발행이 구독보다 먼저 도착할 수 있다.
     * 최소값으로 비교하는 이유: 구독 단계가 따로 없는 프로토콜에서는 연결한 참가자가 곧 대기자라
     * 아직 듣지 않는 참가자까지 포함돼 수가 더 많을 수 있다.
     */
    const readyToReceive = (count: number) =>
      waitFor(() => backend.subscriptionCount >= count, `수신 대기자 ${count}명 이상 등록`);

    beforeEach(async () => {
      backend = await driver.start();
      members = [];
    });

    afterEach(async () => {
      for (const member of members) {
        await member.disconnect().catch(() => {});
      }
      await backend.stop();
    });

    it("보낸 메시지가 자기 방으로 돌아온다", async () => {
      const me = await join("room-a");
      const received = inbox(me.listen());
      await readyToReceive(1);

      me.say("안녕하세요");

      await waitFor(() => received.messages.length === 1, "메시지 1건 수신");
      expect(received.messages).toEqual(["안녕하세요"]);
      received.close();
    });

    it("같은 방의 다른 참가자도 같은 메시지를 받는다", async () => {
      const me = await join("room-a");
      const you = await join("room-a");
      const mine = inbox(me.listen());
      const yours = inbox(you.listen());
      await readyToReceive(2);

      me.say("점심 뭐 드세요?");

      await waitFor(
        () => mine.messages.length === 1 && yours.messages.length === 1,
        "두 참가자 모두 수신",
      );
      expect(yours.messages).toEqual(["점심 뭐 드세요?"]);
      mine.close();
      yours.close();
    });

    it("다른 방에는 새어 나가지 않는다", async () => {
      const me = await join("room-a");
      const stranger = await join("room-b");
      const mine = inbox(me.listen());
      const theirs = inbox(stranger.listen());
      await readyToReceive(2);

      me.say("우리 방 이야기");

      await waitFor(() => mine.messages.length === 1, "같은 방 수신");
      await delay(100); // 새어 나갈 시간을 준다
      expect(theirs.messages).toEqual([]);
      mine.close();
      theirs.close();
    });

    it("한 참가자가 나가도 나머지 참가자의 연결과 구독은 그대로다", async () => {
      const me = await join("room-a");
      const you = await join("room-a");
      const leaver = await join("room-a");
      const mine = inbox(me.listen());
      const yours = inbox(you.listen());
      await readyToReceive(2);

      await leaver.disconnect();

      expect(leaver.state).toBe(ConnectionState.IDLE);
      expect(me.state).toBe(ConnectionState.OPEN);
      expect(you.state).toBe(ConnectionState.OPEN);
      // 나간 참가자는 말할 수 없다 — 큐잉하지 않고 즉시 실패한다.
      expect(() => leaver.say("아직 있나요")).toThrow();

      me.say("계속 이어집니다");
      await waitFor(
        () => mine.messages.length === 1 && yours.messages.length === 1,
        "남은 참가자끼리 송수신",
      );
      mine.close();
      yours.close();
    });

    it("연결이 끊기면 자동으로 재연결하고 구독을 다시 건다", async () => {
      const me = await join("room-a");
      const received = inbox(me.listen());

      backend.killConnections();

      await waitFor(() => me.state === ConnectionState.OPEN, "재연결 완료", 3000);
      await readyToReceive(1); // 재연결 후 구독이 다시 걸렸는지가 이 시나리오의 핵심
      me.say("다시 붙었습니다");
      await waitFor(() => received.messages.length === 1, "재연결 후 수신", 3000);
      expect(received.messages).toEqual(["다시 붙었습니다"]);
      received.close();
    });

    it("연결/해제를 반복해도 서버에 남는 연결이 없다", async () => {
      const me = await join("room-a");

      for (let round = 0; round < 3; round++) {
        await me.disconnect();
        await me.connect();
      }

      await waitFor(() => backend.connectionCount === 1, "연결은 참가자 수만큼만");
      await me.disconnect();
      await waitFor(() => backend.connectionCount === 0, "모두 나가면 연결 0");
    });

    it("연결하자마자 나가면 유령 연결이 남지 않는다", async () => {
      const member = driver.member(backend, "room-a");
      members.push(member);

      // 연결 완료를 기다리지 않고 곧바로 종료 — 두 의도가 겹치는 순간이다.
      const connecting = member.connect();
      await member.disconnect();
      await connecting;

      expect(member.state).toBe(ConnectionState.IDLE);
      await waitFor(() => backend.connectionCount === 0, "주인 없는 연결 없음");
    });

    it("연결이 살아 있으면 재검증이 통과한다", async () => {
      const me = await join("room-a");

      expect(await me.revalidate(2000)).toBe(true);
      expect(me.state).toBe(ConnectionState.OPEN);
    });

    it("서버가 응답을 멈추면 재검증이 실패하고 다시 연결한다", async () => {
      const me = await join("room-a");
      const received = inbox(me.listen());
      backend.mute();

      // 소켓은 열려 있지만 상대가 답하지 않는다 — 모바일에서 흔한 죽은 연결의 모습이다.
      expect(await me.revalidate(1000)).toBe(false);

      backend.unmute();
      await waitFor(() => me.state === ConnectionState.OPEN, "재검증 실패 후 재연결", 5000);

      await readyToReceive(1);
      me.say("다시 살아났습니다");
      await waitFor(() => received.messages.length === 1, "재연결 후 수신", 3000);
      received.close();
    });

    it("서버가 응답하지 않아도 종료는 끝난다", async () => {
      const me = await join("room-a");

      backend.mute(); // 소켓은 열려 있지만 어떤 응답도 오지 않는다

      await within(me.disconnect(), 1000, "무응답 상태에서의 disconnect()");
      expect(me.state).toBe(ConnectionState.IDLE);
    });
  });
}
