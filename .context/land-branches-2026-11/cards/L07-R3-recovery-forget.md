# Card L07-R3: chunk review, recovery and forget (#1720 local notification order)

Status: parked (reference only until #1720 is unparked, Q12, owner 2026-11-12)
Tier: reviewer
Timebox: S, 1 hour per reviewer
Needs: none
Depends: L07 (its PR open and its implementer reported)
Branch: none (read-only)
Worktree: none; commits are read by hash from `/Users/yahya/Documents/git/yooz/remi`
Plan: plan.md section 3.1; send [RV-chunk-common](RV-chunk-common.md) after this card

## Goal

One lens group's findings (at most 5) for this chunk of the L07 PR, so the synthesis can merge eight chunk reports into one list.

## Context

Recovery and forget: `LocalNoticeRecovery`, `LocalNoticeReconciler`, `LocalNoticeForgetCoordinator`, `LocalNoticeQuestionAuthority`, `MachineConfigurationStore` (+122), their tests and `LocalNoticeProfilePersistenceTests`.
About 1,082 changed lines against develop on 2026-11-12, before the develop merge.
Read first: the branch's own handoff `/Volumes/S1/yooz/remi/artifacts/notification-burst-20261030/issue-1720-current-handoff.md`; do not re-report its listed remaining work as findings, but report anything it misses.
Questions to answer first, then anything else in the lens group:

1. Does a forget verify the profile write it depends on, and survive interruption with its intent retained?
2. Can recovery select a historical notice from another machine or session (the #1732 identity rule)?
3. Do the `MachineConfigurationStore` additions keep saved profiles intact when a forget is retried against changed data?

## Scope

Read these files (at `HEAD`, and their diff against `BASE`); change nothing:

- `packages/native/RemiKit/Sources/RemiKit/Notifications/Local/LocalNoticeRecovery.swift`
- `packages/native/RemiKit/Sources/RemiKit/Notifications/Local/LocalNoticeReconciler.swift`
- `packages/native/RemiKit/Sources/RemiKit/Notifications/Local/LocalNoticeForgetCoordinator.swift`
- `packages/native/RemiKit/Sources/RemiKit/Notifications/Local/LocalNoticeQuestionAuthority.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeRecoveryTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeReconcilerTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeForgetCoordinatorTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeQuestionAuthorityTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeProfilePersistenceTests.swift`
- `packages/native/RemiKit/Sources/RemiKit/Store/MachineConfigurationStore.swift`

## Decided design

Settled: the rules of RV-chunk-common (budget, severity scale, at most 5 findings, JSON report).
The reviewer may choose: which findings to report.

## Acceptance

The JSON report with `reviewer_id` `L07-R3-contract` or `L07-R3-verification`, built from `git -C /Users/yahya/Documents/git/yooz/remi diff BASE...HEAD -- FILES` over the files above.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi diff --stat BASE...HEAD` lists every file above that the PR still changes; a listed file that is missing goes in `residual_risk`.

## Stop conditions

As in RV-chunk-common; also stop if `HEAD` is not the PR head the live facts name.

## Report

The JSON object only.
