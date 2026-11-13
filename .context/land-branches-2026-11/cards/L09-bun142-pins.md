# Card L09: Bun 1.4.2 CI and release pins (#1273, PR #1512)

Status: ready
Tier: worker-hard
Timebox: L, 2 days (the relay gate takes about 65 minutes per run); escalate at 4 days or two failed approaches
Needs: none
Depends: L01, L07, L08 (Q1 answered 2026-11-12: keep the phone gate)
Branch: chore/issue-1273-bun142-pins (PR #1512, open, DIRTY, head `3a654273` on 2026-11-12, 787 behind develop)
Worktree: `/Volumes/S1/worktrees/remi/bun142-pins` (create it per the preamble)
Plan: plan.md section 2, L09; risk R7

## Goal

PR #1512 is merged up to date with `develop`, every CI and release pin it moves still reads Bun 1.4.2 after the merge (including pins `develop` added since 2026-10-14), and a fresh hosted run on the final head passes, so review can start.

## Context

- The PR moves six executing CI and release pins from Bun 1.3.11 to 1.4.2 together with the relay workflow contract (`.github/scripts/workflow-contracts.json`) and strict runtime identity; it removes only the former 1.3.11 close allowances.
- Its body: hosted acceptance passed on 2026-10-14 at `3a654273`; "Physical-phone acceptance remains pending; keep this PR unmerged." The owner kept that gate (Q1, 2026-11-12): after this card and its review, the step waits for the owner's phone check, and the manager does not merge before the owner reports it.
- On 2026-11-12, `develop` still pins 1.3.11 in `auto-bump-dev.yml`, `ci.yml`, `close-on-develop.yml`, `macos-app.yml`, `relay-r7.yml`, `release.yml`, and also in `native-app.yml` (not touched by the PR).
- `git merge-tree` showed conflicts in `.context/plan.md`, `.github/scripts/check-ci-scope.py`, `.github/scripts/ci-scope.py` and, after L01, `AGENTS.md`.
- #1206 (a 1.4.2 full-suite hang seen once) is open; this card does not claim a fix.
- Evidence from the PR's preparation: `/Volumes/S1/yooz/remi/artifacts/2026-10-14-bun142-readiness/`.

## Scope

May change: the merge commit and its resolution; the files the PR already touches; `.github/workflows/native-app.yml`'s Bun pin only if the contract file requires all pins to move together (say so in the report); the PR body (extend it).
Everything else is out of scope; no test is deleted or weakened, no gate is relaxed.

## Decided design

Settled: merge, never rebase; in `AGENTS.md` keep develop's split layout and move any text the PR changed into the matching `docs/agent-reference/` file; in `.context/plan.md` keep both sides' entries; in the CI scope scripts keep develop's logic and re-apply the PR's change; every `bun-version` and `BUN_VERSION` in executing workflows reads 1.4.2 after the merge.
The implementer may choose: the mechanics of each resolution within those rules.

## Acceptance

1. `git merge origin/develop` (live-facts hash) completes; save `git show --cc HEAD` to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L09/r1/merge-cc.diff`.
2. `git grep -n -E 'bun-version|BUN_VERSION' .github/workflows` shows no 1.3.11 in an executing job (list any that remain and why).
3. The PR's own contract checks pass: run the commands its body lists for `workflow-contracts.json` and the CI scope scripts (quote each), plus `actionlint` if installed.
4. `bun test tests/integration/relay-r7-replay.test.ts tests/integration/relay-r3-transport-close.test.ts` passes locally (Bun 1.4.4 locally; say so).
5. Push once; `gh pr checks 1512` shows the new head's checks, including the relay gate (report states; the manager waits).
6. The PR body gains: develop hash merged, resolutions, and "Physical-phone acceptance: kept by the owner on 2026-11-12, pending".

## Gates

`bunx biome check .`, `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests`, `bun run typecheck:signaling`, `node_modules/.bin/tsc -p tests/integration/tsconfig.relay-r3.json`, `bun scripts/third-party-notices.ts --check`, `typos`: zero errors.

## Stop conditions

A resolution that would relax a test or a contract assertion; a CI scope script conflict whose two sides change the same rule differently; any hosted job failing twice for a reason the diff could cause.

## Report

The preamble's report, plus the remaining-pin list, the contract-check outputs, and the merge-cc path.
