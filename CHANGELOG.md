# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- End-to-end browser tests now run on Chromium, Firefox, and WebKit, and the device-check page shows both the requested and resolved worker mode so the fallback chain is visible per engine. (#21)
- Reconnect delays now use equal jitter (`[base/2, base]`) by default. Opt out with `reconnect.jitter: false`. (#17)
- End-to-end browser tests now cover STOMP alongside plain WebSocket and MQTT, bringing the browser matrix to nine protocol/mode pairs. (#16)
- Added the documentation suite: README, `docs/architecture.md`, `docs/lifecycle.md`, and `docs/worker.md`. (#12)
- Added contract tests that exercise `revalidate()` for every protocol: a live connection passes, and a silent peer fails and recovers. (#13)
- Added unit tests for `RoomSession`, the Enter-to-send predicate, and the worker entry point. (#13, #14)
- Added `check:dist` verification that the built entry points do not pull protocol libraries the consumer did not ask for. (#13)

### Changed

- Minimum Node engine requirement raised from `>=18` to `>=22`. (#21)
- Split the package into protocol-specific entry points: `ws-pack`, `ws-pack/stomp`, `ws-pack/mqtt`, and matching `/worker/*` paths. Protocol libraries are now optional peer dependencies. (#15)
- The package is now publishable: MIT license, registry metadata, and a tarball limited to `dist`, `README.md`, and `LICENSE`. (#16)
- The release workflow repeats CI checks on every `v*` tag and refuses to publish if the tag does not match `package.json`. (#16)

### Fixed

- MQTT no longer leaves the old socket open when a dead connection is replaced, preventing duplicate subscriptions after revalidation. (#13)
- The test STOMP broker now replies with `RECEIPT` frames as the spec requires, so `revalidate()` probes report the correct liveness. (#13)
