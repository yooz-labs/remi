# Card L02: terminal relay prefix qualification (#1656, PR #1657)

Status: ready
Tier: worker
Timebox: M, 1 day (the relay gate alone takes about 65 minutes); escalate at 2 days or two failed approaches
Needs: none
Depends: none
Branch: feature/issue-1656-terminal-relay-qualification (PR #1657, draft, head `26fbf947` on 2026-11-12)
Worktree: `/Volumes/S1/worktrees/remi/terminal-relay` (exists; it has untracked `packages/daemon/node_modules` and `packages/signaling/node_modules`, leave them)
Plan: plan.md section 2, L02

## Goal

PR #1657 is up to date with `develop`, has a green hosted check run on its final head, and its body states that its prerequisite #1655 merged, so review can start.

## Context

- Test-only phase of #1595: `scripts/terminal-relay-progress-proof.ts` (a manual probe outside `bun test` discovery, included by the root `tsconfig.json`), `docs/terminal-relay-prefix-qualification.{md,json}`, and two `.context` notes.
- The body says: "After #1655 merges, refresh from actual develop and retarget before merge"; #1655 merged on 2026-10-31 as `c101877a`; the PR's base is already `develop`.
- No check has run on the current head; the branch is 304 commits behind `develop`; `git merge-tree` showed a clean merge on 2026-11-12.

## Scope

May change: the merge commit from `origin/develop`; the six files the PR already touches, only if the develop merge or a gate requires it; the PR body (extend it).
Everything else is out of scope.

## Decided design

Settled: merge, do not rebase; the probe stays manual (not added to `bun test` discovery); no production code changes.
The implementer may choose: the wording of the body's added paragraph.

## Acceptance

- `git -C /Volumes/S1/worktrees/remi/terminal-relay merge-base --is-ancestor origin/develop HEAD` exits 0 after the merge (using the `origin/develop` given in the live facts).
- `bun run typecheck` passes (the root tsconfig includes the probe).
- The positive run documented in `docs/terminal-relay-prefix-qualification.md` passes once on the merged head: `E2E_BUNDLER=esbuild bun --no-env-file scripts/terminal-relay-progress-proof.ts --run /private/tmp/remi-terminal-relay-positive-l02` (a fresh, empty directory; the doc asks for an owned HOME and TMPDIR, so follow its setup lines); quote the last line and the exit code. Local Bun is 1.4.4, not a pinned binary; say so.
- `gh pr checks 1657` shows checks for the new head (report their state; the manager waits for them).
- The PR body gains one paragraph: "#1655 merged as c101877a; refreshed from develop at" plus the merged develop hash.

## Gates

`bunx biome check .`, `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests`, `bun run typecheck:signaling`, `bun scripts/third-party-notices.ts --check`, `typos`: zero errors (Biome's baseline warnings stay as they are; report the warning count before and after).

## Stop conditions

A merge conflict in any file; a type error that the develop merge introduced in a file outside Scope; the probe's documented command fails on the merged head.

## Report

The preamble's report, plus the develop hash merged and the warning counts.
