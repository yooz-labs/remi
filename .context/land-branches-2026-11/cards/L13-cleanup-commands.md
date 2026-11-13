# Card L13: cleanup commands for the owner

Status: ready
Tier: worker
Timebox: S, 2 hours
Needs: none
Depends: L99
Branch: chore/land-branches-plan (the pack branch; this card writes one file there)
Worktree: `/Volumes/S1/worktrees/remi/land-branches-plan`
Plan: plan.md section 1 and runbook section 13

## Goal

`.context/land-branches-2026-11/cleanup.md` lists, for every branch this plan landed or dropped, the exact commands the owner runs to remove its worktree, its DerivedData folder and its remote branch, each verified safe at the time of writing.

## Context

- The manager never deletes branches or worktrees; the owner runs these commands.
- Branches in scope: every L step's branch that is `done` (merged), the drop list Q8 approved (`patch/issue-1717-apns-test-scheduling`, `chore/native-build-21`, `patch/issue-1346-secure-push-expiry-fixture`, `feature/issue-1195-epic-relay`, the three `scratch/issue-1724-*`, `feature/issue-1313-image-availability` after L08), (Q8 approved by the owner on 2026-11-12, as commands only).
- Branches kept on purpose get no delete command; list them under "Kept": `feature/issue-1711-compact-preview` (Q5 park), `feature/issue-1641-native-wss-route` (Q6 fold), and any step branch that is `dropped`.
- Worktrees live under `/Volumes/S1/worktrees/remi/`; DerivedData under `/Volumes/S1/derived/remi-NAME`.

## Scope

May change: `.context/land-branches-2026-11/cleanup.md` only (new file), one commit on the pack branch.

## Decided design

Settled: for each branch, first a verification line, then the commands, in this order:
`git -C /Users/yahya/Documents/git/yooz/remi merge-base --is-ancestor origin/BRANCH origin/develop && echo merged` (for landed branches; for dropped ones, the reason instead),
`git -C /Users/yahya/Documents/git/yooz/remi worktree remove /Volumes/S1/worktrees/remi/NAME` (only if `git worktree list` shows it and `git -C` that worktree's `status --porcelain` is empty),
`rm -rf /Volumes/S1/derived/remi-NAME` (only if it exists),
`git -C /Users/yahya/Documents/git/yooz/remi push origin --delete BRANCH`,
`git -C /Users/yahya/Documents/git/yooz/remi branch -d BRANCH` (local),
and for #1717: `gh issue close 1717 --repo yooz-labs/remi --comment "Landed through #1719 (32aa9483)."`.
A worktree with uncommitted or untracked files gets no remove command; list it with its `status --short` output instead.
The `store-callback-order` worktree is never listed (L10 decides it).
The implementer may choose: grouping and order of the branches.

## Acceptance

Every verification line in `cleanup.md` was run by the worker and its output is quoted beside it; `git -C /Users/yahya/Documents/git/yooz/remi branch -r --merged origin/develop` output is attached for cross-checking.

## Gates

`typos .context/land-branches-2026-11/cleanup.md` is clean.

## Stop conditions

A branch marked landed is not an ancestor of `origin/develop`; a worktree has uncommitted work (list it, do not include a remove command).

## Report

The preamble's report with `pr` set to 0 (this card opens no PR) and `head_sha` set to the pack-branch commit, plus the count of branches per group.
Branch groups depend on Q11 and Q12: a parked branch (native-images under Q11 option a, #1720 under Q12 park) goes under "Kept".
