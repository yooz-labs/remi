# Card L08-R1: chunk review, journal and ledger (native-images)

Status: dropped (reference only: native-images is parked, Q11 option a, owner 2026-11-12)
Tier: reviewer
Timebox: S, 1 hour per reviewer
Needs: none
Depends: L08 (its PR open and its implementer reported)
Branch: none (read-only)
Worktree: none; commits are read by hash from `/Users/yahya/Documents/git/yooz/remi`
Plan: plan.md section 3.1; send [RV-chunk-common](RV-chunk-common.md) after this card

## Goal

One lens group's findings (at most 5) for this chunk of the L08 PR, so the synthesis can merge eight chunk reports into one list.

## Context

Durable image recovery: `ImageRecoveryLedger`, `ImageRecoveryJournal`, `ImageJournalDisk` and their tests.
About 1,583 changed lines against develop on 2026-11-12, before the develop merge.
Used only under Q11 option b (dormant landing). Read first: `/Volumes/S1/yooz/remi/artifacts/native-image-1313-20261030/reviewable-slices-current-20261031.md` (its prerequisites list is the bar for "dormant and safe").
Questions to answer first, then anything else in the lens group:

1. Does every journal transition survive a crash at each write (rename, fsync, readback), and is a corrupt or orphaned journal retired, never trusted?
2. Are the ledger's bounds (capacity, retention) enforced before allocation, with no eviction of pending debt?
3. Is the journal authenticated against the installation witness (`ImageInstallationKeyStore`, chunk R2) at every read, not only at creation?

## Scope

Read these files (at `HEAD`, and their diff against `BASE`); change nothing:

- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageRecoveryLedger.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageRecoveryJournal.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageJournalDisk.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageRecoveryLedgerTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageJournalDiskTests.swift`

## Decided design

Settled: the rules of RV-chunk-common (budget, severity scale, at most 5 findings, JSON report).
The reviewer may choose: which findings to report.

## Acceptance

The JSON report with `reviewer_id` `L08-R1-contract` or `L08-R1-verification`, built from `git -C /Users/yahya/Documents/git/yooz/remi diff BASE...HEAD -- FILES` over the files above.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi diff --stat BASE...HEAD` lists every file above that the PR still changes; a listed file that is missing goes in `residual_risk`.

## Stop conditions

As in RV-chunk-common; also stop if `HEAD` is not the PR head the live facts name.

## Report

The JSON object only.
