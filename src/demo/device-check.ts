import { EMPTY, firstValueFrom, type Observable, timeout } from "rxjs";
import type { NetworkClient, WireMessage, WorkerClientConfig, WorkerMode } from "../lib";
import { createWorkerClient, randomId, supportedWorkerModes } from "../lib";
// 메인 스레드 모드에서 쓸 프로토콜 구현을 등록한다. 진입점 import 가 곧 등록이다.
import "../lib/stomp";
import "../lib/mqtt";

/**
 * 기기 점검 페이지.
 *
 * 폰에는 콘솔도 개발 도구도 없고 타이핑 자동화도 어렵다. 그래서 **열기만 하면** 프로토콜 ×
 * 연결 소유 위치의 모든 조합을 스스로 돌려 보고 결과를 화면에 적는다.
 * 확인하는 것은 하나다: 이 기기에서 라이브러리가 실제로 붙고, 주고받고, 정리되는가.
 */
const root = document.getElementById("root") as HTMLElement;
const host = location.hostname || "127.0.0.1";

const allProtocols = ["stomp", "window", "mqtt"] as const;
type Protocol = (typeof allProtocols)[number];

/**
 * `?protocols=window,mqtt` 로 검사 대상을 줄일 수 있다.
 * 브로커를 띄우지 못하는 환경(예: STOMP 브로커 없는 CI)에서 나머지만 검사하기 위한 것이다.
 */
const requested = new URLSearchParams(location.search).get("protocols");
const protocols = requested
  ? allProtocols.filter((protocol) => requested.split(",").includes(protocol))
  : allProtocols;

interface Outcome {
  protocol: Protocol;
  requestedMode: WorkerMode;
  resolvedMode: WorkerMode;
  skipped: Array<{ mode: WorkerMode; reason: string }>;
  status: "통과" | "실패" | "건너뜀";
  detail: string;
  ms: number;
}

const results: Outcome[] = [];

function configFor(protocol: Protocol, room: string): WorkerClientConfig {
  const reconnect = { maxAttempts: 1, delay: 300 };
  switch (protocol) {
    case "stomp":
      return {
        protocol: "stomp",
        options: {
          brokerURL: `ws://${host}:15674/ws`,
          connectHeaders: { login: "test", passcode: "test" },
          reconnect,
          revalidateDestination: "/topic/ws-client-pack.revalidate",
        },
      };
    case "window":
      return {
        protocol: "window",
        options: {
          url: `ws://${host}:8010/?room=${room}`,
          reconnect,
          // 에코 서버가 받은 것을 그대로 돌려주므로 ping 이 곧 응답이다.
          heartbeat: { intervalMs: 15_000, timeoutMs: 3_000, ping: "__ws-client-pack-ping__" },
        },
      };
    case "mqtt":
      return { protocol: "mqtt", options: { brokerURL: `ws://${host}:8011`, reconnect } };
  }
}

function destinationFor(protocol: Protocol, room: string): string | undefined {
  if (protocol === "stomp") return `/topic/${room}`;
  if (protocol === "mqtt") return `chat/${room}`;
  return undefined;
}

