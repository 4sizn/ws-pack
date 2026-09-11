# CLAUDE.md

브라우저용 WebSocket 클라이언트 패키지(`ws-client-pack`). STOMP · 순수 WebSocket · MQTT 를 같은
표면(`NetworkClient`)으로 다루고, 연결을 페이지가 직접 들거나 Worker · SharedWorker 안에서 들 수 있다.
런타임은 Bun, 번들러는 Vite, 린터·포매터는 Biome.

## 명령

```bash
bun test                # 단위 + 계약 테스트 (bun run test 는 커버리지 게이트까지)
bun run test            # scripts/check-coverage.ts — 집계 커버리지 하한을 강제
bunx tsc -b             # 타입 검사
bunx biome check .      # 린트 + 포맷 검사 (--write 로 수정)
bun run build:lib       # 배포 산출물 (dist/lib + dist/types)
bun run check:dist      # exports 경로·공개 API·진입점 분리 검증
bun run e2e             # Playwright (chromium/firefox/webkit). E2E_STOMP=1 이면 STOMP 도 포함
bun run dev             # 데모 http://localhost:5173
```

데모·E2E 용 서버: `bun run ws:server`(에코 8010), `bun run mqtt:server`(aedes 8011),
`bun run stomp:up`/`stomp:down`(RabbitMQ web-stomp, 도커 필요).

커밋 훅은 클론마다 한 번 걸어야 한다: `git config core.hooksPath .githooks`.

## 작업 흐름

**main 에서 직접 작업하지 않는다.** main 은 GitHub ruleset 으로 잠겨 있다 — 직접 푸시, force
push, 브랜치 삭제가 모두 거부되고 squash 머지만 허용된다. 로컬 `.githooks/pre-push` 가 같은 것을
푸시 전에 먼저 막는다.

```bash
git switch -c <type>/<topic>      # 브랜치 이름은 커밋 타입을 따른다 (docs/, fix/, feat/, ci/)
git push -u origin <type>/<topic>
gh pr create
```

지금 작업을 그대로 두고 다른 일을 하려면 워크트리를 쓴다. 각 워크트리가 자기 브랜치를 체크아웃하므로
stash 없이 병행할 수 있다.

```bash
git worktree add ../ws-pack-<topic> -b <type>/<topic>
cd ../ws-pack-<topic> && bun install   # node_modules 는 워크트리마다 따로 둔다
git worktree remove ../ws-pack-<topic> # 끝나면 정리
```

머지 전에 CI 를 확인한다(`gh pr checks <번호>`). squash 머지 뒤에는 `git fetch --prune` 으로 남은
원격 ref 를 정리한다.

## 구조

`src/lib` 이 패키지 본체, `src/demo` 는 배포에 들어가지 않는 데모다.

세 계층이고, 각 계층이 **모르는 것**이 규칙이다.

| 계층 | 소유 | 모르는 것 |
| --- | --- | --- |
| Client (`core/WebSocketClient.ts`) | 공개 API 표면 | Adapter 의 존재 |
| Controller (`core/controllers/NetworkController.ts`) | 상태, 재연결 정책, 플러그인, 스트림 | 어떤 프로토콜 라이브러리를 쓰는지 |
| Adapter (`core/adapters/*`) | 소켓 하나, 프로토콜 라이브러리 | 재연결, 상태 기계 |

Adapter 는 재시도하지 않는다 — "한 번 시도해서 성공/실패"만 책임진다. 재연결 정책은 Controller 가
독점하고, stompjs/mqtt.js 각자의 재연결은 꺼 둔다.

프로토콜 하나가 Client·Controller·Adapter 세 클래스로 이어진다. 프로토콜을 추가하려면 세 클래스와
진입점(`src/lib/<name>.ts`), 워커 진입점(`src/lib/worker/<name>.ts`), 등록소 호출까지 함께 만든다.

