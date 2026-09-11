# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Dependabot now uses the `bun` ecosystem instead of `npm`. Under `npm` it edited `package.json` without touching `bun.lock`, so every update pull request died at `bun install --frozen-lockfile`.

## [0.2.0] - 2026-09-11

### Added

- Worker handles now carry a liveness signal: pages send `ping` (`pingIntervalMs`, default 15s) and the hub reports `stale` before dropping a handle, so a page that was only frozen reopens the same handle id and restores its subscriptions and connect intent. Tune the window with `?staleAfterMs=` and `?sweepIntervalMs=` on the worker script URL. (#29)
- Added `/leak-check.html`, which exercises the sweep and the recovery against a real SharedWorker and real sockets, and a `GET /count?room=` endpoint on the demo echo server so tests count open sockets instead of inferring them. (#29)
- Dependabot now watches the package and the GitHub Actions workflows weekly, grouping development updates into one pull request. (#32)
- End-to-end browser tests now run on Chromium, Firefox, and WebKit, and the device-check page shows both the requested and resolved worker mode so the fallback chain is visible per engine. (#21)
- Reconnect delays now use equal jitter (`[base/2, base]`) by default. Opt out with `reconnect.jitter: false`. (#17)
- End-to-end browser tests now cover STOMP alongside plain WebSocket and MQTT, bringing the browser matrix to nine protocol/mode pairs. (#16)
- Added the documentation suite: README, `docs/architecture.md`, `docs/lifecycle.md`, and `docs/worker.md`. (#12)
- Added contract tests that exercise `revalidate()` for every protocol: a live connection passes, and a silent peer fails and recovers. (#13)
- Added unit tests for `RoomSession`, the Enter-to-send predicate, and the worker entry point. (#13, #14)
- Added `check:dist` verification that the built entry points do not pull protocol libraries the consumer did not ask for. (#13)

### Changed

- The package is now published as `ws-client-pack`. Import paths change accordingly: `ws-client-pack`, `ws-client-pack/stomp`, `ws-client-pack/mqtt`, `ws-client-pack/worker`. Nothing was ever published under the old name, so no consumer has to migrate. (#38)
- `react` and `react-dom` moved to `devDependencies` and `rxjs` is now declared only as a peer dependency. The published package previously listed all three as runtime dependencies, so every consumer installed React and risked a duplicate RxJS copy. (#29)
- `engines.node` is now `>=22`. Node 18 and 20 both reached end of life (April 2025 and April 2026), so the supported floor is the oldest release still receiving security fixes. (#30)
- The browser tests now retry twice on CI and never locally, and CI cancels superseded runs on a pull request branch while leaving `main` runs alone. (#31, #32)
- Documented the states in which `send()` throws and the recommended `connect$` flush pattern for app-level message queues. (#20)
- Demo now queues pending messages and flushes them on `connect$`, matching the documented pattern.
- Split the package into protocol-specific entry points: `ws-client-pack`, `ws-client-pack/stomp`, `ws-client-pack/mqtt`, and matching `/worker/*` paths. Protocol libraries are now optional peer dependencies. (#15)
- The package is now publishable: MIT license, registry metadata, and a tarball limited to `dist`, `README.md`, and `LICENSE`. (#16)
- The release workflow repeats CI checks on every `v*` tag and refuses to publish if the tag does not match `package.json`. (#16)

### Fixed

- A SharedWorker is never told that a port closed, so a tab that crashed or was reclaimed on mobile kept its handle — and its socket — open forever. The hub now sweeps handles that stopped reporting in, and pages release on `pagehide`. Verified on a real iPhone 15 Pro (iOS 26.6.1), where a backgrounded tab is discarded and reloaded rather than resumed. (#29)
- `revalidate()` now recovers from a `CLOSED` state by resetting the retry budget and starting a fresh connect, so foreground/online signals work after retries are exhausted. (#19)
- MQTT no longer leaves the old socket open when a dead connection is replaced, preventing duplicate subscriptions after revalidation. (#13)
- The test STOMP broker now replies with `RECEIPT` frames as the spec requires, so `revalidate()` probes report the correct liveness. (#13)
