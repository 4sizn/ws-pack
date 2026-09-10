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
}

export type ResolvedReconnectConfig = Required<ReconnectConfig>;

export const DEFAULT_RECONNECT_CONFIG: ResolvedReconnectConfig = {
  maxAttempts: 5,
  delay: 5000,
  timeMode: ReconnectTimeMode.EXPONENTIAL,
  maxDelay: 30000,
};

export function resolveReconnectConfig(config: ReconnectConfig = {}): ResolvedReconnectConfig {
  return { ...DEFAULT_RECONNECT_CONFIG, ...config };
}

/**
 * attempt 번째(1부터) 재시도 전 대기 시간(ms).
 */
export function computeReconnectDelay(config: ResolvedReconnectConfig, attempt: number): number {
  if (config.timeMode === ReconnectTimeMode.INTERVAL) {
    return config.delay;
  }
  return Math.min(config.delay * 2 ** Math.max(attempt - 1, 0), config.maxDelay);
}

export interface ReconnectInfo {
  /** 현재까지 재시도 횟수 */
  attempts: number;
  maxAttempts: number;
  isReconnecting: boolean;
}
