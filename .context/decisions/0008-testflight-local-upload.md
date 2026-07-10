# ADR 0008: TestFlight ships via local upload, not Xcode Cloud

**Status:** accepted
**Date:** 2026-06-28
**Owner:** Yahya

## Context

Making the apps official requires TestFlight. Xcode Cloud CI was the
assumed path (epic #658 originally scaffolded it), but yooz-whisper had
already proven a simpler local pipeline, and Xcode Cloud adds a hosted
dependency for something a dev machine does in minutes.

## Decision

Ship TestFlight builds locally: `bun run testflight:ios|testflight:macos
[-- --upload]` (xcodebuild archive → exportArchive → `altool` upload with
the ASC API key). Both platforms share one version/build line in
`config/app-release.json`, bumped only via `bun run app:version
--bump-build` and committed through a PR.

## Consequences

Any machine with Xcode and the ASC key can ship; no hosted CI coupling.
Fresh worktrees need two gitignored artifacts copied from the primary
checkout: `.env` (ASC key ids) and `packages/web/ios/App/CapApp-SPM/`.
Uploads are headless (`DEVELOPER_DIR=/Volumes/S1/Applications/Xcode.app/...`);
ASC rejections do not consume build numbers. #659's Xcode Cloud checklist is
a stale artifact of the abandoned path.

## Alternatives considered

- **Xcode Cloud:** hosted, slower feedback, and redundant once the local
  scripts existed; abandoned.

## Receipts

Epic #658 (closed 2026-07-10), PR #660; `docs/TESTFLIGHT.md`; shipped
builds: iOS 1 (2026-06-28), macOS 4 + iOS 5 (2026-07-09), both 6
(2026-07-10).
