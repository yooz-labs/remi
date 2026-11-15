# Card RV-delta: round-2 delta reviewer (fix commits only)

Status: ready
Tier: reviewer
Timebox: S, 45 minutes
Needs: none
Depends: round 1 was substantial (`review-convergence.md`) and the fix round is pushed
Branch: none (read-only)
Worktree: none; commits are read by hash from `/Users/yahya/Documents/git/yooz/remi` (or the yooz-docs main checkout for a docs PR)
Plan: plan.md section 3

## Goal

Critical or Important defects that the round-1 fixes introduce or fail to resolve, and nothing else; this is the PR's last review round.

## Context

- Live facts: repository, PR number, `Round1Head` (the head round 1 reviewed), `Head` (after the fixes), and the round-1 findings with their outcomes (fix, reject with reason, issue).
- Large fixes (substantial under rules 2, 3 or 5 of `review-convergence.md`) may arrive as a fix PR whose base is the step PR's head branch; this card then reviews that fix PR.
- Instruction from `review-convergence.md`: "Report only Critical or Important defects that the fixes introduce or fail to resolve. Do not re-flag rejected findings or code outside the fix diff."

## Scope

Read: `git -C REPO diff Round1Head..Head` and the files it touches at `Head`.
Change: nothing.

## Decided design

Settled: one reviewer; the report includes `omitted_findings`; no third round follows; findings here are fixed, rejected or filed as issues by the manager's normal triage, and the manager verifies each fix by its test or repro.
The reviewer may choose: nothing else.

## Acceptance

One JSON object per `review-panel-protocol.md`, `reviewer_id` `STEP-delta`, with each round-1 `fix` finding marked `resolved` or `not resolved` in `checks`.

## Gates

`git -C REPO merge-base --is-ancestor Round1Head Head` exits 0; otherwise return `status: "unavailable"` (the branch was rewritten, which the preamble forbids).

## Stop conditions

The fix diff is larger than 600 changed lines: report the first 600 lines' findings and say what was not read.

## Report

The JSON object only.
