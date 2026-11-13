# Card L08-R4: chunk review, wire and authority (native-images)

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

Security path. Transport and authority: `RemiConnection.swift` (+321 before the develop merge, plus the merge's resolution against #1724's child-key fence), `ImageIngressPreflight`, `PaneTransportPolicy`, the daemon's `image-admission.ts`, the TLS, socket, preflight, wire-outcome and delivery tests and the two TypeScript fixtures.
About 1,640 changed lines against develop on 2026-11-12, before the develop merge.
Questions to answer first, then anything else in the lens group:

1. Read the develop merge first: `git -C /Users/yahya/Documents/git/yooz/remi show --cc MERGE -- packages/native/RemiKit/Sources/RemiKit/Transport/RemiConnection.swift`, where MERGE is the merge commit the live facts name. Does the resolution keep #1724's parent-socket and full-key fence intact for image traffic?
2. Can `ImageBeginAuthority` be minted for anything but the one authenticated child socket, and does a release build have any path that enables ingress (`imageIngressQualified` stays false; DEBUG-only fixture seams cannot be reached)?
3. Are begin, chunk and insert replies correlated inside the socket actor, so a stale or other-socket reply cannot complete an operation?
4. Is every generic `send` of an image frame refused while the pane policy is not qualified?

## Scope

Read these files (at `HEAD`, and their diff against `BASE`); change nothing:

- `packages/native/RemiKit/Sources/RemiKit/Transport/RemiConnection.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/ImageIngressPreflight.swift`
- `packages/native/RemiKit/Sources/RemiKit/Protocol/PaneTransportPolicy.swift`
- `packages/daemon/src/tunnel/image-admission.ts`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageBeginSourceTLSTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageIngressSocketTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/ImageIngressPreflightTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/AnswerOutcomeWireTests.swift`
- `packages/native/RemiKit/Tests/RemiKitTests/DeliverySourceTests.swift`
- `packages/native/RemiKit/Tests/Integration/image-staging-source-fixture.ts`
- `packages/native/RemiKit/Tests/Integration/delivery-source-fixture.ts`

## Decided design

Settled: the rules of RV-chunk-common (budget, severity scale, at most 5 findings, JSON report).
The reviewer may choose: which findings to report.

## Acceptance

The JSON report with `reviewer_id` `L08-R4-contract` or `L08-R4-verification`, built from `git -C /Users/yahya/Documents/git/yooz/remi diff BASE...HEAD -- FILES` over the files above.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi diff --stat BASE...HEAD` lists every file above that the PR still changes; a listed file that is missing goes in `residual_risk`.

## Stop conditions

As in RV-chunk-common; also stop if `HEAD` is not the PR head the live facts name.

## Report

The JSON object only.
