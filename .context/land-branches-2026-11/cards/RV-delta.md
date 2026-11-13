# Card RV-delta: round-2 delta reviewer (fix commits only)

Status: ready
Tier: reviewer
Timebox: S, 45 minutes
Needs: none
Depends: round 1 was substantial (`review-convergence.md`) and the fix round is pushed
Branch: none (read-only)
Worktree: none; commits are read by hash from `/Users/yahya/Documents/git/yooz/remi`
Plan: plan.md section 3

## Goal

Critical or Important defects that the round-1 fixes introduce or fail to resolve, and nothing else; this is the PR's last review round.

## Context

- Live facts: PR number, `Round1Head` (the head round 1 reviewed), `Head` (after the fixes), and the round-1 findings with their outcomes (fix, reject with reason, issue).
- Big PRs (L07, L08): one delta reviewer per chunk whose files the fixes touched, each limited to that chunk's paths (`git diff Round1Head..Head -- FILES`); fixes large enough to be substantial under rules 2, 3 or 5 arrive as a fix PR whose base is the big PR's head branch, and this card reviews that fix PR.
- Q13 (owner, 2026-11-12): this card is also the one review of changes since a PR's recorded rounds: `Round1Head` is then the recorded reviewed head (#1728 `5c1f9380`, #1657 `26fbf947`, #1512 `3a654273`).
- Instruction from `review-convergence.md`: "Report only Critical or Important defects that the fixes introduce or fail to resolve. Do not re-flag rejected findings or code outside the fix diff."

## Scope

Read: `git -C /Users/yahya/Documents/git/yooz/remi diff Round1Head..Head` and the files it touches at `Head`.
Change: nothing.

## Decided design

Settled: one reviewer (one per touched chunk for L07 and L08); the report includes `omitted_findings`; no third round follows; findings here are fixed, rejected or filed as issues by the manager's normal triage, and the manager verifies each fix by its test or repro.
The reviewer may choose: nothing else.

## Acceptance

One JSON object per `review-panel-protocol.md`, `reviewer_id` `STEP-delta`, with each round-1 `fix` finding marked `resolved` or `not resolved` in `checks`.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi merge-base --is-ancestor Round1Head Head` exits 0; otherwise return `status: "unavailable"` (the branch was rewritten, which the preamble forbids).

## Stop conditions

The fix diff is larger than 600 changed lines: report the first 600 lines' findings and say what was not read.

## Report

The JSON object only.
