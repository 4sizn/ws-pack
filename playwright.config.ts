import { defineConfig, devices } from "@playwright/test";

/**
 * 브라우저 E2E.
 *
 * 단위·계약 테스트는 소켓과 규칙을 검증하지만 브라우저에서만 성립하는 것들은 못 본다 —
 * 화면이 실제로 그려지는지, `new Worker`/`new SharedWorker` 로 띄운 워커가 도는지,
 * 입력창에 친 글자가 소켓을 왕복해 말풍선으로 돌아오는지.
 *
 * 데모 서버 세 개를 여기서 함께 띄운다. STOMP 브로커(RabbitMQ)만 도커가 필요해서
 * 기본 검사에서는 빼고, 있으면 E2E_STOMP=1 로 켠다.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  /**
   * CI 에서만 두 번 더 시도한다. 여기 검사는 진짜 브라우저와 진짜 소켓을 쓰기 때문에,
   * 러너가 느린 순간 같은 코드가 실패로 보일 수 있다 — 그걸로 릴리스가 막히면 안 된다.
   *
   * 재시도가 결함을 덮지는 않는다. 재시도로 통과한 검사는 flaky 로 보고되고, 실패한 시도의
   * 추적(trace)은 그대로 남아 올라간다. 로컬에서는 0 이다 — 고쳐야 할 실패를 숨기지 않는다.
   */
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "list" : "line",
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    // WebSocket 전용 서버라 HTTP 응답으로는 준비 여부를 못 본다(426 을 준다).
    // 포트가 열리는 것으로 판단한다.
    { command: "bun server/echo-server.ts", port: 8010, reuseExistingServer: true },
    { command: "bun server/mqtt-server.ts", port: 8011, reuseExistingServer: true },
    {
      command: "bunx vite --port 5199 --host 127.0.0.1",
      url: "http://127.0.0.1:5199",
      reuseExistingServer: true,
    },
  ],
});
