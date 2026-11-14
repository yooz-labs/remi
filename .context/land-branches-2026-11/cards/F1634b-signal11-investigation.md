# Card F1634b: investigate the signal 11 in the native test helper (issue #1634, part 2)

Status: ready
Tier: worker-hard
Timebox: L, 8 hours; escalate at 1 day or when no hypothesis survives two experiments
Needs: xcode
Depends: none (independent of the Board work; touches tests only)
Branch: `fix/issue-1634-helper-signal-11` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/flake-1634b` (the manager creates it with `git worktree add -b`, then `bun install`)
Plan: issue #1634 (read it and all its comments first)

## Goal

Either find and fix the cause of the intermittent `swiftpm-testing-helper exited with unexpected signal code 11` in the hosted "Test shared native package" step, with a reproduction or a documented proof, or end with an honest report of what was reproduced, what was ruled out and what evidence a future occurrence must capture.

## Context

- Known occurrences (all unrelated to the PRs' diffs, all passed on a plain rerun): run 39890463511 (older, PR #1613 or #1631 era); run 43543905820 attempt 2 on PR #1755 (2026-11-14, hosted macOS, Xcode 27.1), where the log shows `QuestionNotificationSummarizerTests` finishing (including `timeoutDoesNotWaitForCancellationIgnoringGeneration` and `timeoutFallsBackWithoutWaitingForGeneration`) immediately before `error: Process '/Applications/Xcode_27.1.app/.../swiftpm-testing-helper ... exited with unexpected signal code 11`. Read both logs with `gh run view RUN --repo yooz-labs/remi --log` (and `--job` ids from `gh run view RUN --json jobs`), compare with a passing run of the same job, and list which tests were running concurrently when the helper died (Swift Testing runs suites in parallel; `@Suite(.serialized)` suites run their tests serially).
- Hypotheses worth testing first: a detached task or generation that ignores cancellation (the tests named `...IgnoringGeneration` start one on purpose) still running after its test ended and touching freed state or a deallocated test-local object; a real-socket test (`OwnedAnswerPeer`, `RemiConnection`, `NWListener`) tearing down while a callback fires on another queue; a stack overflow or deep recursion in a decoder with a large input (`ImageIngressSocketTests` sends frames larger than `WireJSON.maxFrameBytes`); memory pressure on the hosted runner. Do not assume; test.
- Tools: `swift test --sanitize=thread` and `--sanitize=address` on the suspect suites (run under the xcode lock; they are slower); repeated runs in a loop with the whole package under CPU load (four `yes > /dev/null` processes of your own, removed afterwards); `lldb`/crash reports under `~/Library/Logs/DiagnosticReports` for a local reproduction; running the suites with `--no-parallel` versus parallel to see whether the crash needs concurrency.
- Test-only scope: production code under `Sources` may be read and quoted in the report, but a production fix is out of scope; if the cause is in production code, stop and report it (the manager will route a fix).

## Scope

May change: files under `packages/native/RemiKit/Tests/RemiKitTests/` (test fixes or diagnostics, such as awaiting a cancelled task before the test ends), evidence under the artifacts folder, the PR body.
No production code, no CI workflow, no weakened or disabled test.

## Decided design

Settled: collect the evidence from the two failing runs first (tests started and finished around the crash, the exact helper command, runner image), write a ranked hypothesis list in the PR body, then run experiments in the order of cost: sanitizer runs of the suspect suites, 200 repeated runs of the suspect suites alone and in the full package (`--filter` loops), with and without CPU load, parallel and `--no-parallel`. Fix what an experiment proves (for example make a test await the cancelled task it spawned before returning). If nothing reproduces, add diagnostics that make the next hosted crash diagnosable without changing behavior (for example a test-only suite-level log line of what is running, or `--no-parallel` isolation proposal documented, not enabled), and say plainly that the cause is not found.
The worker may choose: which experiments to run and in which order.

Never do: disable a test or the suite; add retries that hide a failure; claim a cause without an experiment that shows it.

## Acceptance

1. The PR body contains the evidence table (both failing runs: the tests around the crash, the runner image, what was concurrent) and the ranked hypotheses with, for each, the experiment run and its result.
2. Either a proven cause with a test-side fix and a before and after experiment (the crash reproduced or the sanitizer report before; clean after, with run counts), or an explicit "not reproduced" statement listing the experiments with their run counts and what remains unknown, plus the diagnostics added.
3. The full `swift test --skip PairingAttemptTests --skip PairingSourceTests` passes; the diff touches only tests (and docs in the PR body).
4. The PR body says "Addresses #1634" and what remains open in it.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree.

## Stop conditions

The cause is in production code (stop and report file, line and the reproduction); a fix needs a CI workflow change (report it); two hours of experiments with no new information (report and ask for direction).

## Report

The preamble's report, plus the evidence table, the experiment list with run counts, and the PR number.
