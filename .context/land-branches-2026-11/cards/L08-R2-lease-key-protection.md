# Card L08-R2: chunk review, lease, key, protection (native-images)

Status: ready
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

Storage ownership and protection: `ImageDirectoryLease`, `ImageInstallationKeyStore`, `ImageFileProtection`, their tests and the process-death fixture (`image-process-fixture.swift`, `run-image-process-fixture.py`).
About 1,553 changed lines against develop on 2026-11-12, before the develop merge.
Used only under Q11 option b (dormant landing). Read first: `/Volumes/S1/yooz/remi/artifacts/native-image-1313-20261030/reviewable-slices-current-20261031.md` (its prerequisites list is the bar for "dormant and safe").
Questions to answer first, then anything else in the lens group:

1. Is the directory lease exclusive across processes and within one process, and retired when the directory is replaced?
2. Does key creation stay closed on iOS where the code says so, and is a keychain false success detected?
3. Are iOS file-protection attributes set before any image byte is written and rechecked after a rename?
4. The Python fixture runner: is it invoked by a test or only by hand, and does it follow the repository's tooling rules?

## Scope

Read these files (at `HEAD`, and their diff against `BASE`); change nothing:

- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageDirectoryLease.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageInstallationKeyStore.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageFileProtection.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageDirectoryLeaseTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageInstallationKeyTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageFileProtectionTests.swift`
- `packages/native/RemiKit/Tests/Integration/image-process-fixture.swift`
- `packages/native/RemiKit/Tests/Integration/run-image-process-fixture.py`

## Decided design

Settled: the rules of RV-chunk-common (budget, severity scale, at most 5 findings, JSON report).
The reviewer may choose: which findings to report.

## Acceptance

The JSON report with `reviewer_id` `L08-R2-contract` or `L08-R2-verification`, built from `git -C /Users/yahya/Documents/git/yooz/remi diff BASE...HEAD -- FILES` over the files above.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi diff --stat BASE...HEAD` lists every file above that the PR still changes; a listed file that is missing goes in `residual_risk`.

## Stop conditions

As in RV-chunk-common; also stop if `HEAD` is not the PR head the live facts name.

## Report

The JSON object only.