워커 경로는 상속이 아니라 인터페이스로 묶인다. `WorkerWebSocketClient` 는 `WebSocketClient` 를
상속하지 않는다 — 상속하면 페이지에도 Controller 가 생겨 상태 소유자가 둘이 된다.

자세한 내용: [docs/architecture.md](docs/architecture.md), [docs/lifecycle.md](docs/lifecycle.md),
[docs/worker.md](docs/worker.md).

## 지켜야 하는 불변식

**의도는 스트림으로 직렬화한다.** `connect`/`disconnect` 는 명령이 아니라 의도이고,
`Subject<Intent>` 에 실려 `switchMap` 으로 처리된다. "지금 종료 중인가" 같은 임시 상태 플래그를
새로 만들지 않는다 — 새 의도가 들어오면 이전 흐름이 구독 해제되는 것으로 충분하다.

**연결의 수명은 AbortSignal 하나다.** 흐름이 구독 해제되면 `finalize` 가 abort 하고, Adapter 는 그
신호만 보고 소켓을 놓는다. 취소 경로를 따로 만들지 않는다.

**코어는 프로토콜 라이브러리를 import 하지 않는다.** 코어와 워커 허브가 stompjs·mqtt 를 끌어오면
순수 WebSocket 만 쓰는 소비자도 그것을 받는다(브라우저 번들 기준 mqtt 만 360KB 이상). 프로토콜
구현은 `core/protocolRegistry.ts` 에 자기 자신을 등록하고, 코어는 등록소만 안다. 타입 검사와 테스트는
이게 깨져도 통과하므로 `bun run check:dist` 가 번들을 읽어 확인한다.

**등록되지 않은 프로토콜 요청은 실패한다.** 무엇을 import 해야 하는지 알려주며 throw 한다 — 조용히
다른 프로토콜로 대체하지 않는다.

**`ConnectionState` 는 문자열 열거형이다.** 브라우저 `readyState`(0~3)나 stompjs `ActivationState`
와 섞이지 않게 하려는 것이다. 숫자로 바꾸지 않는다.

## 테스트

| 층 | 위치 | 무엇을 보는가 |
| --- | --- | --- |
| 계약 | `test/chat.contract.test.ts` | 같은 채팅 시나리오 8개가 STOMP·WebSocket·MQTT 에서 모두 통과 |
| 단위 | `test/unit/*` | 컨트롤러 규칙, 백오프, 취소 신호, MQTT 와일드카드, 워커 허브/포트, 하트비트 |
| E2E | `e2e/*` | 실제 브라우저 — 화면 렌더, 진짜 Worker/SharedWorker, 소켓 왕복 |

계약 테스트는 브로커를 in-process 로 띄운다(`test/support/*-broker.ts`). CI 에 외부 서비스가 필요
없게 유지한다. 시나리오는 프로토콜을 모르고 드라이버만 프로토콜을 안다 — 프로토콜별 분기를 시나리오에
넣지 않는다.

커버리지 하한은 `scripts/check-coverage.ts` 에 있다(85% lines / 62% funcs). Bun 이 파일별로만
임계값을 보기 때문에 집계값을 이 스크립트가 파싱해 강제한다.

## 스타일과 규약

- 포맷은 biome 에 맡긴다(2칸, 100열, 큰따옴표, 세미콜론). 손으로 맞추지 않는다.
- 주석은 한국어로 **왜**를 적는다. 무엇을 하는지는 코드가 말한다.
- 커밋은 Conventional Commits 영문 소문자(`feat:`, `fix:`, `refactor:`, `ci:`, `chore:`, `docs:`, `test:`).
- PR 로 들어가고 squash 머지한다. CI 는 `check` 와 `e2e`(브라우저 3종) 잡으로 갈린다.
- 문서는 한국어. 구조를 바꾸면 `docs/` 의 해당 문서와 다이어그램도 같이 고친다.
- 릴리스는 태그를 미는 사람의 결정이다. 절차와 버전 정책은 [docs/releasing.md](docs/releasing.md).
