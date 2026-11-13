# Card L10: verify the #1727 push; the PR decision is the owner's (Q16)

Status: ready
Tier: owner (no agent is dispatched; the manager runs the check)
Timebox: owner's pace
Needs: none
Depends: none
Branch: patch/issue-1727-store-callback-order (pushed by the manager session on the owner's instruction; seen at `9e7ddf41` on 2026-11-12)
Worktree: `/Volumes/S1/worktrees/remi/store-callback-order` (agents never write there)
Plan: plan.md section 1, #1727 row; Q7, Q16

## Goal

The manager confirms the #1727 prototype tests are on the remote branch, and the owner decides through Q16 whether a pull request follows.

## Context

- Q7 (owner, 2026-11-12): the three untracked files are synthetic; the owner asked the manager session to push them to `patch/issue-1727-store-callback-order`.
- Issue #1727: "Preserve native Store callback order per connection"; reproduction artifacts in `/Volumes/S1/yooz/remi/artifacts/callback-order-1727-20261031/`.
- #1720 (L07) is parked until #1727 is resolved (Q12).

## Scope

The manager reads the remote branch only; no agent commits, pushes or opens a PR here unless Q16's answer says so.

## Decided design

Settled: Q16's mapping in the runbook (section 11) decides the next action.
The owner may choose: no PR yet, a draft PR, or a PR to review and land (which needs a lead-written card first).

## Acceptance

`git -C /Users/yahya/Documents/git/yooz/remi ls-remote --heads origin patch/issue-1727-store-callback-order` prints one commit, and `git -C /Users/yahya/Documents/git/yooz/remi fetch origin && git -C /Users/yahya/Documents/git/yooz/remi diff --name-only origin/develop...origin/patch/issue-1727-store-callback-order` lists the three test files (record the list).

## Gates

`gh pr list --repo yooz-labs/remi --head patch/issue-1727-store-callback-order --state all --json number` is recorded (empty unless the owner opened one).

## Stop conditions

The remote branch is missing or holds files other than tests: record it and ask the owner.

## Report

The manager logs the commit, the file list and Q16's answer, and sets L10 `done` when Q16 is answered and acted on.
