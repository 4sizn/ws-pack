# 워커

소켓을 페이지 밖에서 소유하는 경로. 계층은 [구조](architecture.md), 상태 규칙은
[연결 수명](lifecycle.md)에 있다.

## 무엇이 달라지는가

| 모드 | 소켓 소유자 | 탭 2개일 때 | 쓰는 이유 |
| --- | --- | --- | --- |
| `main` | 페이지(메인 스레드) | 방당 소켓 2개 | 가장 단순. 워커 번들링이 필요 없다 |
| `dedicated` | 이 탭 전용 Worker | 방당 소켓 2개 | 소켓 작업이 메인 스레드에서 빠진다 |
| `shared` | SharedWorker | **방당 소켓 1개** | 탭이 늘어도 브로커 연결과 재연결이 늘지 않는다 |

`shared`/`dedicated` 는 플랫폼 용어 그대로다(`SharedWorkerGlobalScope`,
`DedicatedWorkerGlobalScope`). `main` 은 워커를 쓰지 않는 경우다.

## 조각들

```mermaid
flowchart LR
  subgraph page["페이지"]
    App["소비자 코드"] --> WC["WorkerWebSocketClient"]
  end
  WC <-->|"WorkerCommand / WorkerEvent"| Port(("MessagePort"))
  subgraph worker["Worker · SharedWorker"]
    Port --> Entry["socket-worker.ts"] --> Hub["WorkerHub"]
    Hub --> HC["HubClient<br/>(Stomp · Window · Mqtt)"]
    HC --> Sock(("소켓"))
  end
```

| 파일 | 역할 |
| --- | --- |
| `worker/protocol.ts` | 페이지 ↔ 워커 메시지 계약 |
| `worker/socket-worker.ts` | 진입점. 전용 Worker 와 SharedWorker 를 한 파일로 다룬다 |
| `worker/hub.ts` | 워커 안에서 연결을 소유. 키로 공유하고 참조를 센다 |
| `worker/WorkerWebSocketClient.ts` | 페이지 쪽 손잡이. `NetworkClient` 구현 |
| `worker/createWorkerClient.ts` | 쓸 수 있는 모드를 골라 만든다 |

진입점 하나가 두 생성자를 다 받는다. 전용 Worker 는 전역 자신이 포트고, SharedWorker 는
`onconnect` 로 포트를 하나씩 받는다.

```ts
// 소비자의 워커 파일
import "ws-pack/worker";        // 허브 — 순수 WebSocket 포함
import "ws-pack/worker/stomp";  // 이 워커가 STOMP 를 쓸 때만
import "ws-pack/worker/mqtt";   // 이 워커가 MQTT 를 쓸 때만
```

프로토콜 등록을 나눈 이유도 번들이다. 허브가 셋을 직접 참조하면 MQTT 만 쓰는 워커가 stompjs 를
싣고 다닌다. 데모의 `src/demo/demo-worker.ts` 가 이 파일의 예시다.

## 구조화 복제라는 제약

포트를 건너는 값은 전부 복제 가능해야 한다. 그래서 프로토콜 객체를 그대로 넘기지 않는다 —
stompjs `IMessage` 에는 `ack()` 함수가, MQTT 패킷에는 `Buffer` 가 들어 있다.

```mermaid
flowchart LR
  Frame["IMessage / MQTT packet"] -->|워커가 투영| Wire["WireMessage<br/>body · destination · headers"] -->|postMessage| Page["페이지"]
```

같은 이유로 설정에서 `client`, `plugins`, `logger` 를 뺐고, 순수 WebSocket 하트비트 설정도
문자열과 숫자만 받는다(함수였다면 워커로 넘길 때 조용히 사라진다).

## 연결 공유와 수명

같은 `key` 를 요청한 손잡이들은 연결 하나를 함께 쓴다. 그래서 `connect`/`disconnect` 는
**명령이 아니라 의사 표시**로 해석된다.

