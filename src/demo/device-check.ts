import { EMPTY, firstValueFrom, type Observable, timeout } from "rxjs";
import type { NetworkClient, WireMessage, WorkerClientConfig, WorkerMode } from "../lib";
import { createWorkerClient, randomId, supportedWorkerModes } from "../lib";

/**
 * 기기 점검 페이지.
 *
 * 폰에는 콘솔도 개발 도구도 없고 타이핑 자동화도 어렵다. 그래서 **열기만 하면** 프로토콜 ×
 * 연결 소유 위치의 모든 조합을 스스로 돌려 보고 결과를 화면에 적는다.
 * 확인하는 것은 하나다: 이 기기에서 라이브러리가 실제로 붙고, 주고받고, 정리되는가.
 */
const root = document.getElementById("root") as HTMLElement;
const host = location.hostname || "127.0.0.1";

const protocols = ["stomp", "window", "mqtt"] as const;
type Protocol = (typeof protocols)[number];

interface Outcome {
  protocol: Protocol;
  mode: WorkerMode;
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
          revalidateDestination: "/topic/ws-pack.revalidate",
        },
      };
    case "window":
      return {
        protocol: "window",
        options: {
          url: `ws://${host}:8010/?room=${room}`,
          reconnect,
          // 에코 서버가 받은 것을 그대로 돌려주므로 ping 이 곧 응답이다.
          heartbeat: { intervalMs: 15_000, timeoutMs: 3_000, ping: "__ws-pack-ping__" },
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
async function check(protocol: Protocol, mode: WorkerMode): Promise<Outcome> {
  const started = Date.now();
  const room = `device-${randomId().slice(0, 8)}`;
  const finish = (status: Outcome["status"], detail: string): Outcome => ({
    protocol,
    mode,
    status,
    detail,
    ms: Date.now() - started,
  });

  const chosen = createWorkerClient({
    config: configFor(protocol, room),
    prefer: [mode],
    workerUrl: new URL("../lib/worker/socket-worker.ts", import.meta.url),
    workerOptions: { type: "module", name: `check-${protocol}-${mode}` },
    key: `${protocol}:${room}`,
  });

  if (chosen.mode !== mode) {
    return finish("건너뜀", chosen.skipped.map((entry) => entry.reason).join(", "));
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
        `<tr class="${outcome.status}"><td>${outcome.protocol}</td><td>${outcome.mode}</td>` +
        `<td>${outcome.status}</td><td>${outcome.ms}ms</td><td>${outcome.detail}</td></tr>`,
    )
    .join("");

  root.innerHTML = `
    <h1>ws-pack 기기 점검</h1>
    <p>서버 호스트: <code>${host}</code></p>
    <p>이 기기가 지원하는 모드: <b>${modes.join(", ")}</b></p>
    <p>SharedWorker: <b>${typeof SharedWorker !== "undefined" ? "있음" : "없음"}</b> ·
       Worker: <b>${typeof Worker !== "undefined" ? "있음" : "없음"}</b> ·
       crypto.randomUUID: <b>${typeof crypto?.randomUUID === "function" ? "있음" : "없음"}</b> ·
       보안 컨텍스트: <b>${window.isSecureContext ? "예" : "아니오"}</b></p>
    <table>
      <thead><tr><th>프로토콜</th><th>모드</th><th>결과</th><th>시간</th><th>내용</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function run(): Promise<void> {
  render();
  for (const protocol of protocols) {
    for (const mode of ["main", "dedicated", "shared"] as const) {
      results.push(await check(protocol, mode));
      render();
    }
  }
}

void run();
