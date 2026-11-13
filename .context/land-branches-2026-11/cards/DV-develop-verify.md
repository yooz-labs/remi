# Card DV: verify the develop tip after a merge

Status: ready
Tier: worker
Timebox: S, 2 hours (mostly the Xcode lock and `swift test`)
Needs: xcode
Depends: a step PR just merged and its version-bump commit is on `origin/develop` (runbook, "Merge")
Branch: none (detached checkout of the develop tip)
Worktree: `/Volumes/S1/worktrees/remi/develop-verify` (the manager creates it once, detached; this card only updates it)
Plan: plan.md section 0.4 (red develop detection)

## Goal

The merged `develop` tip passes the TypeScript gates and the native package tests, because no CI workflow runs them on pushes to `develop`.

## Context

- Pushes to `develop` run only `auto-bump-dev.yml` and `close-on-develop.yml`; `native-app.yml` and `relay-r7.yml` run on pull requests only, and the repository has no required checks (2026-11-12).
- The live facts give the develop tip to verify (`DEV_SHA`) and the PR that produced it.

## Scope

May change: nothing in git; the worktree is updated with `git -C /Volumes/S1/worktrees/remi/develop-verify checkout --detach DEV_SHA` and `bun install --frozen-lockfile`.
Evidence goes to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/DV/DEV_SHA/`.

## Decided design

Settled: report only; never fix, commit or push; a failure is reported with the first failing test and its log.
The worker may choose: nothing.

## Acceptance

All of these, run in the worktree at `DEV_SHA`, each with its last line quoted: `bunx biome check .`, `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests`, `bun run typecheck:signaling`, `node_modules/.bin/tsc -p tests/integration/tsconfig.relay-r3.json`, `bun scripts/third-party-notices.ts --check`, and `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit` (rerun once with `--skip PairingAttemptTests` only if that suite alone fails, and say so).

## Gates

`git -C /Volumes/S1/worktrees/remi/develop-verify rev-parse HEAD` equals `DEV_SHA` before and after the run.

## Stop conditions

Any gate fails: stop and report; the manager treats it as a red `develop` (runbook).

## Report

The preamble's report with `pr` set to the merged PR's number and `head_sha` set to `DEV_SHA`.
