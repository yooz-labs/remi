# Card L04: scope native question identity to its session (#1732)

Status: ready
Tier: worker
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: xcode
Depends: none
Branch: patch/issue-1732-question-session-identity (no PR yet; head `9727af7c` on 2026-11-12, 0 behind develop)
Worktree: `/Volumes/S1/worktrees/remi/question-session-identity` (exists, clean)
Plan: plan.md section 2, L04; prerequisite of L07

## Goal

The native Store keeps two questions that share a `question.id` but belong to different sessions, answers address a question by machine, session and question id, and the three test-first tests on the branch pass; one PR into `develop`.

## Context

- Read issue #1732 in full (`gh issue view 1732`): it is the decided plan for this card.
- The branch holds tests only: `e6cca52e` (`ChildRouteOriginTests.consolidationKeepsSameQuestionIDFromDifferentSessions`, `SessionAddressingTests.sameQuestionIDInDifferentSessionsDoesNotReplaceAnotherCard`) and `9727af7c` (`SessionAddressingTests.questionLookupRequiresExactSessionAndMachine`, which calls `question(sessionID:questionID:)` on a machine state; nothing defines it yet, so the test target does not compile).
- Current defect site: `MachineStore.swift` `.question` handling removes every question with the same `question.id` before inserting (about line 2667 on develop `1cbdcc6f`); route consolidation deduplicates questions too (about lines 2878 and 2935).
- Call sites that look up a question by id only: `iPhone/PhoneLiveRootView.swift` (about lines 873 to 878), `Mac/MacLiveRootView.swift` (about line 1189). The Mac Board's lookup is already scoped (keep it).
- Test-first evidence from the issue: `store-session-collision-first.log` in the #1720 artifacts.

## Scope

May change: `packages/native/RemiKit/Sources/RemiKit/Store/MachineStore.swift` (and the file that defines the machine state type, if different), `packages/native/iPhone/PhoneLiveRootView.swift`, `packages/native/Mac/MacLiveRootView.swift`, the two test files on the branch.
Everything else is out of scope, including answer wire formats, retry, relay, notification policy, and the local-notification delegate control the issue's last paragraph mentions (that belongs to #1720 and #1727).

## Decided design

Settled (from #1732):
- `.question` upsert matches on `sessionId` and `question.id` within the already-selected machine; the same pair updates in place; a different session keeps its own entry.
- Resolution and snapshot handling keep their existing exact session-and-id semantics.
- Route consolidation keeps both questions of a same-id, different-session pair and deduplicates only an identical `(sessionId, question.id)` pair.
- One machine-state lookup `question(sessionID:questionID:)` returning the exact entry or nil; the iPhone answer, submit and cancel paths and the Mac session-detail answer, submit and cancel paths pass the actual session.
- The helper exposes data only; it adds no trust or authority.
The implementer may choose: the helper's internal implementation and where the type extension lives inside Scope.

## Acceptance

1. Before the fix, record the test-first state: `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter 'SessionAddressingTests|ChildRouteOriginTests'` fails (compile refusal for the lookup, behavior failures for the other two); save the log to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L04/r1/before.log`.
2. After the fix, the same command passes; save `after.log`.
3. Revert check: with the upsert change reverted locally (not committed), `sameQuestionIDInDifferentSessionsDoesNotReplaceAnotherCard` fails; quote it.
4. A PR into `develop` ("Fixes #1732" only if both issue items are done), opened as draft, marked ready when the gates pass.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit`; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock timeout 2700 xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac -destination 'platform=macOS' -derivedDataPath /Volumes/S1/derived/remi-question-session-identity -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build test` (a stall is handled per the Q2 answer in the live facts); `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone -destination 'generic/platform=iOS Simulator' -derivedDataPath /Volumes/S1/derived/remi-question-session-identity -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build`; `typos`.

## Stop conditions

The fix needs a wire or protocol change; any file outside Scope must change; an existing answer test changes meaning; two failed approaches at making the consolidation test pass.

## Report

The preamble's report, plus the before and after log paths and the revert check.
