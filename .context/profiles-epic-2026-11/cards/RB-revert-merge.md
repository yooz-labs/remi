# Card RB: revert a merge, only on the owner's decision

Status: ready
Tier: worker
Timebox: S, 4 hours
Needs: none (xcode when the reverted PR touched `packages/native/`)
Depends: an owner answer that names the merge to revert (recorded with `decide ... --by owner`)
Branch: `patch/revert-MERGE8` off `origin/develop` (MERGE8 is the first eight characters of the merge commit)
Worktree: `/Volumes/S1/worktrees/remi/revert-MERGE8` (the manager creates it)
Plan: plan.md section 0.4; runbook section 10, "After a merge"

## Goal

A pull request into `develop` that reverts exactly one merge commit the owner named, with the gates that failed after it now passing, so the manager can merge it under the normal merge gate.

## Context

- Live facts: the merge commit (`MERGE_SHA`), its PR number, the failing gate and its log path from the DV report or CI.
- The owner decided the rollback; this card does not judge whether to revert.

## Scope

May change: one `git revert -m 1 MERGE_SHA` commit and the PR body.

## Decided design

Settled: one revert commit, no other edits; the PR body names the reverted PR, the failing gate, and the owner's decision date; it carries no issue-closing keyword.
The worker may choose: nothing.

## Acceptance

`git revert -m 1 MERGE_SHA --no-edit` applies cleanly; the gate that failed passes (run it as the DV card runs it); `gh pr create --base develop` opens the PR; report its number.

## Gates

The gate that failed, plus `typos` and `git diff --check origin/develop...HEAD`.

## Stop conditions

The revert conflicts (later merges built on it): stop and report the conflicting files; the owner decides.

## Report

The preamble's report.
