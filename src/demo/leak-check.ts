import { filter, firstValueFrom, Subject, timeout } from "rxjs";
import { randomId, WorkerWebSocketClient } from "../lib";

/**
 * 공유 워커 정리 점검.
 *
 * SharedWorker 에는 포트가 닫혔다는 이벤트가 없다. 탭이 크래시하거나 모바일에서 회수되면
 * `release` 는 오지 않고, 허브는 아무도 쓰지 않는 소켓을 계속 들고 있게 된다.
 * 이 페이지는 그 상황을 실제 SharedWorker 와 실제 소켓으로 만들어 놓고 두 가지를 본다.
 *
 * 1. 소식이 끊긴 손잡이를 허브가 걷어내는가 (소켓이 실제로 닫히는가 — 에코 서버가 센다)
 * 2. 걷어내진 뒤 살아 있던 페이지가 스스로 복구하는가 (`stale` → 다시 열기 → 재연결)
 *
 * `?ping=0` 이면 페이지가 살아 있는 신호를 보내지 않는다 — 허브 입장에서는 크래시한 탭과 같다.
 * 시간은 전부 질의 문자열로 조절한다. 자동화(E2E)와 손으로 여는 폰이 같은 페이지를 쓴다.
 */
const root = document.getElementById("root") as HTMLElement;
const params = new URLSearchParams(location.search);
const host = location.hostname || "127.0.0.1";

const room = params.get("room") ?? `leak-${randomId().slice(0, 8)}`;
const pingIntervalMs = Number(params.get("ping") ?? 15_000);
const staleAfterMs = Number(params.get("staleAfterMs") ?? 3_000);
const sweepIntervalMs = Number(params.get("sweepIntervalMs") ?? 500);
/** 걷어내기와 복구를 기다리는 시간. 기본은 stale 창의 세 배 + 여유. */
const waitMs = Number(params.get("waitMs") ?? staleAfterMs * 3 + 2_000);
/**
 * `?hold=1` 이면 끝내지 않고 계속 왕복한다. 폰을 백그라운드로 보냈다 돌아오는 시험용이다 —
 * 모바일은 백그라운드 탭의 타이머를 얼리므로 살아 있는 손잡이도 걷어내질 수 있고,
 * 돌아왔을 때 스스로 복구하는지가 실제로 중요한 부분이다.
 */
const hold = params.get("hold") === "1";

let opened = 0;
let closed = 0;
let echoed = "";
let phase = "연결 중";
let socketsAtEnd: number | null = null;
/** hold 모드용: 왕복 성공/실패 횟수와 마지막 성공 시각. */
let roundTrips = 0;
let roundTripFailures = 0;
let lastRoundTripAt = 0;

function render(): void {
  const recovered = opened > 1;
  root.innerHTML = `
    <h1>ws-client-pack 공유 워커 정리 점검</h1>
    <p>방: <code id="room">${room}</code> · 서버: <code>${host}</code></p>
    <p>살아 있음 신호(ping): <b>${pingIntervalMs === 0 ? "끔 — 크래시한 탭 흉내" : `${pingIntervalMs}ms`}</b> ·
       걷어내기: <b>${staleAfterMs}ms</b></p>
    <p>단계: <b id="phase">${phase}</b></p>
    <ul>
      <li>연결 성공 횟수: <b id="opened">${opened}</b></li>
      <li>연결 끊김 횟수: <b id="closed">${closed}</b></li>
      <li>마지막 에코: <code id="echo">${echoed}</code></li>
      <li>끝난 뒤 서버 소켓 수: <b id="sockets-at-end">${socketsAtEnd ?? "-"}</b></li>
      <li>스스로 복구: <b id="recovered">${recovered ? "예" : "아니오"}</b></li>
      ${
        hold
          ? `<li>왕복 성공: <b id="round-trips">${roundTrips}</b> · 실패: <b id="round-trip-failures">${roundTripFailures}</b></li>
             <li>마지막 왕복: <b id="since-round-trip">${
               lastRoundTripAt === 0
                 ? "-"
                 : `${Math.round((Date.now() - lastRoundTripAt) / 1000)}초 전`
}</b></li>`
          : ""
      }
    </ul>
    ${
      hold
        ? `<p>이 화면을 켠 채로 앱을 백그라운드로 보냈다가(홈으로 나갔다가) 1~3분 뒤 돌아와라.
             <b>왕복 성공</b>이 다시 오르고 <b>마지막 왕복</b>이 몇 초 전으로 돌아오면 복구된 것이다.</p>`
        : ""
    }
  `;
}

