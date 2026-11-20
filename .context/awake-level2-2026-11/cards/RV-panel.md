# Card RV-panel: round-1 reviewer for a keep-awake step PR

Status: ready
Tier: reviewer
Timebox: S, 1 hour; a reviewer silent for 20 minutes is dispatched again once, then the advisor performs the lens
Needs: none
Depends: the step's implementer reported and the manager verified the report
Branch: none (read-only)
Worktree: none; commits are read by hash from `$HOME/Documents/git/yooz/remi`
Plan: plan.md section 3 (which lens groups each PR gets); this card follows the profiles pack's RV-panel (`chore/profiles-epic-plan` at `14a7e82b`) with the `privilege` and `failsafe` lenses added

## Goal

One lens group's round-1 findings (at most 5) on a whole step PR, in the shape the manager can triage.

## Context

- Live facts: PR number, step id, `Lens group`, `Base` (merge-base with `develop`), `Head`, and the card the implementer worked from.
- Lens groups:
  - `contract`: correctness, types, invariants, concurrency, the card's decided design followed exactly (reason strings, key names, defaults, ranges), configuration keys added in all places at once (preamble item 9);
  - `verification`: tests that can fail, negative paths, revert checks that really fail, darwin-only tests run and quoted (hosted CI skips them), no mock that replaces business logic (the only allowed substitutes are the root-boundary stand-ins the card names and fixture-backed readers that run the real parsers);
  - `maintainability`: comments, docs and PR text that claim more than the code does ("Verify before you describe", `AGENTS.md`; a security or safety description that overstates protection is a finding of the highest severity it can cause), needless complexity;
  - `privacy`: captured fixtures and logs: no user name, home path, host name, email, URL, document or page title or third-party application name in a committed fixture; assertion names never logged or returned to a client;
  - `privilege`: every path to root or to a power-state change: only the constants of `power/level2-commands.ts`, absolute paths, argument arrays, no shell, `sudo -n`, a read-back after every write; the printed sudoers line, boot daemon and watchdog identical to what remi runs; the user-name check; nothing from a request, a file or the configuration reaches an argument; the local endpoint's gate (loopback plus the local capability); no test can reach `sudo`, a power-changing `pmset` or a writing `launchctl`; ADR 0050's same-user threat model stated, not overstated;
  - `failsafe`: fail-safe and data integrity: every failure (crash, SIGKILL, parse or read failure, lost or invalid lease, missing rule, version skew, reboot, a clock jump) ends with the Mac allowed to sleep; remi never clears a `SleepDisabled` it did not set and never touches another app's assertion; the lease is atomic, 0600, versioned and written before sleep is turned off; timers use the monotonic clock; no leftover holder, timer or child process;
  - `docs` (docs-only PRs): accuracy against the recorded runs and the code, every command quoted with its output, no overclaim.
- Procedure: `project:pr-review-toolkit` (`review-procedure.md`, `review-rubrics.md`); repository rules in `AGENTS.md` at `Head`; ADR 0050 at `Head`.
- Name any finding that touches privilege, authorization or the fail-safe stack as such; the manager sends contested ones to the advisor.

## Scope

Read: `git -C "$HOME/Documents/git/yooz/remi" diff BASE...HEAD`, files at `HEAD`, the PR body (`gh pr view N --repo yooz-labs/remi`) and the step's card in `/Volumes/S1/worktrees/remi/awake-l2-plan/.context/awake-level2-2026-11/cards/` (or the pack's branch `docs/issue-1773-awake-level2-plan` once it moved).
Change: nothing; no comments, commits or messages.
Run nothing that preamble item 5 forbids; reading tests is enough, running the card's focused tests in the canonical environment is allowed.

## Decided design

Settled: at most 5 findings, highest severity first (Critical, Important, Moderate, Minor), plus `omitted_findings` (the count dropped by the cap), each with file, line, failure, concrete fix and confidence; only high-confidence findings.
The reviewer may choose: which findings to report.

## Acceptance

One JSON object per `review-panel-protocol.md` ("Report contract"), `reviewer_id` set to the step and lens group (for example `L2-CORE-privilege`), and `checks` naming the commands run, for example `git diff --stat BASE...HEAD`.

## Gates

`gh pr view N --repo yooz-labs/remi --json headRefOid` equals the live facts' `Head` before review starts; otherwise return `status: "unavailable"`.

## Stop conditions

The PR head moved during the review: stop and report the new head.

## Report

The JSON object only.
