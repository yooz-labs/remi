# Card A03: fold the Fable findings into the account-switching design; owner checkpoint

Status: ready
Tier: lead
Timebox: M, 1 day
Needs: none
Depends: A02
Branch: `feature/issue-1157-account-switching-design` (the A01 PR)
Worktree: `/Volumes/S1/worktrees/remi/account-switching-design`
Plan: plan.md section 5.2; checkpoint CP4

## Goal

The A01 draft carries a disposition for every A02 finding, is reviewed once, and waits for the owner's approval with the epic's filing commands ready; still no implementation code.

## Context

- Inputs: the A01 PR, the A02 review at `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/A02/review.md`.
- After this card the manager dispatches one Sonnet reviewer (RV-panel, lens group `docs`), and its findings are resolved like any round 1; then the step goes `owner`.

## Scope

May change: the ADR, `.context/account-switching-epic.md`, `.context/land-branches-2026-11/issues-to-file.md` on the pack branch (one row per issue to file, with its `gh issue create` command), the PR body.
No source, test, config or workflow changes.

## Decided design

Settled: every A02 finding gets a disposition in an ADR appendix (accepted and changed, accepted as an open question for the owner, or rejected with a one-sentence reason); every terms-of-service risk the advisor raised is visible in the ADR's Consequences; the ADR stays "proposed".
The lead may choose: how each accepted finding changes the design.

## Acceptance

1. `grep -c 'A02-' .context/decisions/*account-switching.md` is at least the number of findings in the A02 table (each finding id appears in the appendix).
2. The PR body ends with the owner's questions (from the ADR and from A02), each with a recommended option.
3. `issues-to-file.md` on the pack branch lists the epic and each phase issue with its exact `gh issue create --repo yooz-labs/remi --title ... --body-file ...` command; nothing is filed.
4. `gh pr ready` on the A01 PR after the docs review is resolved; the step goes `owner`; the manager does not merge it before the owner approves.

## Gates

`typos .context/decisions .context/account-switching-epic.md` is clean; `git diff --name-only origin/develop...HEAD` lists only the ADR, the epic file and the decisions README.

## Stop conditions

An A02 finding says the feature as proposed would breach a provider's terms: do not redesign around it; put it first in the owner questions and stop.

## Report

The preamble's report, plus the finding count by disposition and the owner questions.
