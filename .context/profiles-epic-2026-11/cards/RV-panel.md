# Card RV-panel: round-1 reviewer for a step PR

Status: ready
Tier: reviewer
Timebox: S, 1 hour; a reviewer silent for 20 minutes is dispatched again once, then the advisor performs the lens
Needs: none
Depends: the step's implementer reported and the manager verified the report
Branch: none (read-only)
Worktree: none; commits are read by hash from `$HOME/Documents/git/yooz/remi` (or `$HOME/Documents/git/yooz/yooz-docs` for a docs PR)
Plan: plan.md section 3 (which lens groups each PR gets)

## Goal

One lens group's round-1 findings (at most 5) on a whole step PR, in the shape the manager can triage.

## Context

- Live facts: repository, PR number, step id, `Lens group`, `Base` (merge-base with the target branch), `Head`, and the card the implementer worked from.
- Lens groups:
  - `contract`: correctness, types, invariants, concurrency, data integrity, the card's decided design followed exactly, protocol rules (ADR 0035: capability added with the feature, version unchanged, fixtures regenerated);
  - `verification`: tests that can fail, negative paths, revert checks that really fail, silent failures and fallbacks, no mock that replaces business logic (owner's rule);
  - `maintainability`: comments, docs and PR text that claim more than the code does ("Verify before you describe", `AGENTS.md`), needless complexity that can cause defects;
  - `privacy`: every path by which a credential, a token, an email, an account id, a workspace name, a local path or an environment value could reach a log line, a file, a wire frame, a push or a client; status-command output kept unread beyond the allowed fields; nothing derived from the harness name that ADR 0051 A8 forbids (ADR 0049 D10, ADR 0051 A13);
  - `docs` (docs-only PRs): accuracy against the code or the recorded runs, every command block backed by a recorded run, broken links, lost or contradicted text, nothing unbuilt described; no overclaim (ADR 0011): remi never shows the email in its own interface, but the terminal view shows what the harness prints, which can include it, and "signed in" means the harness reports a stored sign-in.
- Procedure: `project:pr-review-toolkit` (`review-procedure.md`, `review-rubrics.md`); repository rules in `AGENTS.md` at `Head`.
- Name any finding that touches authentication, authorization, credentials or key handling as such; the manager sends contested ones to the advisor.

## Scope

Read: `git -C REPO diff BASE...HEAD`, files at `HEAD`, the PR body (`gh pr view N --repo REPO`) and the step's card in `/Volumes/S1/worktrees/remi/profiles-epic-plan/.context/profiles-epic-2026-11/cards/`.
Change: nothing; no comments, commits or messages.

## Decided design

Settled: at most 5 findings, highest severity first (Critical, Important, Moderate, Minor), plus `omitted_findings` (the count dropped by the cap), each with file, line, failure, concrete fix and confidence; only high-confidence findings.
The reviewer may choose: which findings to report.

## Acceptance

One JSON object per `review-panel-protocol.md` ("Report contract"), `reviewer_id` set to the step and lens group (for example `P1B-privacy`), and `checks` naming the commands run, for example `git diff --stat BASE...HEAD`.

## Gates

`gh pr view N --repo REPO --json headRefOid` equals the live facts' `Head` before review starts; otherwise return `status: "unavailable"`.

## Stop conditions

The PR head moved during the review: stop and report the new head.

## Report

The JSON object only.
