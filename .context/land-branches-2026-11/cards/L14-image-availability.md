# Card L14: image availability notice and frame guard (#1313)

Status: ready
Tier: worker
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: xcode
Depends: L03 (Q11 option a, owner 2026-11-12)
Branch: feature/issue-1313-image-availability (no PR yet; head `38f5691d` on 2026-11-12, 3 commits, 0 behind develop at `1cbdcc6f`)
Worktree: `/Volumes/S1/worktrees/remi/image-availability` (exists, clean)
Plan: plan.md sections 1 and 2, L14; Q11

## Goal

The smallest caller-bearing #1313 slice lands as its own PR: the composer explains that image attachments are unavailable, generic sends of image frames are refused before the socket, and image ingress stays disabled, with every native gate passing.

## Context

- 11 files, +634: `ImageIngressPreflight.swift`, `PaneTransportPolicy.swift` (one line), `RemiConnection.swift` (+25), `SessionInteractionBar.swift`, `Composer.swift`, `BoardTile.swift`, the daemon's `image-admission.ts` (comment correction), and tests (`ImageIngressPreflightTests`, `ImageIngressSocketTests`, `AnswerOutcomeWireTests`, `ComposerSubmissionTests`).
- The #1313 artifacts name this branch as the smallest slice with a real caller: `/Volumes/S1/yooz/remi/artifacts/native-image-1313-20261030/split-and-dependency-inventory.md` and `reviewable-slices-current-20261031.md`.
- Its commits carry no issue-closing keyword (checked with the repository's own `extractClosingReferences`); native-images' commit `40fb479f` does, and is not in this branch.
- L03 (#1728) merges first; `git merge-tree` showed this branch merging cleanly after #1728 and #1731.
- `feature/issue-1313-native-images` stays parked on its branch as evidence (L08 dropped, Q11); nothing from it is merged here.

## Scope

May change: the merge commit from `origin/develop`; the PR body; fix commits from review inside the 11 files.

## Decided design

Settled: merge, never rebase; the PR says it ships the unavailability notice and the frame guard, and that image ingress itself remains disabled; "Part of #1313".
The implementer may choose: the PR body's wording.

## Acceptance

1. `git merge origin/develop` (live-facts hash) completes; any conflict is a stop condition.
2. `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter 'ImageIngress|AnswerOutcomeWire|ComposerSubmission'` passes; log to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L14/r1/focused.log`.
3. `bun test packages/daemon/tests/tunnel/image-admission-adoption.test.ts packages/daemon/tests/tunnel/image-decode-adoption.test.ts` passes.
4. `git log --format=%B origin/develop..HEAD | bun -e 'import { extractClosingReferences } from "/Users/yahya/Documents/git/yooz/remi/packages/shared/src/issue-closing.ts"; console.log(JSON.stringify(extractClosingReferences(await Bun.stdin.text())))'` prints `[]`.
5. `gh pr create --base develop --draft`, then `gh pr ready` after the gates; report the PR number.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit`; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock timeout 2700 xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac -destination 'platform=macOS' -derivedDataPath /Volumes/S1/derived/remi-image-availability -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build test` (a timeout or a stall before a test bundle loads is handled per the Q2 answer in the live facts); `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone -destination 'generic/platform=iOS Simulator' -derivedDataPath /Volumes/S1/derived/remi-image-availability -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build`; `bunx biome check .`; `typos`.

## Stop conditions

A conflict in any file; a focused test failing after the merge; any need to enable image ingress.

## Report

The preamble's report, plus the PR number.
