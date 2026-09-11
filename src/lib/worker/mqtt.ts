import "../mqtt";

/**
 * 워커 안에서 MQTT 를 쓰겠다는 선언.
 *
 * ```ts
 * // 소비자의 워커 파일
 * import "ws-client-pack/worker";
 * import "ws-client-pack/worker/mqtt";
 * ```
 *
 * 브라우저 번들 기준 mqtt 는 360KB 가 넘는다. 쓰지 않는 워커가 그것을 싣지 않도록 분리했다.
 */
