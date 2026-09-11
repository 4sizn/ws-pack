/**
 * 재연결 정책. WebSocketController가 소유한다 — 프로토콜 무관.
 *
 * stompjs의 reconnectDelay/reconnectTimeMode는 내부 버그 때문에 쓰지 않고,
 * 어댑터는 자체 재연결을 끄고(reconnectDelay: 0) Controller가 여기 정책으로 재시도한다.
 */

export enum ReconnectTimeMode {
  /** 고정 간격 */
  INTERVAL = "INTERVAL",
  /** 지수 백오프: delay * 2^(attempt-1), maxDelay 로 상한 */
  EXPONENTIAL = "EXPONENTIAL",
}

export interface ReconnectConfig {
  /** 최대 재시도 횟수. 기본 5 */
  maxAttempts?: number;
  /** 기본 지연(ms). 기본 5000 */
  delay?: number;
  /** 지연 계산 방식. 기본 EXPONENTIAL */
  timeMode?: ReconnectTimeMode;
  /** EXPONENTIAL 모드의 지연 상한(ms). 기본 30000 */
  maxDelay?: number;
  /**
   * 계산된 지연을 흔들어 클라이언트끼리 시각을 흩는다. 기본 켜짐(true).
   *
   * 서버 하나가 죽으면 붙어 있던 클라이언트가 전부 같은 순간에 재시도한다 — 실측하면 시도마다
   * 5ms 안에 몰린다. 그 무리가 되살아나는 서버를 다시 눕히지 않게 흩어 놓는다.
   */
  jitter?: boolean;
}

export type ResolvedReconnectConfig = Required<ReconnectConfig>;

export const DEFAULT_RECONNECT_CONFIG: ResolvedReconnectConfig = {
  maxAttempts: 5,
  delay: 5000,
  timeMode: ReconnectTimeMode.EXPONENTIAL,
  maxDelay: 30000,
  jitter: true,
};

export function resolveReconnectConfig(config: ReconnectConfig = {}): ResolvedReconnectConfig {
  return { ...DEFAULT_RECONNECT_CONFIG, ...config };
}

/**
 * attempt 번째(1부터) 재시도 전 기본 대기 시간(ms). 지터를 넣지 않은 순수 계산이다.
 */
export function computeReconnectDelay(config: ResolvedReconnectConfig, attempt: number): number {
  if (config.timeMode === ReconnectTimeMode.INTERVAL) {
    return config.delay;
  }
  return Math.min(config.delay * 2 ** Math.max(attempt - 1, 0), config.maxDelay);
}

/**
 * 실제로 기다릴 시간(ms). 기본 지연에 equal jitter 를 적용한다: `[base/2, base]` 안의 값.
 *
 * full jitter(`[0, base]`)를 쓰지 않는 이유는 이 라이브러리가 `maxAttempts` 에서 포기하기
 * 때문이다 — 재시도 예산이 무한 루프가 아니라 시간 창이라서, full jitter 면 창이 평균 절반으로
 * 줄고 뽑기가 나쁘면 몇 초 만에 포기한다. equal jitter 는 창의 75% 를 지키면서도 무리를 흩는다.
 *
 * `random` 은 테스트가 끼워 넣는다. 기본값은 `Math.random`.
 */
export function nextReconnectDelay(
  config: ResolvedReconnectConfig,
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = computeReconnectDelay(config, attempt);
  if (!config.jitter) {
    return base;
  }
  return Math.round(base / 2 + random() * (base / 2));
}

export interface ReconnectInfo {
  /** 현재까지 재시도 횟수 */
  attempts: number;
  maxAttempts: number;
  isReconnecting: boolean;
}
