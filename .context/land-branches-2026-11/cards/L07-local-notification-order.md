# Card L07: local notification order (#1720), one PR

Status: ready
Tier: worker
Timebox: XL, 3 days including the chunked review; escalate at 5 days or two failed approaches
Needs: xcode
Depends: L04, CP1; dispatched only when Q12's answer is "land review-only"
Branch: patch/issue-1720-local-notification-order (no PR yet; head `8225b2eb` on 2026-11-12, 42 commits, 28 behind develop)
Worktree: `/Volumes/S1/worktrees/remi/local-notification-order` (exists, clean)
Plan: plan.md sections 2 and 3.1 (chunks L07-R1 to L07-R4)

## Goal

The whole #1720 branch is one draft-then-ready PR into `develop`, merged up to date, with its duplicate #1732 test removed and every native gate passing, ready for the chunked review.

## Context

- 39 files, +5,256 lines: a local-notification ledger, lifecycle, startup, recovery, forget coordinator, inventory and owner under `RemiKit/Sources/RemiKit/Notifications/Local/`, their tests, `MachineConfigurationStore` (+122), `MachineStore` (+10), four iPhone files, and an ordering harness under `packages/native/Tests/LocalNotificationOrdering/` (XcodeGen `project.yml`, a `prepare.py`).
- By dispatch time L03 (#1728), L04 (#1732) and L05 (#1707) have merged. On 2026-11-12, merging after L04 conflicted in `Tests/RemiKitTests/SessionAddressingTests.swift`: the branch's last commit `8225b2eb` adds the same test lines as #1732's `e6cca52e` (a test-first reproduction of the #1732 defect, which L04 fixed).
- Evidence folder of the branch's work: `/Volumes/S1/yooz/remi/artifacts/local-notice-1720-core/`.
- No native CI has run on this branch (CI runs on PRs only).
- The branch's own handoff (read it first): `/Volumes/S1/yooz/remi/artifacts/notification-burst-20261030/issue-1720-current-handoff.md`. It says the branch is not ready for a release and is not connected to the iPhone app's live scheduling flow, lists the remaining work, and gates scheduler integration on #1727.

## Scope

May change: the merge commit from `origin/develop` and its resolution; removal of the duplicate test added by `8225b2eb`; the PR body.
Everything else waits for review findings.

## Decided design

Settled: one PR, never split; merge, never rebase; in `SessionAddressingTests.swift` keep develop's copy of `sameQuestionIDInDifferentSessionsDoesNotReplaceAnotherCard` and drop the branch's; any other conflict is a stop condition; the harness under `packages/native/Tests/LocalNotificationOrdering/` stays as committed (reviewers judge it).
The PR body says, in this order: exactly what a user can see or do after this PR (the review-only preferences history and anything else reachable from the app), what is not connected (live scheduling, pending #1727), the remaining-work list from the handoff, which artifacts hold evidence, that signed-device and physical iPhone behavior are unverified, and "Part of #1720".
The report lists one `gh issue create --repo yooz-labs/remi --title ... --body-file ...` command per remaining-work item, with its body file under `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L07/issues/`; the owner files them.
The implementer may choose: the body's wording.

## Acceptance

1. `git merge origin/develop` (live-facts hash) completes with only the decided resolution; save `git show --cc HEAD` to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L07/r1/merge-cc.diff`.
2. `grep -c 'func sameQuestionIDInDifferentSessionsDoesNotReplaceAnotherCard' packages/native/RemiKit/Tests/RemiKitTests/SessionAddressingTests.swift` prints 1.
3. `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter 'LocalNotice|NativeLocalNotificationOwner|SessionAddressing'` passes; log `focused.log`.
4. `gh pr create --base develop --draft` with the body above; after the gates pass, `gh pr ready`; report the PR number.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit`; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock timeout 2700 xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac -destination 'platform=macOS' -derivedDataPath /Volumes/S1/derived/remi-local-notification-order -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build test` (a stall is handled per the Q2 answer); `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone -destination 'generic/platform=iOS Simulator' -derivedDataPath /Volumes/S1/derived/remi-local-notification-order -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build`; `typos`; `git diff --check origin/develop...HEAD`.

## Stop conditions

L04 was dropped (the duplicate test would stay red); a conflict in any non-test source file; a focused test failing after the merge (report it, do not fix it in this card); a gate failure in a file this branch does not touch.

## Report

The preamble's report, plus the conflicted files, the merge-cc path, and the PR number.
Fix rounds after review use this card with the decided findings; a finding in the data-integrity or concurrency class is dispatched at worker-hard (runbook).
