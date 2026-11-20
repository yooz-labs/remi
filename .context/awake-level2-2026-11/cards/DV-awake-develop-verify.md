# Card DV-AWAKE: verify the develop tip after a keep-awake merge

Status: ready
Tier: worker
Timebox: S, 1 hour
Needs: none (no Xcode); macOS host
Depends: a keep-awake code PR just merged and its version-bump commit is on `origin/develop` (plan section 0, "After a merge")
Branch: none (detached checkout of the develop tip)
Worktree: `/Volumes/S1/worktrees/remi/awake-develop-verify` (the manager creates it once, detached, with `git -C "$HOME/Documents/git/yooz/remi" worktree add --detach /Volumes/S1/worktrees/remi/awake-develop-verify DEV_SHA`; this card only updates it)
Plan: plan.md section 0

## Goal

The merged `develop` tip passes the TypeScript gates and every keep-awake test on this Mac, because hosted CI runs on Ubuntu and skips each darwin-only power test, and no test workflow runs on pushes to `develop`.

## Context

- Pushes to `develop` run only `auto-bump-dev.yml` and `close-on-develop.yml`; the test workflows run on pull requests only, and all their jobs run on `ubuntu-latest` (`.github/workflows/ci.yml`), where `process.platform !== 'darwin'` tests skip.
- The live facts give `DEV_SHA` and the merged PR's number.
- The full daemon suite is not run here (it fails on this Mac for environmental reasons; profiles plan Appendix C).
- Preamble item 5 applies in full: the power tests start real `caffeinate` holders and test daemons on ports above 18790; nothing else.

## Scope

May change: nothing in git; the worktree is updated with `git -C /Volumes/S1/worktrees/remi/awake-develop-verify fetch origin`, `git -C /Volumes/S1/worktrees/remi/awake-develop-verify checkout --detach DEV_SHA` and `bun install --frozen-lockfile` in it.
Evidence goes to `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/DV/DEV_SHA/`.

## Decided design

Settled: report only; never fix, commit or push; a failure is reported with the first failing test and its log.
The worker may choose: nothing.

## Acceptance

All of these, run in the worktree at `DEV_SHA`, each with its last line quoted: `bunx biome check .`, `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests`, `bun run typecheck:signaling`, `bun scripts/third-party-notices.ts --check`; then, in the canonical environment, `mkdir -p /private/tmp/remi-canon-DV && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-DV/ bun test packages/daemon/tests/power packages/daemon/tests/integration/keep-awake-daemon-smoke.test.ts` plus every other `packages/daemon/tests/integration/keep-awake-*.test.ts` file present at `DEV_SHA`, ending with `0 fail` and no skipped power or keep-awake test; and `bun test` on every test file the merged PR changed (`gh pr diff N --repo yooz-labs/remi --name-only`) under `packages/daemon/tests/` or `packages/shared/tests/`, in the same environment.
Before and after the tests, `ioreg -r -c IOPMrootDomain -d 1 | grep '"SleepDisabled"'` prints `"SleepDisabled" = No`.

## Gates

`git -C /Volumes/S1/worktrees/remi/awake-develop-verify rev-parse HEAD` equals `DEV_SHA` before and after the run.

## Stop conditions

Any gate fails: stop and report; the manager treats it as a red `develop`.
`SleepDisabled` reads anything but `No`: stop at once and report it first.

## Report

The preamble's report with `pr` set to the merged PR's number and `head_sha` set to `DEV_SHA`.
