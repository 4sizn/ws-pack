import type { NetworkClient } from "./NetworkClient";

/**
 * 프로토콜 구현 등록소.
 *
 * 코어는 어떤 프로토콜이 있는지 모른다. `ws-pack/stomp` 처럼 프로토콜 진입점을 import 하면
 * 그 모듈이 자기 자신을 여기 등록하고, 그때부터 워커 허브와 createWorkerClient 가 쓸 수 있다.
 *
 * 이렇게 나눈 이유는 번들이다. 코어가 세 프로토콜을 직접 참조하면 순수 WebSocket 만 쓰는
 * 소비자도 stompjs 와 mqtt 를 받는다 (브라우저 번들 기준 mqtt 만 360KB 가 넘는다).
 */
export type ProtocolName = "window" | "stomp" | "mqtt";

/** 옵션을 받아 클라이언트를 만드는 함수. 프로토콜별 진입점이 제공한다. */
export type ProtocolClientFactory = (options: never) => NetworkClient<unknown, never>;

const registry = new Map<ProtocolName, ProtocolClientFactory>();

/** 프로토콜 구현을 등록한다. 진입점 모듈이 import 될 때 스스로 부른다. */
export function registerProtocolClient(name: ProtocolName, factory: ProtocolClientFactory): void {
  registry.set(name, factory);
}

/** 등록된 프로토콜 이름들. 화면에서 선택지를 그릴 때 쓸 수 있다. */
export function registeredProtocols(): ProtocolName[] {
  return [...registry.keys()];
}

/**
 * 등록된 구현으로 클라이언트를 만든다. 등록되지 않았다면 무엇을 import 해야 하는지 알려준다 —
 * 이 실패는 설정 실수라서, 조용히 다른 프로토콜로 바꾸거나 하지 않는다.
 */
export function createProtocolClient(
  name: ProtocolName,
  options: unknown,
): NetworkClient<unknown, never> {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `${name} 프로토콜이 등록되지 않았다. 진입점을 import 한다: import "ws-pack/${name}" (워커 안이라면 "ws-pack/worker/${name}")`,
    );
  }
  return factory(options as never);
}
