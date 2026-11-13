# Card L06: reset the native relay retry budget after an admitted episode (#1731)

Status: ready
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: xcode
Depends: L03
Branch: patch/issue-1731-idle-recovery (no PR yet; head `ea7064fd` on 2026-11-12)
Worktree: `/Volumes/S1/worktrees/remi/native-idle-recovery` (exists, clean)
Plan: plan.md section 2, L06; Q3 approved by the owner on 2026-11-12

## Goal

The narrow fix in `ea7064fd` lands with the negative controls its approved phase plan requires: five interrupted admitted relay episodes on one actor all recover, while pre-Hello losses, malformed authenticated payloads, wrong machine or pin, and enrollment refusal stay bounded or terminal exactly as before.

## Context

- The decided plan: `/Volumes/S1/yooz/remi/artifacts/issue-1731-idle-recovery-20261031/fix-phase-plan.md` (read it first, in full), with `negative-controls-plan.md` and `negative-controls-receipt.md` in the same folder.
- `ea7064fd` ("wip: reset relay retry budget after an admitted episode") is byte-for-byte the plan's `approved-fix-candidate.patch`; its focused run (`approved-fix-focused-first.log`, exit 0) passed 5 tests in `RelayIdleRecoverySourceTests`.
- The four earlier commits are tests: retry episodes, stale relay origins, ready-only retries, one-shot limits.
- The wip commit's subject stays in history (pushed; never rewrite it); later commits use normal subjects.
- Security path: relay authentication and retry classification; contested review findings go to the advisor.
- L03 (#1728) merges first and also edits `RemiConnection.swift`; `git merge-tree` showed a clean merge on 2026-11-12.

## Scope

May change: `packages/native/RemiKit/Sources/RemiKit/Transport/RemiConnection.swift` (only the reset logic of `ea7064fd` and what the plan's controls force), `packages/native/RemiKit/Tests/Integration/liveness-relay-fixture.ts`, `packages/native/RemiKit/Tests/RemiKitTests/RelayIdleRecoverySourceTests.swift`; the merge commit from `origin/develop`.
Everything else is out of scope: no new ping, frame, timer, payload, UI, preference or authentication behavior; no replay of chat, answers or session requests; no idle-liveness feature (later work in #1731).

## Decided design

Settled: the reset rule of `ea7064fd` (reset the consecutive attempt counter only after a fully admitted application relay episode: `relayPin != nil && applicationHello && ready && applicationAdmitted && relayChannel != nil && socket != nil`, captured before `closeSocket()`; `!relayEnrolled` and `RelayFailure` stay terminal; the displayed retry attempt is at least 1).
The implementer may choose: the fixture mechanics for the controls, inside the plan's limits.

## Acceptance

Each control from the plan's "Test-first checks" is a test in `RelayIdleRecoverySourceTests` that runs against the real local Worker and source HubRelay:
1. five admitted-then-interrupted episodes on one actor reach five new authenticated Hellos;
2. pre-Hello loss after READY: from an admitted episode, five later failed attempts reach the terminal cap with no Hello; cold start stays bounded;
3. an authenticated malformed payload after Hello rejects once, with no next connecting transition, even after an earlier admitted episode;
4. a wrong machine or pin and an enrollment refusal are terminal (classified, not a timeout);
5. an orderly authenticated BYE after a Hello takes the normal return path and resets the budget.
Then two mutation checks in a scratch copy only (never committed): removing the reset brings back the fifth-loss rejection; collapsing READY-vs-Hello makes control 2 fail.
Run: `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RelayIdleRecoverySourceTests`, log to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L06/r1/focused.log`; quote the summary line and both mutation outcomes.
Open a PR into `develop` ("Part of #1731"; the issue's idle-liveness investigation stays open), draft until the gates pass.

## Gates

After `git merge origin/develop`: `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit`; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock timeout 2700 xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac -destination 'platform=macOS' -derivedDataPath /Volumes/S1/derived/remi-native-idle-recovery -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build test` (a stall is handled per the Q2 answer in the live facts); `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone -destination 'generic/platform=iOS Simulator' -derivedDataPath /Volumes/S1/derived/remi-native-idle-recovery -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build`; `bunx biome check packages/native/RemiKit/Tests/Integration/liveness-relay-fixture.ts`; `typos`.

## Stop conditions

Any control shows a terminal failure becoming retryable; a control needs a change to production code beyond the reset logic; the develop merge conflicts in `RemiConnection.swift`; two failed attempts to build a control against the real Worker.

## Report

The preamble's report, plus one line per control (pass, with test name) and the two mutation outcomes.
