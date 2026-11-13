# Card L08-R3: chunk review, snapshot, transfer, UI (native-images)

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

Image capture and upload: `ImageSnapshotOwner`, `ImageSnapshotReader`, `ImageSnapshotCopy`, `ImageTransferOwner`, `ImageUploadFlow`, `ImageEffectTicket`, their tests, and the composer UI (`SessionInteractionBar`, `Composer`, `BoardTile`, `ComposerSubmissionTests`).
About 1,972 changed lines against develop on 2026-11-12, before the develop merge.
Used only under Q11 option b (dormant landing). Read first: `/Volumes/S1/yooz/remi/artifacts/native-image-1313-20261030/reviewable-slices-current-20261031.md` (its prerequisites list is the bar for "dormant and safe").
Questions to answer first, then anything else in the lens group:

1. Can a selected file change, grow, be a hard link or a special file between check and copy without the copy accepting it?
2. Are reservations taken before copying and released on every failure, cancellation and restart path?
3. Does the composer show image availability truthfully while ingress ships disabled (`imageIngressQualified = false`), and can no UI path send an image frame?

## Scope

Read these files (at `HEAD`, and their diff against `BASE`); change nothing:

- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageSnapshotOwner.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageSnapshotReader.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageSnapshotCopy.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageTransferOwner.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageUploadFlow.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageEffectTicket.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageSnapshotOwnerTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageSnapshotCopyTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageTransferOwnerTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageUploadFlowTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageEffectTicketTests.swift`
- `packages/native/RemiKit/Sources/RemiUI/SessionInteractionBar.swift`
- `packages/native/RemiKit/Sources/RemiUI/Composer.swift`
- `packages/native/RemiKit/Sources/RemiUI/BoardTile.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ComposerSubmissionTests.swift`

## Decided design

Settled: the rules of RV-chunk-common (budget, severity scale, at most 5 findings, JSON report).
The reviewer may choose: which findings to report.

## Acceptance

The JSON report with `reviewer_id` `L08-R3-contract` or `L08-R3-verification`, built from `git -C /Users/yahya/Documents/git/yooz/remi diff BASE...HEAD -- FILES` over the files above.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi diff --stat BASE...HEAD` lists every file above that the PR still changes; a listed file that is missing goes in `residual_risk`.

## Stop conditions

As in RV-chunk-common; also stop if `HEAD` is not the PR head the live facts name.

## Report

The JSON object only.
