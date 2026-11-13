# Card L07-R2: chunk review, lifecycle and startup (#1720 local notification order)

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

Lifecycle and startup: `LocalNoticeLifecycle`, `LocalNoticeStartup`, `LocalNoticeBootstrap`, their tests and `LocalNoticeResetQualificationTests`.
About 1,366 changed lines against develop on 2026-11-12, before the develop merge.
Questions to answer first, then anything else in the lens group:

1. Does startup fail closed while a forget is unresolved, and can it ever schedule a stale notification?
2. Is each lifecycle transition ordered against resolution events so a resolved question cannot leave a delivered local notice?
3. Are the reset qualifications real controls (they fail when the behavior is removed)?

## Scope

Read these files (at `HEAD`, and their diff against `BASE`); change nothing:

- `packages/native/RemiKit/Sources/RemiKit/Notifications/Local/LocalNoticeLifecycle.swift`
- `packages/native/RemiKit/Sources/RemiKit/Notifications/Local/LocalNoticeStartup.swift`
- `packages/native/RemiKit/Sources/RemiKit/Notifications/Local/LocalNoticeBootstrap.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeLifecycleTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeStartupTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeBootstrapTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/LocalNoticeResetQualificationTests.swift`

## Decided design

Settled: the rules of RV-chunk-common (budget, severity scale, at most 5 findings, JSON report).
The reviewer may choose: which findings to report.

## Acceptance

The JSON report with `reviewer_id` `L07-R2-contract` or `L07-R2-verification`, built from `git -C /Users/yahya/Documents/git/yooz/remi diff BASE...HEAD -- FILES` over the files above.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi diff --stat BASE...HEAD` lists every file above that the PR still changes; a listed file that is missing goes in `residual_risk`.

## Stop conditions

As in RV-chunk-common; also stop if `HEAD` is not the PR head the live facts name.

## Report

The JSON object only.
