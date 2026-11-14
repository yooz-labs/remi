# Card F1768: reproduce and fix the LocalAuthentication invalidation crash under concurrent Keychain reads (issue #1768)

Status: ready
Tier: worker-hard
Timebox: L, 8 hours; escalate at 1 day or when no hypothesis survives two experiments
Needs: xcode
Depends: none (PR #1766, the investigation, may merge before or after; its evidence is the starting point)
Branch: `fix/issue-1768-lacontext-race` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/lacontext-race` (the manager creates it with `git worktree add -b`, then `bun install`)
Plan: issue #1768 and issue #1634 (read both and their comments first), the evidence in `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/F1634b/r1/` (`investigation.md`, `local-crash-sanitized.json`, `auth-crash-sanitized.json`, the count files)

## Goal

A deterministic or high-rate reproduction of the `EXC_BAD_ACCESS` in LocalAuthentication's `LAClient` invalidation (on the `la_client` queue, in `objc_release`) under concurrent `NativePushKeyStore.read(query:)` and `NativeIdentityRecordStore.read(query:)` calls; a measured before and after of the smallest change that removes it; and that change, if it is proven, with its tests and a security review. If no reproduction can be found, an honest report of the experiments, with a diagnostic that captures the next hosted crash.

## Context

- Both stores create a fresh `LAContext()` per Keychain read, set `interactionNotAllowed = true`, and pass it as `kSecUseAuthenticationContext` to `SecItemCopyMatching`: `packages/native/RemiKit/Sources/RemiPush/NativePushKeyStore.swift` line 62 and `packages/native/RemiKit/Sources/RemiKit/Identity/NativeIdentityRecordStore.swift` line 223 (verify the lines).
- Two local crashes (macOS 27.2, Xcode 27.2): a full-package parallel run after 94 passes and the four authentication suites under load after 51 passes; both with the same exception `EXC_BAD_ACCESS` at `0x400000000000bad0` on the `la_client` queue, with other threads inside the stores' read functions. The hosted crashes have no captured stack: do not claim they are the same until a hosted stack shows it.
- Hypotheses to test, in this order (do not assume): (A) many short-lived `LAContext` objects released concurrently race inside LocalAuthentication invalidation; (B) a single long-lived `LAContext` per store instance (created once, reused, never invalidated by us) avoids the race; (C) serializing the creation and release of contexts on one serial queue avoids it; (D) not passing an `LAContext` (relying on the item's own access control and the `interactionNotAllowed` behavior another way) changes behavior, which must be ruled out for security reasons before it is considered.
- Security constraints (non-negotiable): the reads stay non-interactive (no prompt, ever); no access control is widened or removed; error mapping (`errSecItemNotFound` to nil, other statuses to errors) is unchanged; no secret is logged, printed or stored in a test artifact; the production change, if any, is the smallest one the experiments prove.
- Tools: a stress test that calls both stores' reads from many concurrent tasks in a loop (use test-only service and account names and clean up the Keychain items afterwards; if the macOS test environment cannot reach the Keychain without prompts, use the stores' existing test seams such as `operations`); `swift test --sanitize=thread` and `--sanitize=address`; repeated runs of the whole package in parallel and under CPU load (four `yes > /dev/null` processes of your own, removed afterwards); crash reports under `~/Library/Logs/DiagnosticReports`; `lldb` if useful.
- Run Swift under the xcode lock. No simulator, no app launch.

## Scope

May change: `packages/native/RemiKit/Sources/RemiPush/NativePushKeyStore.swift` and `packages/native/RemiKit/Sources/RemiKit/Identity/NativeIdentityRecordStore.swift` (only the context handling, only if an experiment proves the change), a new small shared helper file in the same package if two stores need the same context handling, new stress tests under `packages/native/RemiKit/Tests/RemiKitTests/`, evidence under the artifacts folder, the PR body.
No other production code, no CI workflow, no weakened or disabled test.

## Decided design

Settled: first build the reproduction and measure the crash rate with run counts (the baseline, at least 200 stress iterations in several configurations); then try the hypotheses in order, each with its measured rate and the same configurations; keep a table of experiment, configuration, runs, crashes. Change production code only for a hypothesis whose before and after rates differ clearly (state the counts) and keep the stress test in the suite if it is fast and stable (under 10 seconds), otherwise mark it as an opt-in diagnostic that is excluded from the default run by a documented environment variable (never disabled silently).
The worker may choose: the stress harness shape and the hypothesis order within the constraint above.

Never do: add retries that hide a crash; serialize or disable the existing tests to make the crash disappear without a proven cause; change entitlements, access control or the keychain item attributes; log secrets.

## Acceptance

1. The PR body has the experiment table (experiment, configuration, runs, crashes) and says plainly which hypothesis the data supports, which it rules out and what stays unknown, with the local-only artifact paths flagged as local.
2. Either a reproduction plus a minimal production change with a before and after (rates and counts) and tests, or "not reproduced" with the experiments listed and a diagnostic.
3. The security review section of the PR body states, for each changed line, why the reads remain non-interactive, why access is not widened and that the error mapping is unchanged.
4. The full `swift test --skip PairingAttemptTests --skip PairingSourceTests` passes; the diff touches only the scoped files; the PR says "Addresses #1768" (never a closing keyword) and notes the Feedback Assistant report to Apple with the two crash reports as an owner action.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree.

## Stop conditions

The only change that removes the crash alters access control or entitlements (stop and report); the crash reproduces only in Apple's code with no Remi-controlled variable that changes its rate (report that with the experiments); two hours with no new information (report and ask).

## Report

The preamble's report, plus the experiment table, the before and after rates and the PR number.
