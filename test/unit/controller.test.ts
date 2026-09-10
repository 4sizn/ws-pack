import { describe, expect, it } from "bun:test";
import { firstValueFrom, take, toArray } from "rxjs";
import type { DisconnectInfo } from "../../src/lib";
import { ConnectionState, ReconnectTimeMode, WebSocketMonitorPlugin } from "../../src/lib";
import { delay, waitFor } from "../support/async";
import { FakeAdapter, FakeController } from "../support/fake-adapter";

/**
 * 컨트롤러 규칙만 떼어 검증한다. 어댑터는 가짜라서 네트워크도 타이밍도 개입하지 않고,
 * "연결 하나의 수명을 누가 소유하는가" 라는 규칙 자체가 시험 대상이다.
 */

/** 재시도를 짧게 — 백오프 계산은 reconnect.test.ts 가 따로 본다. */
const fastRetry = {
  maxAttempts: 2,
  delay: 5,
  timeMode: ReconnectTimeMode.INTERVAL,
  maxDelay: 5,
};

function setup(outcomes: Array<"ok" | "fail"> = []) {
  const adapter = new FakeAdapter();
  adapter.outcomes.push(...outcomes);
  const controller = new FakeController(adapter, fastRetry);
  return { adapter, controller };
}

describe("연결 수명", () => {
  it("connect() 는 OPEN 에 도달하면 resolve 하고 connect$ 를 알린다", async () => {
    const { adapter, controller } = setup();
    const opened = firstValueFrom(controller.connect$);

    await controller.connect();

    await opened;
    expect(controller.connectionState).toBe(ConnectionState.OPEN);
    expect(adapter.attempts).toBe(1);
  });

  it("이미 연결돼 있으면 connect() 는 아무 일도 하지 않는다 — 연결도 그대로 유지된다", async () => {
    const { adapter, controller } = setup();
    await controller.connect();
    await controller.connect();

    expect(adapter.attempts).toBe(1);
    expect(controller.connectionState).toBe(ConnectionState.OPEN);
    // 살아 있는 연결이 그대로여야 한다. 재진입 connect() 가 세션을 대체하면 여기서 끊긴다.
    expect(adapter.connected).toBe(true);
    expect(adapter.signals[0].aborted).toBe(false);
    controller.send("여전히 보낼 수 있다");
    expect(adapter.sent).toEqual(["여전히 보낼 수 있다"]);
  });

  it("연결된 뒤 disconnect() 를 두 번 불러도 문제가 없다", async () => {
    const { adapter, controller } = setup();
    await controller.connect();
    await controller.disconnect();
    await controller.disconnect();

    expect(controller.connectionState).toBe(ConnectionState.IDLE);
    expect(adapter.releases).toBe(1);
  });

  it("상태는 IDLE → CONNECTING → OPEN 순서로만 바뀐다", async () => {
    const { controller } = setup();
    const states = firstValueFrom(controller.connectionChanges$.pipe(take(3), toArray()));

    await controller.connect();

    expect(await states).toEqual([
      ConnectionState.IDLE,
      ConnectionState.CONNECTING,
      ConnectionState.OPEN,
    ]);
  });

  it("실패하면 정책대로 재시도하고, 소진되면 CLOSED 로 끝난다", async () => {
    const { adapter, controller } = setup(["fail", "fail", "fail"]);
    const exhausted = firstValueFrom(controller.maxReconnectReached$);
    const attempts: number[] = [];
    controller.reconnectAttempt$.subscribe((info) => attempts.push(info.attempts));

    await expect(controller.connect()).rejects.toThrow(/Maximum reconnection attempts \(2\)/);

    await exhausted;
    // 총 시도 = 첫 시도 1 + 재시도 2
    expect(adapter.attempts).toBe(3);
    expect(attempts).toEqual([1, 2]);
    expect(controller.connectionState).toBe(ConnectionState.CLOSED);
  });

  it("재시도 도중 disconnect() 가 들어오면 조용히 멈춘다", async () => {
    const { adapter, controller } = setup(["fail", "fail", "fail"]);
    const connecting = controller.connect();

    await delay(8); // 첫 실패 후 재시도 대기 중
    await controller.disconnect();
    await connecting; // 에러가 아니라 조용히 끝난다

    const attemptsAtStop = adapter.attempts;
    expect(controller.connectionState).toBe(ConnectionState.IDLE);

    await delay(30); // 멈춘 뒤에는 더 시도하지 않는다
    expect(adapter.attempts).toBe(attemptsAtStop);
  });

  it("연결 중 disconnect() 가 끼어들면 주인 없는 연결이 남지 않는다", async () => {
    const { adapter, controller } = setup();

    const connecting = controller.connect();
    await controller.disconnect();
    await connecting;

    expect(controller.connectionState).toBe(ConnectionState.IDLE);
    expect(adapter.connected).toBe(false);
    // 시도했다면 그 시도의 신호는 반드시 취소돼 있어야 한다
    expect(adapter.signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("종료하면 그 세션의 취소 신호가 내려간다 — 어댑터가 자원을 놓는 유일한 기준", async () => {
    const { adapter, controller } = setup();
    await controller.connect();
    expect(adapter.signals[0].aborted).toBe(false);

    await controller.disconnect();

    expect(adapter.signals[0].aborted).toBe(true);
    expect(adapter.connected).toBe(false);
  });

  it("소켓이 예기치 않게 닫히면 스스로 다시 연결한다", async () => {
    const { adapter, controller } = setup();
    await controller.connect();

    adapter.drop({ code: 1006 });

    await waitFor(() => controller.connectionState === ConnectionState.OPEN, "자동 재연결", 500);
    expect(adapter.attempts).toBe(2);
  });

  it("disconnect$ 는 수동 종료인지와 close 정보를 함께 준다", async () => {
    const { adapter, controller } = setup();
    await controller.connect();

    const unexpected = firstValueFrom(controller.disconnect$);
    adapter.drop({ code: 1006, reason: "gone", wasClean: false });
    expect(await unexpected).toEqual({
      manual: false,
      code: 1006,
      reason: "gone",
      wasClean: false,
    } satisfies DisconnectInfo);

    await waitFor(() => controller.connectionState === ConnectionState.OPEN, "재연결", 500);

    const manual = firstValueFrom(controller.disconnect$);
    await controller.disconnect();
    expect(await manual).toEqual({ manual: true });
  });
});

describe("송수신", () => {
  it("OPEN 이 아니면 send() 는 큐잉하지 않고 즉시 throw 한다", async () => {
    const { adapter, controller } = setup();

    expect(() => controller.send("아직 연결 전")).toThrow(/cannot send: connection is IDLE/);

    await controller.connect();
    controller.send("이제 됨");
    expect(adapter.sent).toEqual(["이제 됨"]);

    await controller.disconnect();
    expect(() => controller.send("끊긴 뒤")).toThrow(/cannot send/);
  });

  it("어댑터가 받은 메시지는 message$ 로 흘러나온다", async () => {
    const { adapter, controller } = setup();
    await controller.connect();

    const received = firstValueFrom(controller.message$);
    adapter.deliver("안녕");

    expect(await received).toBe("안녕");
  });

  it("어댑터가 보고한 런타임 에러는 error$ 로 흘러나온다", async () => {
    const { adapter, controller } = setup();
    await controller.connect();

    const failed = firstValueFrom(controller.error$);
    adapter.fail(new Error("소켓 오류"));

    expect((await failed).message).toBe("소켓 오류");
  });
});

describe("플러그인 훅", () => {
  it("onBeforeConnect 가 막으면 연결하지 않고 상태를 되돌린다", async () => {
    const { adapter, controller } = setup();
    controller.addPlugin(
      new WebSocketMonitorPlugin({
        onBeforeConnect: () => {
          throw new Error("연결 거부");
        },
      }),
    );

    await expect(controller.connect()).rejects.toThrow("연결 거부");
    expect(adapter.attempts).toBe(0);
    expect(controller.connectionState).toBe(ConnectionState.IDLE);
  });

  it("onAfterConnect 가 실패해도 연결은 성공으로 남고 에러만 흘린다", async () => {
    const { controller } = setup();
    const errors: Error[] = [];
    controller.error$.subscribe((error) => errors.push(error));
    controller.addPlugin(
      new WebSocketMonitorPlugin({
        onAfterConnect: () => {
          throw new Error("모니터링 실패");
        },
      }),
    );

    await controller.connect();

    expect(controller.connectionState).toBe(ConnectionState.OPEN);
    expect(errors.map((error) => error.message)).toEqual(["모니터링 실패"]);
  });

  it("종료 훅은 소켓이 아직 열려 있을 때 먼저 불린다", async () => {
    const { adapter, controller } = setup();
    const order: string[] = [];
    controller.addPlugin(
      new WebSocketMonitorPlugin({
        onBeforeDisconnect: () => {
          order.push(adapter.connected ? "before(연결 상태)" : "before(이미 끊김)");
        },
        onAfterDisconnect: () => {
          order.push("after");
        },
      }),
    );

    await controller.connect();
    await controller.disconnect();

    expect(order).toEqual(["before(연결 상태)", "after"]);
  });

  it("같은 이름의 플러그인은 두 번 등록되지 않는다", () => {
    const { controller } = setup();
    controller.addPlugin(new WebSocketMonitorPlugin());

    expect(() => controller.addPlugin(new WebSocketMonitorPlugin())).toThrow(/이미 등록됨/);
    expect(controller.getPluginNames()).toEqual(["WebSocketMonitorPlugin"]);

    controller.removePlugin("WebSocketMonitorPlugin");
    expect(controller.getPluginNames()).toEqual([]);
  });
});
