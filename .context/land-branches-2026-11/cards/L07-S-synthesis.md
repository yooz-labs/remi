# Card L07-S: synthesis of the chunked review (#1720 local notification order)

Status: parked (reference only until #1720 is unparked, Q12, owner 2026-11-12)
Tier: reviewer
Timebox: S, 1 hour
Needs: none
Depends: L07, with all eight chunk reports in (or accounted for as unavailable)
Branch: none (read-only)
Worktree: none; commits are read by hash from `/Users/yahya/Documents/git/yooz/remi`
Plan: plan.md section 3.1

## Goal

One deduplicated, severity-ordered finding list for the L07 PR's round 1, built only from the eight chunk reports, so the implementer and the manager can give every finding an outcome.

## Context

- Inputs (live facts): the cross-chunk report (`RV-cross-chunk`), the Luna report for L08-R4 when present, and the eight JSON reports (`L07-R1` to `L07-R4`, each `contract` and `verification`), `Base` and `Head`.
- Follow `review-panel-protocol.md` "Synthesis and cleanup": deduplicate by normalized file, line range and failure claim; for every Critical or Important finding, read the cited lines at `Head` (`git -C /Users/yahya/Documents/git/yooz/remi show HEAD:PATH | sed -n 'A,Bp'`) and mark it `verified` or `not reproduced` with one sentence.

## Scope

Read: the eight reports and the cited lines only (at most 40 findings).
Change: nothing.
Add no new findings; a gap you notice goes in `residual_risk`.

## Decided design

Settled: severity is the highest any reporter gave unless the cited lines show it is lower (say why); unavailable reviewers are listed with their chunk and lens, never silently dropped.
The reviewer may choose: the grouping of duplicates.

## Acceptance

One JSON object: `reviewer_id` `L07-synthesis`, `findings` (each with `sources` naming the chunk reports it merges and `verification`), `unavailable` (chunk and lens of any missing report), `residual_risk`.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi cat-file -t HEAD` prints `commit` for the given Head.

## Stop conditions

Any `contract` chunk report, the cross-chunk report is missing: return `status: "unavailable"` and name the missing ones (the manager re-dispatches each once, then asks the advisor; it never proceeds without them).

## Report

The JSON object only.
