# Card L10: owner check of the local #1727 prototype files

Status: ready
Tier: owner (no agent is dispatched)
Timebox: owner's pace; asked at the first tick as Q7
Needs: none
Depends: none
Branch: patch/issue-1727-store-callback-order (local only, no remote branch, no commits beyond `4a525a14`)
Worktree: `/Volumes/S1/worktrees/remi/store-callback-order`
Plan: plan.md section 1, #1727 row

## Goal

The owner decides, after reading them, whether three untracked prototype files may be committed and pushed, kept local, or deleted; no agent reads, commits or pushes them.

## Context

- Issue #1727: "Preserve native Store callback order per connection"; the reproduction artifacts are in `/Volumes/S1/yooz/remi/artifacts/callback-order-1727-20261031/`.
- The three untracked files (sizes seen on 2026-11-12; contents not read by the lead on purpose, because they may derive from real transcripts):
  - `packages/daemon/tests/qualification/callback-transcript-corpus.ts` (7,002 bytes)
  - `packages/native/RemiKit/Tests/RemiKitTests/OwnedCallbackOwnershipPrototypeTests.swift` (20,157 bytes)
  - `packages/native/RemiKit/Tests/RemiKitTests/SyntheticTranscriptCorpusQualificationTests.swift` (3,949 bytes)
- The branch is 28 commits behind `develop` and has no commits of its own.

## Scope

The owner reads the three files and decides.
Agents change nothing in this worktree; the manager only records the answer.

## Decided design

Settled: nothing from this worktree enters git until the owner says so.
The owner may choose: push as is, keep local, delete, or ask the lead for a #1727 implementation card.

## Acceptance

The owner's check, suggested commands:
`git -C /Volumes/S1/worktrees/remi/store-callback-order status --short`,
`grep -n -i -E 'sk-|token|secret|password|/Users/|@[a-z0-9.-]+\.[a-z]{2,}' packages/daemon/tests/qualification/callback-transcript-corpus.ts packages/native/RemiKit/Tests/RemiKitTests/OwnedCallbackOwnershipPrototypeTests.swift packages/native/RemiKit/Tests/RemiKitTests/SyntheticTranscriptCorpusQualificationTests.swift` (run inside the worktree), then reading each file.
Q7 on the board holds the answer; the manager sets L10 `done` when the owner says the action is complete.

## Gates

`git -C /Volumes/S1/worktrees/remi/store-callback-order status --porcelain --untracked-files=all` matches the owner's chosen state (files committed, still untracked, or gone).

## Stop conditions

None for agents: any request to read or move these files goes to the owner.

## Report

The owner's answer, recorded with `decide ... --by owner`.
