import "../stomp";

/**
 * 워커 안에서 STOMP 를 쓰겠다는 선언.
 *
 * ```ts
 * // 소비자의 워커 파일
 * import "ws-pack/worker";
 * import "ws-pack/worker/stomp";
 * ```
 *
 * 진입점을 나눈 이유는 번들이다. 허브가 프로토콜을 직접 참조하면, MQTT 만 쓰는 워커도
 * stompjs 를 싣고 다닌다. 등록은 이 모듈을 import 하는 것으로 끝난다.
 */