```mermaid
sequenceDiagram
  participant T1 as 탭 1
  participant T2 as 탭 2
  participant Hub as WorkerHub
  participant C as 연결

  T1->>Hub: open(handle=a, key=K)
  Hub->>C: 생성
  T1->>Hub: connect(a)
  Hub->>C: connect()
  Note over Hub: wanted = {a}

  T2->>Hub: open(handle=b, key=K)
  Note over Hub: 같은 키 → 기존 연결 공유
  T2->>Hub: connect(b)
  Note over Hub: 이미 열려 있음<br/>wanted = {a, b}

  T1->>Hub: disconnect(a)
  Note over Hub: wanted = {b}<br/>소켓은 그대로 둔다
  T2->>Hub: disconnect(b)
  Note over Hub: wanted = {} → 실제로 닫는다
  Hub->>C: disconnect()
```

한 탭이 "해제"를 눌렀다고 다른 탭이 쓰는 소켓을 닫으면 안 된다. 마지막으로 원하는 손잡이가 사라질 때만
실제로 닫는다. 손잡이를 놓는 것(`destroy()`)도 마찬가지로 참조가 0이 될 때 연결을 정리한다.

## 명령과 이벤트

```mermaid
sequenceDiagram
  participant P as 페이지
  participant H as 허브

  P->>H: open { handle, key, config }
  P->>H: connect { handle, command }
  H-->>P: state / opened
  H-->>P: ack { command }
  P->>H: subscribe { handle, subscription, destination }
  H-->>P: subscription { subscription, message }
  P->>H: send { handle, command, data, options }
  H-->>P: ack { command } (실패면 error 포함)
  P->>H: revalidate { handle, command }
  H-->>P: ack { command, alive }
  P->>H: ping { handle }
  P->>H: release { handle }
```

명령마다 `command` 식별자를 달아 응답을 짝짓는다. 그래서 페이지 쪽 `send()` 는 `Promise` 다 —
같은 프로세스의 클라이언트가 즉시 throw 하는 것과 다른 유일한 지점이고,
`await` 로 쓰면 두 경로가 같은 모양이 된다.

구독은 손잡이별로 관리된다. 한 탭이 구독을 풀어도 다른 탭의 구독은 살아 있고, 포트가 닫히면 그 포트가
연 손잡이와 구독이 함께 정리된다.

## 사라진 탭 정리

SharedWorker 에는 **포트가 닫혔다는 이벤트가 없다.** 탭이 정상적으로 닫히면 페이지가 `pagehide` 에서
`release` 를 보내지만, 크래시하거나 모바일에서 회수되면 그 신호도 오지 않는다. 그대로 두면 허브는
아무도 쓰지 않는 손잡이를 계속 들고 있고, 소켓도 열린 채로 남는다.

그래서 손잡이마다 마지막 소식 시각을 들고, 소식이 끊긴 것을 걷어낸다.

| 값 | 기본 | 정하는 곳 |
| --- | --- | --- |
| 살아 있음 신호 주기 | 15초 | `new WorkerWebSocketClient(worker, config, { pingIntervalMs })` (`0` 이면 끔) |
| 걷어내기 기준 | 60초 | 워커 주소의 `?staleAfterMs=` |
| 걷어내기 주기 | 15초 | 워커 주소의 `?sweepIntervalMs=` |

```ts
const url = new URL("ws-pack/worker", import.meta.url);
url.searchParams.set("staleAfterMs", "120000"); // 더 너그럽게
new SharedWorker(url, { type: "module" });
```

명령을 하나라도 보내면 그것이 곧 살아 있다는 증거다. `ping` 은 오래 조용한 연결을 위한 것이다.

```mermaid
sequenceDiagram
  participant P as 페이지
  participant H as 허브
  participant C as 연결

  P->>H: ping { handle }
  Note over H: lastSeen 갱신
  Note over P: 탭이 얼거나 사라진다 — ping 이 끊긴다
  Note over H: staleAfterMs 경과
  H-->>P: stale { handle }
  H->>C: disconnect() (원하는 손잡이가 없으면)
  Note over P: 살아 있었다면 깨어나 읽는다
  P->>H: open { 같은 handle } + subscribe + connect
```

