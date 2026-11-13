# Card L08: native image attachments (#1313), one PR

Status: ready
Tier: worker-hard
Timebox: XL, 3 days including the chunked review; escalate at 5 days or two failed approaches
Needs: xcode
Depends: L03, L06
Branch: feature/issue-1313-native-images (no PR yet; head `82db1172` on 2026-11-12, 154 commits, 0 behind develop at `1cbdcc6f`)
Worktree: `/Volumes/S1/worktrees/remi/native-images` (exists, clean)
Plan: plan.md sections 2 and 3.1 (chunks L08-R1 to L08-R4); risk R3

## Goal

The whole native-images branch is one draft-then-ready PR into `develop`, merged up to date with #1724's and #1731's `RemiConnection.swift` changes resolved without weakening either, and every native gate passing, ready for the chunked review.

## Context

- 39 files, +6,727 lines: image recovery journal and ledger, directory lease, installation key, file protection, snapshot and transfer owners, upload flow, composer availability notice, image-begin authority in `RemiConnection.swift`, a two-line change in `packages/daemon/src/tunnel/image-admission.ts`, tests and fixtures (two TypeScript, one Swift, one Python runner).
- Image ingress ships disabled: `RemiConnection.imageIngressQualified` is `false`, and only a DEBUG loopback-WSS fixture seam can open it. The PR body must say so.
- On 2026-11-12 `git merge-tree` showed the branch conflicting with #1728's head in `Transport/RemiConnection.swift`; #1728 (L03) and #1731 (L06) both merge before this card.
- `feature/issue-1313-image-availability` is a strict subset of this branch (Q4 folds it); do not merge it.
- Evidence folder of the branch's work: `/Volumes/S1/yooz/remi/artifacts/native-image-1313-20261030/`.

## Scope

May change: the merge commit from `origin/develop` and its resolution; the PR body.
Everything else waits for review findings.

## Decided design

Settled: one PR, never split; merge, never rebase.
In `RemiConnection.swift`, develop's (#1724) child-authority fence and (#1731) retry-budget logic are kept exactly; the branch's image-begin authority, owned-fixture seams and correlated replies are re-applied on top; `imageIngressQualified` stays `false`.
The PR body: what ships (dark infrastructure plus the composer's unavailability notice), what is gated off, which artifacts hold evidence, "Part of #1313", and that signed-device behavior is unverified.
The implementer may choose: the resolution's mechanics within those rules.

## Acceptance

1. `git merge origin/develop` (live-facts hash); save `git show --cc HEAD` to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L08/r1/merge-cc.diff`, and list every resolved hunk in the report with one line on how each side was kept.
2. `git grep -n 'imageIngressQualified = false' packages/native/RemiKit/Sources/RemiKit/Transport/RemiConnection.swift` prints one line.
3. `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter 'Image|DirectChild|ChildRoute|RelayIdleRecovery|DeliverySource|AnswerOutcomeWire|ComposerSubmission'` passes; log `focused.log`.
4. `bun test packages/daemon/tests/tunnel/image-admission-adoption.test.ts packages/daemon/tests/tunnel/image-decode-adoption.test.ts` passes (the daemon change is a two-line comment correction; this guards the merge).
5. `gh pr create --base develop --draft`, then `gh pr ready` after the gates; report the PR number.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit`; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock timeout 2700 xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac -destination 'platform=macOS' -derivedDataPath /Volumes/S1/derived/remi-native-images -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build test` (a stall is handled per the Q2 answer); `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone -destination 'generic/platform=iOS Simulator' -derivedDataPath /Volumes/S1/derived/remi-native-images -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build`; `bunx biome check .`; `bun run typecheck`; `typos`; `git diff --check origin/develop...HEAD`.

## Stop conditions

A conflict outside `RemiConnection.swift`; a resolution that cannot keep both sides' behavior as written; any test of #1724's fence or #1731's controls failing after the merge; a need to change trust, authentication or the ingress gate.

## Report

The preamble's report, plus the resolved hunks, the merge-cc path, and the PR number.
Fix rounds after review use this card with the decided findings, at worker-hard.
