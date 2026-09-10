import { expect, test } from "@playwright/test";

/**
 * 브라우저에서만 성립하는 것들을 본다: 화면이 그려지는지, 진짜 Worker/SharedWorker 가 도는지,
 * 친 글자가 소켓을 왕복해 말풍선으로 돌아오는지.
 *
 * STOMP 는 도커 브로커가 필요해서 기본 검사에서 뺀다. 순수 WebSocket 과 MQTT 서버는
 * playwright.config.ts 가 함께 띄운다.
 */
const protocols = process.env.E2E_STOMP ? "stomp,window,mqtt" : "window,mqtt";

test("기기 점검 페이지가 모든 조합을 통과한다", async ({ page }) => {
  await page.goto(`/device-check.html?protocols=${protocols}`);

  const rows = page.locator("tbody tr");
  const expected = protocols.split(",").length * 3; // 프로토콜 × 모드(main·dedicated·shared)
  await expect(rows).toHaveCount(expected, { timeout: 45_000 });

  // 한 줄이라도 실패면 그 줄의 사유가 그대로 보인다.
  await expect(page.locator("tbody tr.실패")).toHaveCount(0);
  await expect(page.locator("tbody tr.통과")).toHaveCount(expected);
});

test("메인 스레드에서 친 글자가 말풍선으로 돌아온다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "WebSocket", exact: true }).click();
  await page.getByRole("button", { name: "메인 스레드" }).click();

  const room = page.locator(".chat-room").first();
  await expect(room.getByText("연결됨")).toBeVisible();

  const text = `메인 ${Date.now()}`;
  await room.locator(".composer__input").fill(text);
  await room.locator(".composer__send").click();

  // 낙관적 추가를 하지 않으므로, 보이면 서버를 왕복해 돌아온 것이다.
  await expect(room.locator(".bubble", { hasText: text })).toHaveCount(1);
});

test("전용 Worker 로도 같은 대화가 된다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "WebSocket", exact: true }).click();
  await page.getByRole("button", { name: "Worker", exact: true }).click();

  const room = page.locator(".chat-room").first();
  await expect(room.getByText("연결됨")).toBeVisible();

  const text = `전용워커 ${Date.now()}`;
  await room.locator(".composer__input").fill(text);
  await room.locator(".composer__send").click();

  await expect(room.locator(".bubble", { hasText: text })).toHaveCount(1);
});

test("SharedWorker 로 띄운 연결을 두 탭이 함께 쓴다", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();

  for (const page of [first, second]) {
    await page.goto("/");
    await page.getByRole("button", { name: "WebSocket", exact: true }).click();
    await page.getByRole("button", { name: "SharedWorker" }).click();
    await expect(page.locator(".chat-room").first().getByText("연결됨")).toBeVisible();
  }

  const text = `공유워커 ${Date.now()}`;
  const sender = first.locator(".chat-room").first();
  await sender.locator(".composer__input").fill(text);
  await sender.locator(".composer__send").click();

  // 같은 소켓을 공유하므로 다른 탭에도 도착한다 — 보낸 쪽은 내 말풍선, 받는 쪽은 상대 말풍선.
  await expect(sender.locator(".bubble", { hasText: text })).toHaveCount(1);
  await expect(
    second.locator(".chat-room").first().locator(".bubble", { hasText: text }),
  ).toHaveCount(1);

  await context.close();
});

test("한 방을 해제해도 나머지 방은 계속 쓴다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "WebSocket", exact: true }).click();
  await page.getByRole("button", { name: "메인 스레드" }).click();

  const rooms = page.locator(".chat-room");
  await expect(rooms.first().getByText("연결됨")).toBeVisible();

  await rooms.first().getByRole("button", { name: "해제" }).click();
  await expect(rooms.first().getByText("대기")).toBeVisible();

  const other = rooms.nth(1);
  await expect(other.getByText("연결됨")).toBeVisible();

  const text = `남은 방 ${Date.now()}`;
  await other.locator(".composer__input").fill(text);
  await other.locator(".composer__send").click();
  await expect(other.locator(".bubble", { hasText: text })).toHaveCount(1);
});

test("복귀 신호를 받으면 연결을 다시 확인한다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "WebSocket", exact: true }).click();
  await page.getByRole("button", { name: "메인 스레드" }).click();

  const room = page.locator(".chat-room").first();
  await expect(room.getByText("연결됨")).toBeVisible();

  // 포그라운드 복귀와 네트워크 전환을 흉내 낸다. 살아 있는 연결은 그대로 유지돼야 한다.
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
  });

  await expect(room.getByText("연결됨")).toBeVisible();

  const text = `복귀 ${Date.now()}`;
  await room.locator(".composer__input").fill(text);
  await room.locator(".composer__send").click();
  await expect(room.locator(".bubble", { hasText: text })).toHaveCount(1);
});