**걷어내도 되돌릴 수 있다.** 모바일은 백그라운드 탭의 타이머를 얼리므로, 살아 있는 탭이 잘못
걷어내질 수 있다. 그래서 허브는 걷어내기 전에 `stale` 을 보내고, 페이지는 깨어나면 그것을 읽고
같은 손잡이 아이디로 다시 연다 — 구독과 연결 의사까지 페이지가 복원하므로 소비자 코드는 손댈 게 없다.
놓친 메시지는 돌아오지 않으므로, `staleAfterMs` 는 넉넉한 쪽이 안전하다.

실기기에서 실제로 관찰된 것(iPhone 15 Pro, iOS 26.6.1, 2026-09-11): 사파리를 100초 동안
백그라운드로 보내면 탭이 멈추고 — 그동안 보고가 한 건도 오지 않는다 — 돌아왔을 때 페이지는
**이어서 도는 게 아니라 처음부터 다시 로드된다.** 즉 실기기의 흔한 경로는 `stale` 복구가 아니라
새 손잡이로의 재시작이고, 버려진 손잡이를 걷어내는 쪽이 소켓 누수를 막는다. 실측하면 그 방의
소켓은 0개로 돌아왔다. (같은 조작을 시뮬레이터에서 하면 탭이 얼지 않아 이 경로가 재현되지 않는다.)

확인하는 법은 `/leak-check.html` 이다. 실제 SharedWorker 와 실제 소켓으로 걷어내기와 복구를
돌려 보고, **열린 소켓 수는 에코 서버에게 직접 묻는다**(`GET :8010/count?room=`).

- `?ping=0&staleAfterMs=1500&sweepIntervalMs=300` — 크래시한 탭 흉내. 걷어내고 스스로 복구하는지 본다
- `?hold=1` — 왕복을 계속한다. 폰을 백그라운드로 보냈다 돌아와서 복구를 확인할 때 쓴다

## 모드 선택

```mermaid
flowchart TB
  start["createWorkerClient({ prefer })"] --> loop{"prefer 순회"}
  loop -->|"main"| main["메인 스레드 클라이언트"]
  loop -->|"shared / dedicated"| has{"workerUrl 있고<br/>생성자 존재?"}
  has -->|예| build["워커 생성 → WorkerWebSocketClient"]
  has -->|아니오| skip["skipped 에 사유 기록"] --> loop
  build --> ret["{ client, mode, skipped }"]
  main --> ret
```

폴백은 자동이되 **결과를 숨기지 않는다**. 어떤 모드가 선택됐고 앞 후보를 왜 건넜는지 반환값에 담는다 —
조용히 강등되면 소비자는 탭 사이 공유가 사라진 걸 모른 채 그대로 쓴다.

```ts
const { client, mode, skipped } = createWorkerClient({ config, workerUrl });
// mode: "dedicated"
// skipped: [{ mode: "shared", reason: "이 환경에 SharedWorker 가 없다" }]
```

`supportedWorkerModes()` 는 만들지 않고 가능 여부만 답한다. 화면에서 선택지를 그릴 때 쓴다.

> Safari 는 16 부터 SharedWorker 를 지원한다. 실기기 iOS 26 점검에서 `shared` 가 선택되는 것을
> 확인했다. 폴백은 그 이전 버전과 일부 웹뷰·임베디드 브라우저를 위한 것이다.

## 눈으로 확인하기

- `/worker-check.html` — 탭 두 개를 열고 에코 서버 로그의 연결 수를 본다. SharedWorker 라면 1개다
- `/device-check.html` — 프로토콜 × 모드 전 조합을 자동으로 돌려 표로 보여준다
- 데모 상단의 `메인 스레드 · Worker · SharedWorker` 토글 — 같은 채팅을 세 방식으로 돌려 본다
