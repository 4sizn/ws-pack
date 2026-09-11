import { expect, test } from "@playwright/test";

/**
 * 공유 워커가 사라진 탭의 소켓을 실제로 놓는지 본다.
 *
 * 단위 테스트는 가짜 시계로 규칙을 검증한다. 여기서는 진짜 SharedWorker, 진짜 소켓,
 * 진짜 탭 종료로 확인하고 — 열린 소켓 수는 화면이 아니라 에코 서버에게 묻는다.
 */
const ECHO = "http://127.0.0.1:8010";

async function sockets(
  request: { get: (url: string) => Promise<{ json: () => Promise<{ count: number }> }> },
  room: string,
): Promise<number> {
  const response = await request.get(`${ECHO}/count?room=${room}`);
  return (await response.json()).count;
}

/** 서버가 센 소켓 수가 기대값이 될 때까지 기다린다. 정리는 비동기라 시각이 정확히 맞지 않는다. */
async function expectSockets(
  request: Parameters<typeof sockets>[0],
  room: string,
  expected: number,
): Promise<void> {
  await expect
    .poll(() => sockets(request, room), { timeout: 15_000, intervals: [200] })
    .toBe(expected);
}

test("소식이 끊긴 손잡이를 걷어내고 살아 있던 페이지는 스스로 복구한다", async ({
  page,
  request,
}) => {
  const room = `ghost-${Date.now()}`;
  // ping=0 → 페이지는 살아 있지만 허브 입장에서는 크래시한 탭과 구분되지 않는다.
  await page.goto(
    `/leak-check.html?room=${room}&ping=0&staleAfterMs=1500&sweepIntervalMs=300&waitMs=5000`,
  );

  await expect(page.locator("#phase")).toHaveText("끝", { timeout: 30_000 });

  // 걷어내면 소켓이 닫히고, 페이지는 stale 을 받아 다시 열고 재연결한다.
  // 걷어내기는 페이지의 스트림 구독부터 끊으므로 disconnect 는 건너오지 않는다 —
  // 복구의 증거는 "다시 연결됐다" 쪽이다.
  await expect(page.locator("#opened")).toHaveText("2");
  await expect(page.locator("#recovered")).toHaveText("예");
  // 복구를 확인한 뒤 페이지가 손잡이를 놓았다. 유령은 남지 않는다 — 서버가 센 값으로 확인한다.
  await expectSockets(request, room, 0);
});

test("탭이 닫히면 공유 소켓도 놓는다", async ({ browser, request }) => {
  const room = `tabs-${Date.now()}`;
  const url = `/leak-check.html?room=${room}&staleAfterMs=60000&waitMs=300`;
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:5199" });

  const first = await context.newPage();
  await first.goto(url);
  await expect(first.locator("#phase")).toHaveText("끝", { timeout: 30_000 });

  const second = await context.newPage();
  await second.goto(url);
  await expect(second.locator("#phase")).toHaveText("끝", { timeout: 30_000 });

  // 탭이 둘인데 소켓은 하나 — SharedWorker 공유가 실제로 되고 있다는 증거다.
  expect(await sockets(request, room)).toBe(1);

  await second.close();
  // 남은 탭이 아직 원하므로 소켓은 그대로다.
  await first.waitForTimeout(1_000);
  expect(await sockets(request, room)).toBe(1);

  await first.close();
  // 마지막 탭이 사라졌다. 걷어내기(60초)를 기다리지 않고 pagehide 로 즉시 놓는다.
  await expectSockets(request, room, 0);

  await context.close();
});
