# Card F1634: the ImageIngressSocketTests startup timeout flake on the hosted macOS runner (issue #1634, part 1)

Status: ready
Tier: worker
Timebox: M, 6 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: none (independent of the Board work; touches only test support code)
Branch: `fix/issue-1634-image-ingress-startup` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/flake-1634` (the manager creates it with `git worktree add -b`, then `bun install`)
Plan: issue #1634 (read it and its two comments first)

## Goal

`ImageIngressSocketTests` (for example `largeTranscriptStillPassesTheRealConnection`) stops failing with `Caught error: .startupTimedOut` on the hosted macOS runner, with the cause found and proven from the recorded failures, not guessed, and the suite shown stable under repeated and loaded runs.

## Context

- The failure has hit several unrelated PRs (#1736 head 1e4b18b4 run 43469101112, #1755 run 43543905820, #1761 run 43573777623) as `✘ Test largeTranscriptStillPassesTheRealConnection() recorded an issue at ImageIngressSocketTests.swift:46:6: Caught error: .startupTimedOut` after about 7 to 10 seconds, on the first test of the suite; it passes on rerun. Use `gh run view RUN --repo yooz-labs/remi --log` (add `--job` ids from `gh run view RUN --json jobs`) to read the step timings and the lines around the failure for each run; compare with a passing run of the same job.
- The tests start `OwnedAnswerPeer(mode: "image-ingress")` (a controlled synthetic peer) and wait for its port with `waitForPort()`; find where `.startupTimedOut` is thrown and what the deadline is, what the peer does to start (a child process? a Bun or Python script? a listener thread?), and what happens on a cold runner (first test of the suite pays process start, module load, TCP bind).
- The same file family has other flake notes in #1634 (a signal 11 in the test helper; `DirectConnectionDeadlineTests` timing): do not chase those here, only record in the PR what you saw.
- Test rules of the repo: no mocks that replace business logic; real sockets are fine; do not weaken what a test asserts.

## Scope

May change: the test support and test files that implement the peer start and wait (find them: `OwnedAnswerPeer`, `waitForPort`, the startup deadline and its caller in `ImageIngressSocketTests.swift`), under `packages/native/RemiKit/Tests/RemiKitTests/`; the PR body.
No production code under `packages/native/RemiKit/Sources`, no other tests' assertions, no CI workflow files.

## Decided design

Settled: first establish the root cause with evidence (the elapsed time to the first port in passing and failing runs, whether the deadline is a fixed number of seconds, whether the peer start is serialized behind something); then fix at the cause: a readiness wait that polls the real condition (the listener bound and accepting) with a generous bounded deadline measured from when the peer was asked to start, no sleep-based guesses, and the failure message naming what was not ready and how long it waited; if the cause is a cold start, warm it once per suite instead of per test only if that does not hide a real defect. The deadline may be raised if the evidence shows cold starts of that size, with the numbers in the PR body.
The worker may choose: the shape of the readiness check.

Never do: add retries that hide a failing assertion after startup; add `.disabled` or `.enabled(if:)` to skip the suite; reduce what the tests assert.

## Acceptance

1. The PR body states the root cause with the evidence (three failing runs and one passing run: timings and log excerpts, short), or states honestly that the cause could not be proven and what was ruled out, and what was changed to reduce the risk.
2. The fix is at the cause (item above); the failure message of a real startup failure says what was not ready and the time waited.
3. Local stress: the suite passes 30 times in a row (`for i in $(seq 1 30)`, each `swift test --filter ImageIngressSocketTests` under the xcode lock) and 10 more times while the machine is loaded (run `yes > /dev/null` on several cores or `stress`-like load in the background; remove it afterwards; use only your own process), with the pass count quoted.
4. The full `swift test --skip PairingAttemptTests --skip PairingSourceTests` passes; the diff touches only tests.
5. The PR body says "Addresses #1634" (never a closing keyword, the issue has other flakes) and what remains open in it.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter ImageIngressSocketTests` passes; then the full `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree.

## Stop conditions

The cause is in production code (stop and report what and where); the fix would need a CI workflow change (report it).

## Report

The preamble's report, plus the evidence summary (timings), the stress-run pass counts and the PR number.
