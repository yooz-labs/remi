# Card L05: native notification preferences (#1681, PR #1707)

Status: ready
Tier: worker
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: xcode
Depends: L03
Branch: feature/issue-1681-notification-preferences (PR #1707, draft, head `860a03b8` on 2026-11-12, DIRTY)
Worktree: `/Volumes/S1/worktrees/remi/notification-preferences` (exists, clean)
Plan: plan.md section 2, L05

## Goal

PR #1707 merges `origin/develop` without changing its reviewed behavior, its gates pass on the merged head, and its body says what the merge resolved, so the manager can verify the resolution and merge.

## Context

- Two review rounds are on record on the PR (round 1: one Important finding about the direct-host refresh path; round 2 at `860a03b8`: no further findings); there is no third round.
- On 2026-11-12 the branch was 79 commits behind `develop`; `git merge-tree` showed one conflict, `packages/native/Mac/MacLiveRootView.swift`; `Store/MachineStore.swift` auto-merged.
- L03 (#1728, also in `MachineStore.swift`) merges before this card runs; L04 (#1732) may have changed `Mac/MacLiveRootView.swift` and `iPhone/PhoneLiveRootView.swift` call sites by then.
- The body already lists what is unverified (signed phone and Mac delivery, iPhone Settings rendering); keep it.

## Scope

May change: the merge commit from `origin/develop` and its conflict resolution; the PR body (extend it).
No other commits.

## Decided design

Settled: resolve each conflict hunk by keeping both sides' behavior; where both sides changed the same lines, keep develop's structure and re-apply the PR's change on top; no new behavior, no refactor.
The implementer may choose: nothing else.

## Acceptance

1. `git merge origin/develop` (the live-facts hash) completes; `git show --cc HEAD > /Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L05/r1/merge-cc.diff` is saved for the advisor.
2. `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter 'NativePushActionTests|NativePushCoreTests|NativeNotificationPreferencesTests|PairedNotificationTests|PairedNotificationSourceTests'` passes (the PR's own focused suite).
3. The full gates below pass.
4. The PR body gains a paragraph: develop hash merged, files with manual resolution, and the gate results.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit`; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock timeout 2700 xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac -destination 'platform=macOS' -derivedDataPath /Volumes/S1/derived/remi-notification-preferences -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build test` (a stall is handled per the Q2 answer in the live facts); `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone -destination 'generic/platform=iOS Simulator' -derivedDataPath /Volumes/S1/derived/remi-notification-preferences -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build`; `typos`.

## Stop conditions

A conflict in a file other than `Mac/MacLiveRootView.swift`, `Store/MachineStore.swift` or the iPhone views; a resolution that would change behavior on either side; a focused test failing after the merge.

## Report

The preamble's report, plus the conflicted files, the `merge-cc.diff` path, and whether any hunk needed more than taking both sides.
