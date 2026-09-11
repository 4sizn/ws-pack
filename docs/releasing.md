# 릴리스

발행은 **태그를 미는 사람의 결정**이다. `npm publish` 는 사실상 되돌릴 수 없다 — 72시간이 지나면
unpublish 도 막히고, 그 전에 지우더라도 같은 버전 번호는 영원히 재사용할 수 없다.

## 한 번만 하는 준비

1. npm 계정에서 자동화 토큰을 만든다 (Automation 타입 — 2FA 가 걸려 있어도 CI 에서 쓸 수 있다)
2. GitHub 저장소 Settings → Secrets → Actions 에 `NPM_TOKEN` 으로 넣는다

## 버전 정책

[semver](https://semver.org) 를 따르되, `0.x` 동안은 다음과 같이 읽는다.

| 바뀐 것 | 올릴 자리 |
| --- | --- |
| 공개 API 가 깨진다 (import 경로, 메서드 시그니처, 옵션 이름) | minor (`0.1.0` → `0.2.0`) |
| 기능 추가, 동작은 호환 | patch (`0.1.0` → `0.1.1`) |
| 결함 수정 | patch |

`1.0.0` 은 공개 API 를 깨지 않겠다고 약속할 수 있을 때 올린다. 지금 시점에 남은 미결은
[백로그](#백로그)에 있다.

프로토콜 진입점(`ws-pack/stomp` 등)이 늘거나 줄면 **그것만으로 minor** 다. 소비자의 import 가
바뀌기 때문이다.

## 발행 절차

버전 태그를 만들기 전에 CHANGELOG.md 의 Unreleased 섹션을 이번 버전 내용으로 정리한다.

```bash
# 1. main 이 초록인지 확인 (CI 의 check + e2e 두 잡)
gh run list --branch main --limit 1

# 2. 버전을 올린다 (package.json 만 바꾸고 태그는 아직 만들지 않는다)
#    CHANGELOG.md 의 Unreleased 섹션을 이번 버전으로 정리하고, 비어 있는 Unreleased 를 다시 둔다.
npm version 0.2.0 --no-git-tag-version
git commit -am "chore: 0.2.0"
git push

# 3. 태그를 민다 — 여기서부터 되돌릴 수 없다
git tag v0.2.0
git push origin v0.2.0
```

태그가 올라가면 `.github/workflows/release.yml` 이 같은 검사를 다시 돌리고(타입·린트·테스트·빌드·
산출물), **태그와 `package.json` 의 버전이 일치하는지 확인한 뒤** 발행한다. 태그가 검증을 건너뛰는
지름길이 되지 않게 하려는 것이다.

## 발행되는 것

`files` 에 적힌 것만 올라간다: `dist/lib`, `dist/types`, `README.md`, `LICENSE`.
데모·테스트·서버 스크립트는 패키지에 들어가지 않는다.

```bash
npm pack --dry-run   # 무엇이 들어가는지 미리 본다
```

## 백로그

- 전용 Worker 용 `RemoteAdapter` — [검토 결과 만들지 않기로 했다](architecture.md#networkclient)
- E2E 의 STOMP 는 CI 에서 도커 브로커를 띄워 함께 돈다
