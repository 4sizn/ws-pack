import type { NetworkClient } from "../core/NetworkClient";
import { createProtocolClient } from "../core/protocolRegistry";
import type { WireMessage, WorkerClientConfig } from "./protocol";
import { WorkerWebSocketClient } from "./WorkerWebSocketClient";

/**
 * 연결을 어디서 소유할지.
 *
 * `shared`/`dedicated` 는 플랫폼 용어 그대로다 (SharedWorkerGlobalScope / DedicatedWorkerGlobalScope).
 * `main` 은 워커를 쓰지 않고 메인 스레드가 직접 소유하는 경우다.
 */
export type WorkerMode = "shared" | "dedicated" | "main";

export interface CreateWorkerClientOptions {
  /** 워커 안에서 만들 클라이언트 설정 */
  config: WorkerClientConfig;
  /**
   * 시도할 순서. 앞에서부터 쓸 수 있는 첫 모드를 고른다.
   * 기본값은 `["shared", "dedicated", "main"]` — 공유가 되면 공유하고, 안 되면 한 단계씩 내려간다.
   */
  prefer?: WorkerMode[];
  /**
   * 워커 스크립트 주소. 소비자가 만든다 — 번들러마다 워커 URL 을 다루는 방식이 달라서
   * 라이브러리가 대신 정하면 안 된다. 없으면 워커 모드는 건너뛴다.
   */
  workerUrl?: URL | string;
  workerOptions?: WorkerOptions;
  /** 연결 공유 키 (shared 모드에서 의미가 있다) */
  key?: string;
}

export interface WorkerClientSelection {
  client: NetworkClient<WireMessage, unknown> | NetworkClient<unknown, never>;
  /** 실제로 선택된 모드. 원했던 것과 다를 수 있다. */
  mode: WorkerMode;
  /** 앞선 후보를 건너뛴 이유. 그대로 화면에 보여줄 수 있다. */
  skipped: Array<{ mode: WorkerMode; reason: string }>;
}

/**
 * 쓸 수 있는 모드를 골라 클라이언트를 만든다.
 *
 * 자동으로 내려가되 **결과를 숨기지 않는다**: 어떤 모드가 선택됐고 앞의 후보를 왜 건넜는지
 * 반환값에 담는다. SharedWorker 가 없는 환경에서 조용히 강등되면, 소비자는 탭 사이 공유가
 * 사라진 걸 모른 채 그대로 쓰게 된다.
 */
export function createWorkerClient(options: CreateWorkerClientOptions): WorkerClientSelection {
  const prefer = options.prefer ?? ["shared", "dedicated", "main"];
  const skipped: WorkerClientSelection["skipped"] = [];

  for (const mode of prefer) {
    const reason = unavailable(mode, options);
    if (reason) {
      skipped.push({ mode, reason });
      continue;
    }
    return { client: build(mode, options), mode, skipped };
  }

  // 어느 것도 못 쓰면 메인 스레드로 간다. 소켓 자체는 어디서든 열 수 있다.
  skipped.push({ mode: "main", reason: "선호 목록에 없어 마지막 수단으로 사용" });
  return { client: build("main", options), mode: "main", skipped };
}

/** 이 환경에서 쓸 수 있는 모드들. 화면에 선택지를 그릴 때 쓴다. */
export function supportedWorkerModes(): WorkerMode[] {
  const modes: WorkerMode[] = [];
  if (typeof SharedWorker !== "undefined") modes.push("shared");
  if (typeof Worker !== "undefined") modes.push("dedicated");
  modes.push("main");
  return modes;
}

function unavailable(mode: WorkerMode, options: CreateWorkerClientOptions): string | undefined {
  if (mode === "main") return undefined;
  if (!options.workerUrl) return "워커 스크립트 주소(workerUrl)가 없다";
  if (mode === "shared" && typeof SharedWorker === "undefined") {
    // 탭 사이 공유가 불가능하다는 뜻이지 워커 자체가 없는 건 아니다.
    // (Safari 16 이전, 일부 웹뷰와 임베디드 브라우저가 여기 해당한다. iOS 26 Safari 는 지원한다 — 기기 점검으로 확인.)
    return "이 환경에 SharedWorker 가 없다";
  }
  if (mode === "dedicated" && typeof Worker === "undefined") {
    return "이 환경에 Worker 가 없다";
  }
  return undefined;
}

function build(
  mode: WorkerMode,
  options: CreateWorkerClientOptions,
): WorkerClientSelection["client"] {
  if (mode === "main") {
    return directClient(options.config);
  }

  const url = options.workerUrl as URL | string;
  const worker =
    mode === "shared"
      ? new SharedWorker(url, options.workerOptions)
      : new Worker(url, options.workerOptions);

  return new WorkerWebSocketClient(worker, options.config, { key: options.key });
}

/**
 * 워커 없이 메인 스레드가 직접 소유하는 클라이언트. 설정은 워커 경로와 같은 것을 쓴다.
 *
 * 구현은 등록소에서 가져온다 — 여기서 세 프로토콜을 직접 참조하면 워커를 안 쓰는 소비자까지
 * 모든 프로토콜 라이브러리를 받게 된다. 필요한 진입점(`ws-pack/stomp` 등)을 import 해 두면 된다.
 */
function directClient(config: WorkerClientConfig): NetworkClient<unknown, never> {
  return createProtocolClient(config.protocol, config.options);
}
