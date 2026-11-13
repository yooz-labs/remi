# Card L07-R4: chunk review, inventory, owner, app (#1720 local notification order)

Status: ready
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

Inventory, the notification owner, Store hooks, the iPhone app (`PhoneLocalNoticeReviewSheet`, `PhonePreferences`, `RemiPhoneApp`, `PhoneLiveRootView`), `SessionAddressingTests` after the develop merge, and the ordering harness under `packages/native/Tests/LocalNotificationOrdering/`.
About 1,639 changed lines against develop on 2026-11-12, before the develop merge.
Read first: the branch's own handoff `/Volumes/S1/yooz/remi/artifacts/notification-burst-20261030/issue-1720-current-handoff.md`; do not re-report its listed remaining work as findings, but report anything it misses.
Questions to answer first, then anything else in the lens group:

1. Is the inventory bounded in work and time, and does a scan timeout block nothing it should not?
2. Does the owner serialize scheduling and removal per question so the order of resolution wins?
3. Does the iPhone review sheet offer only review, with confirmation separate, and are all states reachable without relying on color?
4. The ordering harness (XcodeGen project and `prepare.py`): is it run by anything, and does it follow the repository's tooling rules?

## Scope

Read these files (at `HEAD`, and their diff against `BASE`); change nothing:

- `packages/native/RemiKit/Sources/RemiKit/Notifications/Local/LocalNoticeInventory.swift`
- `packages/native/RemiKit/Sources/RemiKit/Notifications/Local/NativeLocalNotificationOwner.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeInventoryTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/NativeLocalNotificationOwnerTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/SessionAddressingTests.swift`
- `packages/native/RemiKit/Sources/RemiKit/Store/MachineStore.swift`
- `packages/native/iPhone/PhoneLocalNoticeReviewSheet.swift`
- `packages/native/iPhone/PhonePreferences.swift`
- `packages/native/iPhone/RemiPhoneApp.swift`
- `packages/native/iPhone/PhoneLiveRootView.swift`
- `packages/native/Tests/LocalNotificationOrdering/BurstSourceTests.swift`
- `packages/native/Tests/LocalNotificationOrdering/prepare.py`
- `packages/native/Tests/LocalNotificationOrdering/BurstProbe.swift`
- `packages/native/Tests/LocalNotificationOrdering/project.yml`
- `packages/native/Tests/LocalNotificationOrdering/README.md`
- `packages/native/Tests/LocalNotificationOrdering/OwnedHost.swift`

## Decided design

Settled: the rules of RV-chunk-common (budget, severity scale, at most 5 findings, JSON report).
The reviewer may choose: which findings to report.

## Acceptance

The JSON report with `reviewer_id` `L07-R4-contract` or `L07-R4-verification`, built from `git -C /Users/yahya/Documents/git/yooz/remi diff BASE...HEAD -- FILES` over the files above.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi diff --stat BASE...HEAD` lists every file above that the PR still changes; a listed file that is missing goes in `residual_risk`.

## Stop conditions

As in RV-chunk-common; also stop if `HEAD` is not the PR head the live facts name.

## Report

The JSON object only.
