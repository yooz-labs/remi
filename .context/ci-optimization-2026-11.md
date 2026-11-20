# CI optimization analysis (issue #1793), 2026-11-17

Measured analysis and proposal for the continuous integration (CI) workflows of `yooz-labs/remi`.
No workflow file is changed by this document; step 2 of #1793 lands the approved items as small pull requests (PRs).
Every duration is in minutes and comes from the GitHub Actions jobs API (`completed_at - started_at` per job, `started_at - created_at` for queue time); run ids are quoted so each number can be re-read.

## Summary

Correction to the premise in #1793: the `macOS App` job on release PR #1792 was not cancelled by its concurrency group.
All 8 `Build and Test (macOS)` attempts since 2026-11-13 ended `cancelled` at second zero; 7 carry the annotation "The configuration 'macos-14-arm64-us-default' is not supported" (runs 43447234040, 43461792851, 43665062438, 43669645107; the last attempt at 2026-11-17T12:09:45Z) and the eighth (43669633858) was superseded by a newer push.
The last real macOS App run was 39537214947 (2026-10-21); since then `packages/macos` has had no CI coverage at all, while its scope job still spent 9.6 to 13.2 minutes before each doomed build (runs 43669645107 and 43447234040).

The five findings with the largest wall-clock effect:

1. **The 61-minute relay soak is the critical path of every code PR.**
   All 23 PR heads between 2026-10-28 and 2026-11-15 that ran the Bun tests also ran it; their check time (slowest workflow) had a median of 64.8 and a 90th percentile (p90) of 74.7, while CI itself took 12 to 25.
   The soak-reuse step (#1206) verified 0 of 78 attempts.
   Moving the soak off the per-PR path (B1, owner decision) saves about 50 minutes per code-PR head (64.8 to about 14.5; about 5.5 with A5).
2. **Native-only PRs pay for the soak through a classifier fallback.**
   11 of those 23 soak heads changed nothing outside `packages/native` (plus `native-app.yml`); the scope reason was "Unknown native input; running all gates" (9 heads: a TypeScript fixture under `packages/native/RemiKit/Tests/Integration/`) or "Gate workflow or configuration changed" (2 heads).
   A1 (pure speedup) cuts those heads from about 64.5 to the native job, saving at least 43 minutes each (64.5 minus the 21.8 native median).
3. **The native job doubled and turned flaky.**
   `Build and Test (Native)` has a median of 21.8 (n=30, p90 23.8) since the idle-relay suite was added at 2026-11-13T15:43Z, against 9.9 before (n=110); 14 of its 48 attempts since then failed.
   It is the critical path of the most common PR kind (35 of 60 PR heads since then were native-only).
   Splitting it into two parallel jobs and dropping one duplicate build (A2, A3) gives about 10.5 (saving 11.3); fixing the flakes (A7) avoids 22-minute reruns.
4. **The scope validator is a 12-minute serial prefix, run three times.**
   When validator inputs change (21 of 208 CI runs, including both release-PR heads in the window and, by design, every push to `main`), each of the CI, Relay and macOS scope jobs runs `check-ci-scope.py` (2383 controls, 565 seconds in run 43669645107) before any runtime job starts: median 12.3 (n=21), slowest 14.3 (run 40547542084).
   A4 starts runtime jobs after the 0.1-second classification instead, saving about 12 minutes on those runs (release PR relay 76.7 to about 64.5; merge-to-Auto-Release on `main` 29.3 to about 17).
5. **The Bun test shards are badly unbalanced.**
   Worker 1 (355 daemon files) has a median of 14.4, worker 2 (167 files) 4.9, worker 0 (one isolated file) 0.2.
   Splitting the daemon cohort three ways by measured time gives 4.6 each (A5), so the CI test path falls from about 14.6 to about 5.5.
   Today this is hidden behind the soak on every code PR; it becomes the code-PR critical path once B1 lands, and it already shortens every `main` push.

Owner decisions needed: B1 (soak scheduling and the "required relay soak gate" wording in architecture decision record (ADR) 0048), B2 (retire or repair the macOS App workflow), B3 (skip the redundant CI rerun on the bot's stable-bump commit), B4 (release-PR churn), B5 (recommended no).
A1 and A4 change the fail-closed scope classifier and deserve the owner's review even though they keep coverage.

## Data and method

All reads were GET only; no run was rerun, cancelled or dispatched.

```sh
gh run list --repo yooz-labs/remi --workflow <file> --limit 60 \
  --json databaseId,conclusion,createdAt,updatedAt,startedAt,event,headBranch,headSha,status,attempt  # 200 for ci, relay-r7, native-app
gh api "repos/yooz-labs/remi/actions/runs/<run id>/jobs?per_page=100&filter=all"   # jobs, steps, labels, every attempt
gh api --allow-escape-sequences repos/yooz-labs/remi/actions/jobs/<job id>/logs    # per-attempt log
gh api repos/yooz-labs/remi/check-runs/<job id>/annotations                         # cancellation reasons
gh api repos/yooz-labs/remi/actions/artifacts/14144925528/zip                        # worker 1 junit, run 43669645087
gh pr list --repo yooz-labs/remi --state all --head <branch> --json number,files    # PR file lists
```

`gh run view --job <id> --log-failed` returned the latest attempt's log for re-run jobs, so per-attempt logs were read through the jobs API by job id.
Windows: CI and Relay from 2026-10-23, Native from 2026-10-20, all to 2026-11-15 (200 runs each); macOS App (from 2026-07-29), Release, Auto Bump Dev and Close Issues on Develop (last 60 runs each).
PR kinds and critical paths use the 106 PR heads created from 2026-10-28 (after the three-worker test split) to 2026-11-15, grouped by head commit across workflows.
Workflow wall-clock is last job completion minus first job creation (attempt 1); a PR head's check time is the slowest of its workflows.
Queue time was negligible everywhere: median 0.0 to 0.1 for every job; the longest wait was 1.1 for macOS App and 10.1 for one Release build (run 43447233886).
The analysis scripts are not committed; they only aggregate the JSON returned by the commands above.

## Required checks and branch protection

No check is required by GitHub.
`gh api repos/yooz-labs/remi/branches/develop/protection` and `.../branches/main/protection` return "Branch not protected"; the only rules are the rulesets `keep-develop` (16077581) and `keep-main` (13450430), which block deletion and non-fast-forward pushes (`gh api repos/yooz-labs/remi/rules/branches/develop`).
"Required" below therefore means required by convention: the AGENTS.md CI section names Biome, type check, `bun test --coverage` (60% minimum) and typos; ADR 0048 calls the relay soak "the actual required relay soak gate"; the `macos-app.yml` header says it is not a required gate; nothing states it for Native.
The repository is public (`gh api repos/yooz-labs/remi --jq .visibility`), so per GitHub's billing rules standard hosted runner minutes are not billed; the macOS 10x minute multiplier applies to private repositories, and the cost here is wall-clock and concurrent-job slots.

## Measurements

"Full" rows count only jobs that did the work (the scope can turn a job into a 0.1-minute skip).
Cancel and failure counts are over all job attempts in the window.

| Workflow / job | Runner | Trigger and scope | Required | Median | p90 / slowest | Cancelled / failed | Evidence runs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CI / CI Scope, all runs | ubuntu-latest | PR to main, develop; push to main | convention | 0.2 (n=208) | p90 1.8 | 4 / 0 of 209 | 43631261965 |
| CI / CI Scope, validator ran | ubuntu-latest | same, validator inputs changed or non-PR event | convention | 12.3 (n=21) | 14.3 | in above | 43669645087, 40547542084 |
| CI / Spelling | ubuntu-latest | every CI run, no scope | convention | 0.1 | 0.3 | 1 / 1 | 43669645087 |
| CI / Lint, full | ubuntu-latest | scope `lint` | convention | 0.2 (n=100) | 0.35 | 4 / 1 of 208 | 43631261965 |
| CI / Type Check, full | ubuntu-latest | scope `typecheck` | convention | 0.7 (n=89) | 0.9 | 4 / 0 of 208 | 40048956685 |
| CI / Test worker 0, full | ubuntu-latest | scope `test` | convention | 0.2 (n=40) | 0.5 | 0 / 1 | 43669645087 |
| CI / Test worker 1, full | ubuntu-latest | scope `test` | convention | 14.4 (n=39) | p90 16.2, 16.4 | 1 / 3 | 43669645087, 40589843345 |
| CI / Test worker 2, full | ubuntu-latest | scope `test` | convention | 4.9 (n=40) | 5.3 | 0 / 2 | 43455506050 |
| CI / Test (aggregate), full | ubuntu-latest | needs all workers | convention | 0.2 | 0.3 | 2 / 2 of 61 (recent) | 43669645087 |
| Relay R7 / Relay Scope, validator ran | ubuntu-latest | PR to main, develop; dispatch | ADR 0048 | 11.5 (n=18) | 14.0 | 3 / 0 of 200 | 43669645163, 40541477514 |
| Relay R7 / local-relay, short controls only | ubuntu-latest | scope `relay`, soak scoped out | ADR 0048 | 3.2 (short step, n=78) | 3.4 | | 43669645163 |
| Relay R7 / local-relay, with soak | ubuntu-latest | scope `relay_soak` | ADR 0048 | 64.5 (n=53) | 67.5 | 29 / 1 of 200; 25 of 78 soaks cancelled | 43631261997, 41090624860 |
| Native Apps / Build and Test (Native), since 2026-11-13 | `xcode-27` (image `xcode-27-arm64`) | PR to main, develop, feature/**; paths `packages/native/**`, `config/app-release.json`, 3 scripts, itself; no scope job | not stated | 21.8 (n=30) | p90 23.8, 25.4 | 4 / 14 of 48 | 43574419500, 43634765686 |
| Native Apps / same, 2026-10-20 to 2026-11-13 | same | same | not stated | 9.9 (n=110) | p90 14.6, 20.1 | 38 / 21 of 169 | |
| macOS App / macOS Scope, validator ran | ubuntu-latest | PR, paths `packages/macos/**`, two `packages/web` native globs, a script, itself | no (header) | 11.7 (n=15) | 13.8 | 2 / 1 of 30 | 43669645107 |
| macOS App / Build and Test (macOS) | `macos-14`, unsupported since at least 2026-11-13 | same, scope `macos` | no (header) | 2.0 (n=52 that ran) | 4.7 | 13 / 13 of 65; 8 of 8 attempts since 2026-11-13 cancelled | 39537214947 (last success), 43669645107 |
| Release / build x3 | macos-latest, ubuntu-latest, ubuntu-24.04-arm | tag `v*`; PR touching `release.yml` | release | 0.2 to 0.3 | 0.5 | 4 / 0 | 43447233886 |
| Release / release, publish-npm, update-homebrew | ubuntu-latest | stable tag | release | 0.3, 1.1, 0.1 | 2.2, 2.0, 5.1 (npm propagation wait) | 1 / 2, 1 / 3, 1 / 11 of 76 (since 2026-05) | 27148412363 |
| Auto Bump Dev | ubuntu-latest | push to develop | n/a | 0.2 | 0.5 | 30 of 60 skipped (bot's own bump commits) | 43449928946 |
| Close Issues on Develop | ubuntu-latest | push to develop | n/a | 0.1 | 0.3 | 0 / 0 | 43455338611 |

## Critical path per PR kind

Kinds come from which steps ran in each head's CI, Relay and Native runs (2026-10-28 to 2026-11-15; 11 more heads were superseded and cancelled); a code PR is one where the Bun tests or the relay controls ran.

| PR kind (heads) | Today: critical path, check time | After Proposal A | After A and B1 |
| --- | --- | --- | --- |
| Docs or other inert files (15) | CI 0.4: scope 0.1, every job a scoped skip; median 0.4, slowest 0.5 (3bbbf5c8: runs 43643486067, 43643485979) | unchanged | unchanged |
| Code or CI-configuration PR (the other 12 of the 23 soak heads) | Relay: scope 0.2, short controls 3.1, reuse check 0.0, soak 61.0, job 64.5 (12f9e457: 43631261997); CI in parallel: worker 1 12.8 (43631261965) | 64.5; 61.5 with A8 | CI: about 13.5 with today's shards, about 5.5 with A5 |
| Native-only, Swift and project files (35 since 2026-11-13) | Native job 21.8 median: swift test 3.5, idle-relay suite 6.7, Mac Debug 1.8, Mac Release 3.4, iPhone simulator 1.9, iPhone Release device 2.2, contract 0.1, archive 2.1 (65047f08: 43574419500, 24.2); check-time median 20.4, p90 23.6 | about 10.5 (A2, A3) | same |
| Native-only with a TypeScript fixture or `native-app.yml` change (11 of the 23 soak heads) | Relay soak, 64.5 to 77.0 (477f1680, PR #1728: relay 43407701514 64.5, CI 43407701546 13.2, native 43407701690 12.2) | native job, about 10.5 (A1 then A2) | same |
| Release PR develop to main (PR #1792, head fbd2841d) | Relay 76.7: scope with validator 12.3, short 3.1, soak 61.0 (43669645163); CI 28.0: scope 13.6, worker 1 14.0, aggregate 0.2 (43669645087); native 23.9 (43669645116); macOS scope 9.6 then build cancelled (43669645107) | about 64.5 (A4), CI about 14.5, native about 10.5 | about 64.5 if B1 keeps the soak on release PRs |
| Push to main after the release merge | CI 40599736636: scope 12.5, worker 1 16.4, Auto Release starts at 29.3; then a second full run for the bot's stable bump, 40603200488, 26.9 | about 17 (A4); about 6 (A4 and A5) | B3 drops the second run |

Two effects are not visible in single-run numbers.
Superseding pushes cancelled 25 of 78 soaks (median 21.3 minutes in; 634 runner-minutes) under `cancel-in-progress`, which follows the owner's rule and is not proposed for change.
On the release PR, every merge to `develop` produces two pushes about 10 seconds apart (merge, then the dev bump), and each restarts the 65 to 77 minutes of checks (78b5d95e was cancelled by fbd2841d nine seconds later; 095ef7cc's soak was cancelled 42.4 minutes in by the next merge).

## Proposal A: pure speedups, no coverage change

Arithmetic uses the medians above; "about" marks estimates for overhead (checkout, setup, about 0.3 per job).

### A1. Stop native-only diffs from selecting every gate

- Change: in `ci-scope.py`, extend the existing `NATIVE_SECURE_FIXTURE` exemption to every TypeScript fixture under `packages/native/RemiKit/Tests/Integration/` that is not a discoverable `*.test.*`/`*.spec.*` file, keeping the same "no consumer outside `packages/native`" `git grep` at base and head and selecting `lint`; classify `.github/workflows/native-app.yml` like the other non-relay workflows instead of the generic `.github/` all-gates branch.
- Saving: 11 of 23 soak heads (PRs #1728, #1714, #1707, #1706, #1736) drop from relay 64.5 to 77.0 to their native job (12.2 for 477f1680; 21.8 median today), at least 43 minutes each; they also skip the 14-minute Bun suite.
  The other 12 soak heads were selected by a normal classification (5: 12f9e457, 9c03070a, 96956f5f, 750dc597, 5f8e57eb) or by all-gates fallbacks (7: workflow comparison 2, unknown path such as `tsconfig.json` or `config/app-release.json` 3, Bun diagnostic runner 1, cold relocation 1), read from each Relay Scope log.
- Risk: low to medium; a fixture imported by Bun-tested code would lose its runtime gates, which the consumer grep exists to catch.
  Bun discovers tests anywhere in the tree (`discoverTests` in `scripts/ci/run-bun-test-batches.ts`), so `*.test.ts` under `packages/native` must keep the all-gates fallback.
- Verify: run `python3 .github/scripts/ci-scope.py --base <base> --head <head>` on the 11 heads (listed in the evidence above) before and after; expect `relay_soak` and `test` false and `lint` true after.
- Card: files `.github/scripts/ci-scope.py`, `.github/scripts/check-ci-scope.py` (new controls for both branches); acceptance: the replay above shows the expected outputs for all 11 heads, and the next 5 native-only PRs that touch a fixture have a check time at most the native job plus 1 minute.

### A2. Split the native job into two parallel jobs

- Change: job "RemiKit tests" (checkout, toolchain check, `swift test`, idle-relay suite) and job "Xcode builds" (four `xcodebuild build`, TestFlight contract, unsigned archive, `git diff --exit-code`), each uploading its own evidence.
- Saving: tests job 0.3 + 3.5 + 6.7 = about 10.5; builds job 0.3 + 1.8 + 3.4 + 1.9 + 2.2 + 0.1 + 2.1 = about 11.8; wall about 11.8 instead of 21.8 (minus 10.0, 46%).
  The idle suite reuses the `swift test` build (it rebuilt in 1.77 seconds in run 43669645116), so it stays in the tests job.
- Risk: low; two macOS runners per native PR instead of one (queue time has been 0.0 to 0.2; the free-plan macOS concurrency limit is not visible through the API).
- Verify: compare the median of 10 native runs after the change with 21.8 (n=30).
- Card: files `.github/workflows/native-app.yml`, `scripts/test-native-ci-workflow.sh` (its static contract greps the single job, for example `timeout-minutes: 45`); acceptance: median native workflow wall-clock at most 13 over 10 consecutive successful runs.

### A3. Drop the duplicate iPhone Release device build

- Change: remove "Build native iPhone app (Release device)"; `scripts/testflight-ios.sh --unsigned-archive` runs `xcodebuild clean archive -scheme RemiPhone -configuration Release -destination 'generic/platform=iOS' ... CODE_SIGNING_ALLOWED=NO`, the same scheme, configuration and destination from a clean state.
- Saving: 2.2 median from the builds job, which then is about 9.6, so A2 and A3 together give a wall of about 10.5 (the tests job), minus 11.3 from today.
- Risk: low; verify first that the archive compiles every target the separate build compiles (diff the target lists in the two logs of one run).
- Card: files as A2; acceptance: the target-list diff is empty, and the builds job median is at most 10.5 over 10 runs.

### A4. Take the scope validator off the serial path

- Change: split each scope job into "classify" (the `ci-scope.py` classification and `check-scope-output.py`, 0.08 seconds in run 43669645107) that gates runtime jobs, and "validate" (`check-ci-scope.py`, `workflow-scope.py`) that runs in parallel; the aggregate `Test` job, `Auto Release` and the relay job's receipt step also `need` validate.
  A failed validation still makes the run red, so the merge signal is unchanged; only the start of runtime jobs moves earlier.
  Optional second step: run the 2383 controls of `check-ci-scope.py` in a process pool (not profiled; see the last section).
- Saving: about 12 minutes on runs where the validator runs (CI median 12.3, Relay 11.5): release PR relay 76.7 to about 64.5 and CI 28.0 to about 14.5; `main` push to Auto Release 29.3 to about 17.
- Risk: medium; it reverses the "runtime checks were not started" fail-closed order chosen in #1359, and `workflow-contracts.json` and `check-ci-scope.py` encode the current job graph, so they change in the same PR.
- Card: files `ci.yml`, `relay-r7.yml`, `macos-app.yml` (or none if B2 retires it), `.github/actions/ci-scope/action.yml`, `workflow-contracts.json`, `check-ci-scope.py`; acceptance: on the next 3 PRs that change a validator input, CI wall-clock at most 16 (from 22.8 to 28.0) and the relay job starts within 1 minute of the run.

### A5. Balance the Bun test workers

- Change: keep worker 0 (the isolated `remote-new-client.test.ts`) and the non-daemon cohort as they are, and split the daemon cohort into three deterministic lanes balanced by measured time, giving five workers in `partitionTests` and the matrix.
- Saving: from the junit of run 43669645087 the daemon cohort sums to 13.8 minutes and a greedy three-way split gives 4.6, 4.6, 4.6; the non-daemon cohort is 4.2 (job 4.9); CI test path 14.4 + 0.2 to about 5.5 (minus 9).
  No code-PR check time changes while the soak is per-PR (0 of 23 code-PR heads had CI as the critical path); `main` pushes gain the full 9 minutes.
- Risk: medium; the cohorts are "shared-cache" by design (#1626), and the earlier stalls in #1206 are undiagnosed, so a split may expose order-dependent tests.
- Card: files `scripts/ci/run-bun-test-batches.ts` (`partitionTests`, `laneDeadlineMs` accepts only lanes 0 to 2), its tests, `ci.yml`, `workflow-contracts.json` (`partition`, `bounds_ms`); acceptance: 10 full runs with no new failures and a slowest-worker median at most 6.

### A6. Give every job a timeout

- Change: add `timeout-minutes` to the jobs that have none (CI Scope, Spelling, Lint, Type Check, Auto Release, Release Guard, Sync Develop; Relay Scope; macOS Scope; Release `release`, `publish-npm`, `update-homebrew`; Auto Bump Dev), set at about twice the slowest measured value (for example 30 for the scope jobs, slowest 14.3).
- Saving: none in normal runs; a hung job stops at its bound instead of GitHub's 360-minute default.
- Card: workflow files and contracts; acceptance: `actionlint` and `workflow-scope.py` pass and every job in `.github/workflows/` has a `timeout-minutes` key.

### A7. Fix the native flakes

- Evidence: 35 failed native attempts (2026-10-20 to 2026-11-15) from their job logs: 12 include `swiftpm-testing-helper` exiting with signal 11; named failures are `silentRealTCPListenerCannotLeaveDirectConnectSpinning` (9), `largeTranscriptStillPassesTheRealConnection` (7, `.startupTimedOut`), `delayedChallengeDoesNotResetAuthenticationDeadline` (3), `completionRunsOnMainAfterSuspendedHandling` (2) and five others once.
  14 of the 16 re-run native runs passed on the same commit (13 at attempt 2, one at attempt 3, for example 43381942557, 43455506110, 43543905820, 43665062422).
- Saving: each flake costs a full 22-minute rerun; if all 14 failures in 48 attempts were flakes (p = 0.29), a green result needs p / (1 - p) = 0.41 extra runs on average, about 9 minutes (0.41 x 21.8); at least 13 of the 16 re-run failures were flakes.
- Card: one issue per test with its run ids (test fixes, no workflow change); acceptance: fewer than 1 failure in 20 consecutive native runs on unchanged commits.

### A8. Start the soak without waiting for the short controls (only if B1 is rejected)

- Change: run "Existing actual wire and authority controls" (3.1) in its own job beside the soak.
- Saving: 3.1 of the 64.5 code-PR path (5%).
- Risk: medium; `relay-soak-reuse.py` requires both steps in the same producer job, so the receipt format changes too.

### Duplicated work and caching

- The validator runs three times in parallel for one PR head (CI, Relay, macOS scope jobs); A4 removes it from the critical path, and B2 removes one copy.
- The relay short controls (`packages/signaling/tests/e2e`, two `packages/web/tests/relay-*` files, `tests/integration/relay-r3*`, `relay-r6-ingress`, `relay-r7*`) are all also in CI worker 2's lane; the relay job reruns them without coverage for its R7 receipt.
- The iPhone Release device build is repeated by the archive (A3); the Mac Release build compiles both arm64 and x86_64 (seen in run 43669645116), which explains 3.4 against 1.8 for Debug.
- `main` runs the full CI twice per release (A4, B3), and `ci.yml` keeps an `E2E Tests` job with `if: false`.
- Caching would not help the Bun side: `bun install --frozen-lockfile` takes 0.0 to 0.1 minutes in every job (2 to 8 seconds), and `setup-node` the same.
  Swift Package Manager (SwiftPM) has nothing to fetch (RemiKit and both Xcode projects declare no remote package).
  What remains is compile time: `swift test` built for 165.8 seconds in run 43669645116; a `.build` or DerivedData cache might save part of that, but the gain is not measured and is worth trying only after A2.

## Proposal B: coverage trade-offs for the owner

### B1. Run the relay soak off the per-PR path

- Change: run the soak on a nightly schedule against `develop`, on release PRs (develop to main), on `workflow_dispatch`, and on PRs carrying a label (for example `relay-soak`); on other PRs the Relay workflow would run only the short controls, which CI already runs, so its PR trigger could go.
  Alternative B1b: keep it per-PR but narrow `relay_soak` to relay-transport paths (not measured: needs a file-level classification of the 5 normally classified soak heads).
- Coverage lost: the per-PR proof that an attached relay session survives 61 actual minutes; a regression is found after merge (by the next nightly) or at the release PR instead of before merge.
- Residual risk: a soak regression on `develop` must be bisected among about 2 merges per day (30 non-bump pushes to `develop` from 2026-10-31 to 2026-11-15, Auto Bump Dev runs).
- Saving: code-PR check time 64.8 median to CI's about 14.5 (about 5.5 with A5); 53 completed soaks used 3,422 runner-minutes and 25 cancelled ones 634 in the 200-run window.
- Needs: amending ADR 0048 ("the actual required relay soak gate") and `docs/relay-r7-gates.md`, plus the contracts.
- Recommendation: yes, with the soak kept blocking on release PRs and opt-in by label for relay-transport work.

### B2. Retire or repair the macOS App workflow

- Facts: `runs-on: macos-14` is rejected ("The configuration 'macos-14-arm64-us-default' is not supported"), so the workflow has covered nothing since at least 2026-11-13; `packages/macos` has had no commit since 2026-10-20 and `.context/plan.md` says it "keeps xcodegen until it retires".
  It is the only build and XCTest run of `packages/macos` (the WebView shell, with daemon-binary and web-provider integration tests); the native workflow builds a different app.
  Of 13 failures, 3 sampled were real code failures (Swift concurrency compile errors in 37375383003 and 37526463909, an assertion in `NativeAPNsEnvironmentTests` in 39398018055), not runner flakes.
- Options: (a) delete `macos-app.yml` with its `macos` scope gate; loses nothing relative to today and ends the 9.6 to 13.2 minute scope job before a cancelled build; (b) move to a supported image (`macos-15` or the `xcode-27` image); restores coverage at 2 to 5 macOS minutes per triggering PR, but the project last built with Xcode 15.4 and may need fixes on a newer Xcode (not tried); (c) fold it into `native-app.yml` as a path-filtered job.
- Recommendation: (a) if the WebView shell no longer ships; otherwise (b).

### B3. Skip the second full CI run on the bot's stable bump on main

- Change: in `ci.yml`, skip the scope and test jobs for a push to `main` whose head commit is the bot's `chore: bump version to X.Y.Z` (run 40603200488 took 26.9; its Auto Release skipped "Strip dev suffix and release" and its Release Guard repeated the first run's check).
  A `[skip ci]` marker is not usable here: `scripts/bump-version.sh` pushes the commit and then the tag `vX.Y.Z` with the same head commit, so the marker would also suppress `release.yml`.
- Coverage lost: the suite on a tree that differs from the tested merge only in version strings; `release.yml` still smoke-tests the compiled binaries.
- Recommendation: yes, low priority (no one waits on that run).

### B4. Release-PR churn

- Each merge to `develop` restarts the release PR's 65 to 77 minutes of checks (two pushes per merge).
- Option: hold merges to `develop` while the release PR's checks run, or run the soak once by dispatch on the frozen release head; this is process, not workflow.
- Recommendation: decide together with B1.

### B5. Run the native Release builds and archive only on release paths

- Coverage lost: Release-only compile failures (optimizer, `#if DEBUG` paths, the x86_64 slice) and packaging regressions would surface at release time.
- Saving after A2 and A3: about 0 minutes of wall-clock (the builds job, about 9.6, is shorter than the tests job), about 5.6 macOS minutes of compute.
- Recommendation: no.

## Cannot be measured or not verified

- Billing: no billing data is readable; "not billed" rests on the repository being public and GitHub's documented rules.
- Concurrency limits for this organization (GitHub documents 20 jobs and 5 macOS jobs for the free plan); no API exposes them, and observed queue times were near zero.
- Whether `check-ci-scope.py` speeds up in a process pool (CPU-bound versus Git-subprocess-bound) was not profiled.
- Whether splitting the daemon cohort (A5) changes test outcomes is unknown until hosted runs.
- Whether the archive compiles every target of the separate Release device build (A3) is inferred from `scripts/testflight-ios.sh`, not diffed.
- Whether `packages/macos` builds on a supported image (B2b) was not tried.
- Root causes of the native flakes and of the 6 Bun worker failures in the window were not investigated.
- The share of the 5 normally classified soak heads that touched relay-transport files (B1b) was not classified.
- The `PR Preview` workflow (id 248856824) is still registered as active, but `pr-preview.yml` is not on `develop` and its last runs are from 2026-03-20; not investigated.

## Suggested order of small PRs

Each workflow-changing PR itself triggers the validator and, through the `.github/` branch of the classifier, may run every gate including the soak, so expect 65 to 77 minutes of checks per push for those PRs.

1. A1 (classifier, native fixtures and `native-app.yml`). Before: replay the 11 heads, record outputs; after: replay again and watch the next 5 fixture PRs.
2. A2 and A3 (native split, drop duplicate). Before: median 21.8 (n=30); after: median of 10 runs, target at most 13 (A2) and 10.5 (A2 and A3).
3. A7 (flake issues, no workflow change). Before: 14 failures in 48 attempts; after: fewer than 1 in 20 on unchanged commits.
4. B2 (macOS App decision), before A4 so A4 touches two scope jobs, not three.
5. A4 (validator in parallel). Before: CI 28.0 and relay 76.7 on release PR head fbd2841d; after: the next validator-input PR, CI at most 16.
6. A6 (timeouts), alone, so a failure is easy to attribute.
7. B1 with its ADR 0048 amendment, then A5 (shards), whose value depends on B1. Before: worker medians 14.4, 4.9, 0.2; after: slowest worker at most 6.
8. B3 and, only if B1 is rejected, A8.

## Suggested PR body

The text below keeps each paragraph on one line for GitHub.

Title: `docs: CI optimization analysis for #1793`

Measured analysis of the remi CI workflows and a proposal split into pure speedups (Proposal A) and coverage trade-offs that need the owner's decision (Proposal B). No workflow file changes in this PR.

Top findings: the 61-minute relay soak is the critical path of every code PR (median check time 64.8 minutes over 23 heads); 11 of those 23 were native-only PRs pulled into every gate by a classifier fallback; the native job doubled to a 21.8-minute median since 2026-11-13 and failed 14 of 48 attempts; the scope validator adds a 12-minute serial prefix on release PRs and main pushes; Bun test worker 1 takes 14.4 minutes while the others take 4.9 and 0.2.

The macOS App job was not cancelled by concurrency: its `macos-14` runner configuration is no longer supported, so it has not run since 2026-10-21.

All numbers come from read-only `gh run list` and `gh api` calls listed in the file; nothing was rerun or dispatched. Part of #1793.
