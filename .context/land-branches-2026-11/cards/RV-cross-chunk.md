# Card RV-cross-chunk: composed-path contract review of a big PR (L07 or L08)

Status: ready
Tier: reviewer
Timebox: S, 90 minutes
Needs: none
Depends: the step's PR is open and its implementer reported; runs beside the chunk reviewers
Branch: none (read-only)
Worktree: none; commits are read by hash from `/Users/yahya/Documents/git/yooz/remi`
Plan: plan.md section 3.1

## Goal

Defects that only show when the chunks compose: a call path that crosses two or more chunks, where each chunk reviewer sees only its own half.

## Context

- Live facts: the step (L07 or L08), `Base`, `Head`.
- Paths to trace end to end (entry point first):
  - L08: the composer's send through `ImageUploadFlow`, `ImageTransferOwner`, `ImageSnapshotOwner` and `ImageSnapshotCopy`, into the recovery ledger and journal (`ImageRecoveryLedger`, `ImageRecoveryJournal`, `ImageJournalDisk`), the storage owners (`ImageDirectoryLease`, `ImageInstallationKeyStore`, `ImageFileProtection`), and out through `RemiConnection`'s image begin, stage and insert; also restart recovery back through the same owners.
  - L07: a question resolution arriving in the Store, through `NativeLocalNotificationOwner`, `LocalNoticeLifecycle`, `LocalNoticeLedger`, to `LocalNoticeInventory`; app startup through `LocalNoticeStartup`, `LocalNoticeBootstrap` and `LocalNoticeRecovery`; a profile forget through `LocalNoticeForgetCoordinator` and `MachineConfigurationStore`.
- Focus: ownership hand-offs, cancellation and restart ordering, error propagation across the boundary, and any state one chunk assumes another chunk guarantees.
- Rules otherwise as in [RV-chunk-common](RV-chunk-common.md).

## Scope

Read: the type and function signatures along those paths and the call sites that connect them (`grep -n`, then `sed -n` ranges), at most 1,500 lines in total.
Change: nothing.

## Decided design

Settled: lens group `contract` only; at most 5 findings, each naming the chunks it crosses; the report includes `omitted_findings` (the count of findings dropped beyond the cap).
The reviewer may choose: which paths to trace deepest.

## Acceptance

One JSON object per `review-panel-protocol.md` with `reviewer_id` `STEP-cross` (for example `L08-cross`), `omitted_findings`, and `checks` naming the paths traced.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi cat-file -t HEAD` prints `commit` for the given Head.

## Stop conditions

The 1,500-line budget runs out: report the paths covered and those not covered in `residual_risk`.

## Report

The JSON object only.