/** 한 조합을 끝까지 돌린다: 연결 → 구독 → 왕복 → 재검증 → 종료 → 폐기. */
async function check(protocol: Protocol, requestedMode: WorkerMode): Promise<Outcome> {
  const started = Date.now();
  const room = `device-${randomId().slice(0, 8)}`;
  const finish = (
    status: Outcome["status"],
    detail: string,
    resolvedMode: WorkerMode = requestedMode,
    skipped: Outcome["skipped"] = [],
  ): Outcome => ({
    protocol,
    requestedMode,
    resolvedMode,
    skipped,
    status,
    detail,
    ms: Date.now() - started,
  });

  const chosen = createWorkerClient({
    config: configFor(protocol, room),
    prefer: [requestedMode],
    workerUrl: new URL("./demo-worker.ts", import.meta.url),
    workerOptions: { type: "module", name: `check-${protocol}-${requestedMode}` },
    key: `${protocol}:${room}`,
  });

  if (chosen.mode !== requestedMode) {
    return finish(
      "건너뜀",
      chosen.skipped.map((entry) => entry.reason).join(", ") || "폴백 경로가 이유 없이 변경됐다",
      chosen.mode,
      chosen.skipped,
    );
  }

  const client = chosen.client as NetworkClient<WireMessage | string, unknown> & {
    subscribe?: (destination: string) => Observable<WireMessage>;
  };

  try {
    await client.connect();

    const destination = destinationFor(protocol, room);
    const subscribed: Observable<WireMessage | string> | undefined = destination
      ? client.subscribe?.(destination)
      : client.message$;
    const incoming = firstValueFrom((subscribed ?? EMPTY).pipe(timeout(5000)));

    // 구독이 서버에 등록될 틈을 준다 — 발행이 먼저 도착하면 아무도 못 받는다.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const text = `hello-${room}`;
    await client.send(text, destination ? destinationOptions(protocol, destination) : undefined);

    const received = await incoming;
    const body = typeof received === "string" ? received : received.body;
    if (body !== text) {
      return finish("실패", `받은 값이 다르다: ${body}`);
    }

    const alive = await client.revalidate(3000);
    if (!alive) {
      return finish("실패", "revalidate 가 죽었다고 답했다");
    }

    await client.disconnect();
    client.destroy();
    return finish("통과", "연결 · 왕복 · 재검증 · 종료");
  } catch (error) {
    client.destroy();
    return finish(
      "실패",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}

function destinationOptions(protocol: Protocol, destination: string): unknown {
  return protocol === "stomp" ? { destination } : { topic: destination };
}

function render(): void {
  const modes = supportedWorkerModes();
  const rows = results
    .map(
      (outcome) =>
        `<tr class="${outcome.status}" data-protocol="${outcome.protocol}"` +
        ` data-requested-mode="${outcome.requestedMode}" data-resolved-mode="${outcome.resolvedMode}">` +
        `<td>${outcome.protocol}</td><td>${outcome.requestedMode}</td><td>${outcome.resolvedMode}</td>` +
        `<td>${outcome.status}</td><td>${outcome.ms}ms</td><td>${outcome.detail}</td></tr>`,
    )
    .join("");

  root.innerHTML = `
    <h1>ws-client-pack 기기 점검</h1>
    <p>서버 호스트: <code>${host}</code></p>
    <p>이 기기가 지원하는 모드: <b>${modes.join(", ")}</b></p>
    <p>SharedWorker: <b>${typeof SharedWorker !== "undefined" ? "있음" : "없음"}</b> ·
       Worker: <b>${typeof Worker !== "undefined" ? "있음" : "없음"}</b> ·
       crypto.randomUUID: <b>${typeof crypto?.randomUUID === "function" ? "있음" : "없음"}</b> ·
       보안 컨텍스트: <b>${window.isSecureContext ? "예" : "아니오"}</b></p>
    <table>
      <thead><tr><th>프로토콜</th><th>요청 모드</th><th>실제 모드</th><th>결과</th><th>시간</th><th>내용</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** 결과를 개발 머신으로 되보낸다. 폰 화면을 볼 수 없는 쪽에서도 확인할 수 있어야 한다. */
async function report(): Promise<void> {
  const summary = {
    userAgent: navigator.userAgent,
    host,
    secureContext: window.isSecureContext,
    sharedWorker: typeof SharedWorker !== "undefined",
    worker: typeof Worker !== "undefined",
    randomUUID: typeof crypto?.randomUUID === "function",
    passed: results.filter((outcome) => outcome.status === "통과").length,
    total: results.length,
    results,
  };
  try {
    await fetch("/device-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary, null, 2),
    });
  } catch {
    // 수집기가 없어도 화면 결과는 그대로 남는다
  }
}

async function run(): Promise<void> {
  render();
  for (const protocol of protocols) {
    for (const mode of ["main", "dedicated", "shared"] as const) {
      results.push(await check(protocol, mode));
      render();
    }
  }
  await report();
}

void run();