/** 에코 서버에게 이 방의 열린 소켓 수를 직접 묻는다. 화면 상태가 아니라 서버가 센 값이다. */
async function sockets(): Promise<number | null> {
  try {
    const response = await fetch(`http://${host}:8010/count?room=${encodeURIComponent(room)}`);
    const body = (await response.json()) as { count: number };
    return body.count;
  } catch {
    return null;
  }
}

/** 같은 값이 두 번 연속 나올 때까지 센다. 소켓 종료는 페이지 쪽 사건보다 늦게 반영된다. */
async function settledSockets(): Promise<number | null> {
  let previous = await sockets();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const current = await sockets();
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

/**
 * 결과를 개발 머신으로 되보낸다.
 *
 * 실기기 사파리는 스크린샷을 찍을 수단이 없다(UI 자동화에 서명된 러너가 필요하다).
 * 그래서 화면에 쓰는 것과 같은 값을 그대로 보내고, 로그로 읽는다.
 */
async function report(note = "final"): Promise<void> {
  try {
    await fetch("/device-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          check: "shared-worker-cleanup",
          note,
          userAgent: navigator.userAgent,
          room,
          pingIntervalMs,
          staleAfterMs,
          opened,
          closed,
          echoed,
          roundTrips,
          roundTripFailures,
          secondsSinceRoundTrip:
            lastRoundTripAt === 0 ? null : Math.round((Date.now() - lastRoundTripAt) / 1000),
          sockets: socketsAtEnd,
          recovered: opened > 1,
        },
        null,
        2,
      ),
    });
  } catch {
    // 수집기가 없어도 화면 결과는 그대로 남는다
  }
}

async function run(): Promise<void> {
  render();

  const workerUrl = new URL("./demo-worker.ts", import.meta.url);
  workerUrl.searchParams.set("staleAfterMs", String(staleAfterMs));
  workerUrl.searchParams.set("sweepIntervalMs", String(sweepIntervalMs));

  const worker = new SharedWorker(workerUrl, { type: "module", name: `leak-check-${room}` });
  const client = new WorkerWebSocketClient(
    worker,
    {
      protocol: "window",
      options: {
        url: `ws://${host}:8010/?room=${room}`,
        reconnect: { maxAttempts: 3, delay: 300 },
      },
    },
    { key: `leak:${room}`, pingIntervalMs },
  );

  // 두 번째 연결 성공 = 걷어내진 뒤 페이지가 스스로 다시 열었다는 뜻이다.
  const reconnected = new Subject<void>();
  client.connect$.subscribe(() => {
    opened += 1;
    render();
    if (opened > 1) reconnected.next();
  });
  client.disconnect$.subscribe(() => {
    closed += 1;
    render();
  });

  await client.connect();

  const text = `hello-${room}`;
  const incoming = firstValueFrom(client.message$.pipe(timeout(5_000)));
  await client.send(text);
  echoed = (await incoming).body;

  if (hold) {
    let reportedOpens = opened;
    phase = "왕복 유지 중 — 앱을 백그라운드로 보냈다 돌아와라";
    lastRoundTripAt = Date.now();
    roundTrips += 1;
    render();
    for (let round = 1; ; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        const beat = `hold-${round}`;
        const answer = firstValueFrom(
          client.message$.pipe(
            filter((message) => message.body === beat),
            timeout(5_000),
          ),
        );
        await client.send(beat);
        await answer;
        roundTrips += 1;
        lastRoundTripAt = Date.now();
      } catch {
        roundTripFailures += 1;
      }
      render();

      // 실기기는 화면을 볼 수 없다. 10회(약 20초)마다, 그리고 복구가 일어난 직후 보고한다.
      if (round % 10 === 0) await report(`hold-${round}`);
      if (opened > reportedOpens) {
        reportedOpens = opened;
        await report(`recovered-${opened}`);
      }
    }
  }

  if (pingIntervalMs === 0) {
    // 유령 손잡이 시나리오. 살아 있는 페이지가 신호만 끊은 것이라, 걷어내진 뒤 다시 열면
    // 또 걷어내지는 일이 반복된다 — 첫 복구를 확인한 순간 손잡이를 제대로 놓고 끝낸다.
    phase = "걷어내기를 기다리는 중";
    render();
    await firstValueFrom(reconnected.pipe(timeout(waitMs)));
    phase = "복구 확인, 정리하는 중";
    render();
    client.destroy();
  } else {
    phase = "유지되는지 보는 중";
    render();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // 소켓이 닫히는 것은 서버 쪽 사건이라 페이지보다 늦을 수 있다. 잦아들 때까지 본다.
  socketsAtEnd = await settledSockets();
  phase = "끝";
  render();

  await report();
}

void run().catch((error: unknown) => {
  phase = `실패: ${error instanceof Error ? error.message : String(error)}`;
  render();
});
