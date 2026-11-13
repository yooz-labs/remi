# Card L03: direct child key (#1724, PR #1728)

Status: ready
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: xcode
Depends: none
Branch: patch/issue-1724-direct-child-key (PR #1728, draft, head `5c1f9380` on 2026-11-12)
Worktree: `/Volumes/S1/worktrees/remi/direct-child-key` (exists, clean)
Plan: plan.md section 2, L03; risks R2, R3

## Goal

PR #1728 is ready for review: its Mac test gate is settled per the owner's Q2 answer, its body names the scratch evidence branches, and every hosted check is green on its final head.

## Context

- Security path: binds a native child connection to its authenticated parent's full machine key and fences child signing to the parent socket and profile (`Transport/RemiConnection.swift`, `Store/MachineStore.swift`, `Store/PairingAttemptCoordinator.swift`, `Discovery/MachineRecovery*.swift`, tests).
- On 2026-11-12 every hosted check on `5c1f9380` was green, including `Build and Test (Native)` (11m38s) and `local-relay` (1h4m31s); the branch was 0 commits behind `develop` at `1cbdcc6f`.
- The body says the local Mac `xcodebuild ... test` runner stalled before loading a test bundle and calls that gate "unpassed"; its logs are in `/Volumes/S1/yooz/remi/artifacts/issue-1724-child-key-20261030/board-integrated-af0/`.
- Hosted native CI runs `swift test` and `xcodebuild build`, not `xcodebuild test` (see `.github/workflows/native-app.yml`); the `RemiMac` scheme's only testable is `RemiKitTests`, the same target `swift test` runs.
- Scratch evidence branches: `scratch/issue-1724-hosted-scheduler-af0` (tree identical to `5c1f9380`), `scratch/issue-1724-1724-fence-diagnostic` and `scratch/issue-1724-1724-hosted-diagnostic` (one wip diagnostics commit each). They are evidence, never merged.
- The owner's Q2 answer is in the live facts.

## Scope

May change: the branch, only through a develop merge if `develop` moved and conflicts, and fix commits from review rounds inside the PR's 12 files; the PR body (extend it).
Everything else is out of scope.

## Decided design

Settled: the PR's design stands (two earlier review rounds are recorded in the body and as run logs under the artifacts folder; the review form after this card follows Q13); no change to trust, route or relay behavior; the scratch branches are named in the body as evidence and not merged.
The implementer may choose: nothing in production code in this card; fixes come only from decided findings.

## Acceptance

1. `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit` passes on the head (quote the summary line).
2. One bounded Mac test attempt: `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock timeout 2700 xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac -destination 'platform=macOS' -derivedDataPath /Volumes/S1/derived/remi-direct-child-key -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build test`, log to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L03/r1/mac-test.log`.
   Pass, or (Q2 answer "bounded attempt, then hosted") a timeout or a stall before a test bundle loads, recorded with the log path; with Q2 "require local", a stall is a stop condition.
3. `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone -destination 'generic/platform=iOS Simulator' -derivedDataPath /Volumes/S1/derived/remi-direct-child-key -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build` succeeds.
4. The PR body gains one paragraph with: the result of steps 1 to 3 at the head hash, the Q2 basis for the Mac gate, and the three scratch branches with what each holds.
5. `gh pr checks 1728` shows every required check (runbook "Merge gate") passing on the final head.
6. The hosted native log on the final head shows the pairing suite ran and passed: `gh run view RUN_ID --log | grep -c 'PairingAttemptTests.*passed'` prints at least 1 (RUN_ID is the `Build and Test (Native)` run of the final head); quote the matching line.

## Gates

The three commands above, plus `typos` and `git diff --check origin/develop...HEAD`.

## Stop conditions

`swift test` fails in a test this PR touches (other than the known `PairingAttemptTests` baseline); Q2 is "require local" and the Mac test stalls; a develop merge conflicts in `RemiConnection.swift` or `MachineStore.swift` (report, do not resolve); any need to change trust or authentication behavior.

## Report

The preamble's report, plus the Mac test outcome (pass, timeout, stall) and the log path.
