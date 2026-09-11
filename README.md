# ws-pack

브라우저용 WebSocket 클라이언트 패키지. **STOMP · 순수 WebSocket · MQTT** 를 같은 표면으로 다루고,
연결을 페이지가 직접 들 수도 있고 **Worker · SharedWorker** 안에서 들 수도 있다.

```ts
import { StompWebSocketClient } from "ws-pack/stomp";

const client = new StompWebSocketClient({ brokerURL: "wss://broker.example/ws" });
await client.connect();

client.subscribe("/topic/room").subscribe((message) => console.log(message.body));
client.send("안녕하세요", { destination: "/topic/room" });
```

프로토콜이 달라져도 화면 동작이 달라지지 않는 것이 이 패키지의 목표다. 그 주장은 말이 아니라
[계약 테스트](#테스트)로 고정돼 있다 — 같은 채팅 시나리오 8개가 세 프로토콜에서 모두 돈다.

## 설치

```bash
bun add ws-pack     # 또는 npm / pnpm / yarn
```

프로토콜 라이브러리는 **진입점이 나뉘어 있고 선택적 peer 의존**이다. 쓰는 것만 설치하면 된다.

| import 경로 | 필요한 패키지 |
| --- | --- |
| `ws-pack` | 없음 (코어 + 순수 WebSocket) |
| `ws-pack/stomp` | `@stomp/stompjs` |
| `ws-pack/mqtt` | `mqtt` |

`rxjs` 는 공통 peer 의존이다. 소비자 쪽 rxjs 와 인스턴스가 갈리면 같은 Observable 이 서로 다른
구현으로 오간다.

나눈 이유는 크기다. 브라우저 번들 기준 `mqtt` 는 360KB 가 넘어서, 순수 WebSocket 만 쓰는
소비자가 그것을 받으면 안 된다. 코어 진입점이 프로토콜 라이브러리를 import 하지 않는다는 사실은
`bun run check:dist` 가 번들을 읽어 확인한다.

## 프로토콜 고르기

| 클래스 (import 경로) | 프로토콜 | 구독 | 보내기 |
| --- | --- | --- | --- |
| `StompWebSocketClient` (`ws-pack/stomp`) | STOMP over WebSocket | `subscribe(destination, headers?)` | `send(body, { destination })` |
| `WindowWebSocketClient` (`ws-pack`) | 브라우저 내장 WebSocket | 없음 — 연결이 곧 채널, `message$` 로 받는다 | `send(text)` |
| `MqttWebSocketClient` (`ws-pack/mqtt`) | MQTT over WebSocket | `subscribe(filter, options?)` — `+`/`#` 지원 | `send(payload, { topic })` |

`destination` 개념이 있는 프로토콜만 `subscribe` 를 가진다(`PubSubAble`). 순수 WebSocket 은
연결 하나가 채널 하나라서 구독 단계가 없다.

세 클래스 모두 [`NetworkClient`](docs/architecture.md#networkclient) 를 구현하므로,
소비자 코드는 인터페이스에 대고 쓰면 서로 갈아 끼울 수 있다.

## 스트림

모든 클라이언트가 같은 스트림을 노출한다.

```ts
client.connectionState$      // 현재 상태 (BehaviorSubject 기반, 구독 즉시 현재값)
client.connectionChanges$    // 상태가 "바뀔 때"만
client.connect$              // 연결 성립 (최초 + 재연결)
client.disconnect$           // 끊김 — manual 여부와 close code/reason 포함
client.error$                // 연결 실패, 런타임 에러
client.message$              // 수신 메시지 전부
client.reconnectAttempt$     // 재시도 1회마다 (대기 시작 시점)
client.maxReconnectReached$  // 재시도 소진
```

## 재연결

```ts
new StompWebSocketClient({
  brokerURL,
  reconnect: {
    maxAttempts: 5,                        // 첫 시도 제외한 재시도 횟수
    delay: 1000,
    timeMode: ReconnectTimeMode.EXPONENTIAL, // 또는 INTERVAL
    maxDelay: 30_000,
  },
});
```

재연결 정책은 **Controller 가 소유**한다. stompjs/mqtt.js 각자의 재연결은 꺼 둔다 — 정책이
라이브러리마다 흩어지면 프로토콜별로 동작이 갈린다. 예기치 않게 끊긴 경우에도 같은 정책으로 재시도하고,
구독은 자동으로 다시 걸린다.

## 죽은 연결 알아채기

**주기적 하트비트** 가 1차 방어선이고, 프로토콜이 가진 것을 그대로 쓴다.

| 프로토콜 | 수단 | 기본값 | 놓쳤을 때 |
| --- | --- | --- | --- |
| STOMP | `heart-beat` 협상 | 10초 양방향 | 소켓 종료 → 재연결 |
| MQTT | keepalive + PINGREQ | 60초 | 연결 종료 → 재연결 |
| 순수 WebSocket | 없음 — 아래 설정으로 직접 | 꺼져 있음 | 소켓 종료 → 재연결 |

브라우저 `WebSocket` API 로는 ping 프레임을 보낼 수 없어서, 순수 WebSocket 만 서버와 약속한
애플리케이션 메시지가 필요하다.

```ts
new WindowWebSocketClient({
  url,
  heartbeat: { intervalMs: 15_000, timeoutMs: 5_000, ping: "__ping__", pong: "__pong__" },
});
```

**즉답이 필요할 때** 는 `revalidate()`. 하트비트는 간격만큼 늦게 알아채므로, 포그라운드 복귀처럼
"지금 위험하다"를 아는 시점에 쓴다.

```ts
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void client.revalidate();
});
```

살아 있으면 `true`, 죽었으면 재연결을 시작하고 `false`. 확인 방법은
[프로토콜마다 다르다](docs/lifecycle.md#revalidate). 언제 부를지는 라이브러리가 정하지 않는다 —
신호원은 실행 환경마다 다르고(워커에는 `document` 가 없다) 정책은 앱마다 다르다.

## 워커에서 돌리기

소켓을 페이지 밖에서 소유하면 두 가지가 달라진다. 전용 Worker 는 소켓 작업을 메인 스레드에서 빼고,
SharedWorker 는 **탭이 여러 개여도 소켓 하나**를 쓴다.

```ts
// 소비자의 워커 파일 (worker.ts)
import "ws-pack/worker";        // 허브 — 순수 WebSocket 포함
import "ws-pack/worker/stomp";  // STOMP 를 쓸 때만
import "ws-pack/worker/mqtt";   // MQTT 를 쓸 때만
```

워커 진입점도 같은 이유로 나뉘어 있다. 등록하지 않은 프로토콜을 요청하면 무엇을 import 해야
하는지 알려주며 실패한다 — 조용히 다른 프로토콜로 바꾸지 않는다.

```ts
import { createWorkerClient } from "ws-pack";

const { client, mode, skipped } = createWorkerClient({
  config: { protocol: "stomp", options: { brokerURL } },
  workerUrl: new URL("./worker.ts", import.meta.url),
  workerOptions: { type: "module" },
  prefer: ["shared", "dedicated", "main"], // 기본값
});

await client.connect();
console.log(mode);    // 실제로 선택된 모드
console.log(skipped); // 앞 후보를 건넌 이유
```

워커 URL 은 소비자가 만든다. 번들러마다 워커를 다루는 방식이 달라서 라이브러리가 대신 정할 수 없다.
폴백은 자동이지만 **결과를 숨기지 않는다** — 조용히 강등되면 탭 사이 공유가 사라진 걸 모른 채 쓰게 된다.

자세한 구조는 [docs/worker.md](docs/worker.md).

## 인스턴스 폐기

```ts
client.destroy();
```

연결을 놓고, 플러그인을 떼고, 스트림을 완료한다. 컴포넌트 언마운트처럼 인스턴스를 버릴 때 부른다.
부르지 않으면 내부 구독이 남는다. 폐기 후의 `connect()` 는 조용히 무시되지 않고 거부된다.

## 플러그인

연결 수명 훅을 받는 확장점이다. 특정 클래스인지 보지 않고, **훅을 구현한 플러그인이면 호출**한다.

```ts
class Telemetry extends AbstractPlugin {
  readonly name = "Telemetry";
  protected onAttach() {}
  protected onDetach() {}
  onAfterConnect = () => track("connected");
  onError = (error: Error) => track("error", error.name);
}

new StompWebSocketClient({ brokerURL, plugins: [new Telemetry()] });
```

`onBeforeConnect` 만 throw 로 연결을 막을 수 있다. 나머지 훅의 실패는 연결을 깨지 않고 `error$` 로 나간다.

## 데모

카카오톡 형태의 채팅 데모. 프로토콜 3종 × 연결 소유 위치 3종 × 방 배치 2종을 화면에서 전환한다.

```bash
bun run stomp:up      # RabbitMQ web-stomp (STOMP 모드용)
bun run ws:server     # 에코 서버 8010 (순수 WebSocket 모드용)
bun run mqtt:server   # aedes 브로커 8011 (MQTT 모드용)
bun run dev           # http://localhost:5173
```

- `/` — 채팅 데모
- `/device-check.html` — **기기 점검**. 열기만 하면 프로토콜 × 모드 전 조합을 스스로 돌려 결과를
  화면에 적고, 개발 머신으로도 되보낸다(폰에는 콘솔이 없다)
- `/worker-check.html` — SharedWorker 연결 공유를 탭 두 개로 눈으로 확인

## 테스트

```bash
bun test
```

| 층 | 무엇을 보는가 |
| --- | --- |
| 계약 테스트 | 같은 채팅 시나리오 8개가 STOMP·WebSocket·MQTT 에서 모두 통과하는지. 브로커는 in-process 로 띄운다 |
| 단위 테스트 | 컨트롤러 규칙, 백오프 계산, 취소 신호, MQTT 와일드카드, 워커 허브/포트 왕복, 하트비트 |
| 기기 점검 | 실제 기기(브라우저·폰)에서 전 조합이 도는지 |

계약 테스트가 자체 브로커를 띄우도록 짠 덕분에 CI 에 외부 서비스나 도커가 필요 없다.

커밋 전 검사를 걸려면 클론마다 한 번:

```bash
git config core.hooksPath .githooks   # tsc + biome + bun test
```

## 문서

- [구조와 클래스 관계](docs/architecture.md) — 계층, 클래스 다이어그램, 각 계층이 무엇을 소유하는가
- [연결 수명](docs/lifecycle.md) — 상태 기계, 의도 스트림, 재연결, revalidate, 폐기
- [워커](docs/worker.md) — 페이지 ↔ 포트 ↔ 허브, 연결 공유와 참조 수명
- [릴리스](docs/releasing.md) — 버전 정책과 발행 절차

## 라이선스

MIT. 자세한 내용은 [LICENSE](LICENSE).

발행 절차와 버전 정책은 [docs/releasing.md](docs/releasing.md) 에 있다.
