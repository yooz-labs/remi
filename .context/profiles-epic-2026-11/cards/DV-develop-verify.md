# Card DV: verify the develop tip after a merge

Status: ready
Tier: worker
Timebox: S, 2 hours (mostly the Xcode lock and `swift test`)
Needs: xcode
Depends: a step PR just merged and its version-bump commit is on `origin/develop` (runbook, "After a merge")
Branch: none (detached checkout of the develop tip)
Worktree: `/Volumes/S1/worktrees/remi/profiles-develop-verify` (the manager creates it once, detached; this card only updates it)
Plan: plan.md section 0.4; runbook section 10, "After a merge"

## Goal

The merged `develop` tip passes the TypeScript gates, the profile tests, and the native package tests, because no CI workflow runs them on pushes to `develop`.

## Context

- Pushes to `develop` run only `auto-bump-dev.yml` and `close-on-develop.yml`; the test workflows run on pull requests only (land-branches-2026-11, verified 2026-11-12).
- The live facts give the develop tip to verify (`DEV_SHA`), the PR that produced it, and `previous baseline` (the path of the previous green DV's `daemon-failures.txt`, or "none").
- Local native baseline (owner, Q20 of land-branches-2026-11): `PairingAttemptTests` and `PairingSourceTests` fail locally with "owned empty launch directory required"; hosted CI runs them.

## Scope

May change: nothing in git; the worktree is updated with `git -C /Volumes/S1/worktrees/remi/profiles-develop-verify fetch origin`, `git -C /Volumes/S1/worktrees/remi/profiles-develop-verify checkout --detach DEV_SHA` and `bun install --frozen-lockfile`.
Evidence goes to `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/DV/DEV_SHA/`.

## Decided design

Settled: report only; never fix, commit or push; a failure is reported with the first failing test and its log.
The worker may choose: nothing.

## Acceptance

All of these, run in the worktree at `DEV_SHA`, each with its last line quoted: `bunx biome check .`, `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests`, `bun run typecheck:signaling`, `node_modules/.bin/tsc -p tests/integration/tsconfig.relay-r3.json`, `bun scripts/third-party-notices.ts --check`, `bun test packages/daemon/tests/profiles` (once that folder exists on `develop`; otherwise say so), and `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests`.
Also run `bun test packages/daemon` and write the names of its failing tests, one per line, to `daemon-failures.txt` in the evidence folder; this gate is red only when a test fails that is not on the live facts' `previous baseline` list (the previous green DV's `daemon-failures.txt`; on the first DV of the plan there is no list, and the file becomes the baseline only if the lead confirms its failures are environmental and the owner's J19 answer keeps this gate; DV-1's file from `095ef7cc` is not a baseline, plan Appendix C). The manager passes the latest green DV's list to implementation cards as `baseline failing tests`.

## Gates

`git -C /Volumes/S1/worktrees/remi/profiles-develop-verify rev-parse HEAD` equals `DEV_SHA` before and after the run.

## Stop conditions

Any gate fails: stop and report; the manager treats it as a red `develop` (runbook section 10).

## Report

The preamble's report with `pr` set to the merged PR's number and `head_sha` set to `DEV_SHA`.
