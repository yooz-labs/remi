# Card RV-panel: round-1 reviewer for an ordinary step PR

Status: ready
Tier: reviewer
Timebox: S, 1 hour; the manager proceeds without a reviewer silent for 20 minutes
Needs: none
Depends: the step's implementer reported and the manager verified the report
Branch: none (read-only)
Worktree: none; commits are read by hash from `/Users/yahya/Documents/git/yooz/remi`
Plan: plan.md section 3 (which lens groups each PR gets)

## Goal

One lens group's round-1 findings (at most 5) on a whole PR (L01 to L06, L09, L11, L12, P01, A01 to A03), in the shape the manager can triage.

## Context

- Live facts: PR number, `Lens group`, `Base` (merge-base with develop), `Head`.
- Lens groups: `contract` (correctness, types, invariants, security, concurrency, data integrity), `verification` (tests that can fail, negative paths, silent failures, fallbacks), `maintainability` (comments and docs that claim more than the code does, needless complexity that can cause defects), `docs` (docs-only PRs: accuracy against the code, broken links, lost or contradicted text).
- Procedure: `project:pr-review-toolkit` (`review-procedure.md`, `review-rubrics.md`); repository rules in `AGENTS.md` at `HEAD`, especially "Verify before you describe".
- Security-path PRs (L03 direct child key, L06 relay retry): name any finding that touches authentication, authorization, key handling or relay classification as such; the manager sends contested ones to the advisor.
- Q9 (owner, 2026-11-12): for L03 and L06 a Codex Luna second reviewer, on top of the Sonnet panel, receives this same card with lens group `contract` and `reviewer_id` ending in `-luna`; no other PR gets one.

## Scope

Read: `git -C /Users/yahya/Documents/git/yooz/remi diff BASE...HEAD`, files at `HEAD`, and the PR body (`gh pr view N`).
Change: nothing; no comments, commits or messages.

## Decided design

Settled: at most 5 findings, highest severity first (Critical, Important, Moderate, Minor), plus `omitted_findings` (the count dropped by the cap), each with file, line, failure, concrete fix and confidence; only high-confidence findings.
The reviewer may choose: which findings to report.

## Acceptance

One JSON object per `review-panel-protocol.md` ("Report contract"), `reviewer_id` set to the step and lens group (for example `L03-contract`), and `checks` naming the commands run, for example `git diff --stat BASE...HEAD`.

## Gates

`gh pr view N --json headRefOid` equals the live-facts `Head` before review starts; otherwise return `status: "unavailable"`.

## Stop conditions

The PR head moved during the review: stop and report the new head.

## Report

The JSON object only.
