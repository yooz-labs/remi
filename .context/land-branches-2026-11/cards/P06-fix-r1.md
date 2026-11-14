# Card P06-fix-r1: review round-1 fixes for PR #1770

Status: ready
Tier: worker
Timebox: M, 5 hours; escalate at 1 day
Needs: xcode
Depends: P06 (PR #1770, head `d93464af`, three Sonnet round-1 reviews in)
Branch: `feature/issue-1757-state-survives-layout` (the PR's own branch; commits on it, one push)
Worktree: `/Volumes/S1/worktrees/remi/board-state` (exists)
Plan: issue #1757, the P06 card

## Goal

Every accepted round-1 finding is fixed on the PR branch in one push: an in-flight send marker is never pruned while its draft is kept (the duplicate-send case this slice exists for), a late completion cannot resurrect an entry for a dead key, the dictionary rule is one pure tested function, the tile's setter routing and the resize-clearing guard are pinned, the retry keeps its failure notice as today on the Mac, and the design doc and comments say what ships. There is no third review round.

## Context

Read the three reviews in `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/P06/r2/` first (`contract.json`, `verification.json`, `maintainability.json`).

## Scope

May change: `packages/native/RemiKit/Sources/RemiUI/BoardTile.swift`; `packages/native/RemiKit/Sources/RemiUI/RemiBoardTileSendState.swift`; `packages/native/iPhone/PhoneBoardScreen.swift`; the tests `RemiBoardTileSendStateTests.swift`, `RemiBoardCardPresentationTests.swift`, `RemiBoardCardResizeTests.swift` under `packages/native/RemiKit/Tests/RemiKitTests/`; `packages/native/handoff/ipad-board.md`; the PR body.
No other file.

## Decided design

Settled, in this order:
1. Pruning: `pruneBoard()` prunes `tileSendStates` with `RemiBoardOrder.keeping(tileSendStates, live: live, settledMachines: settled)` exactly as drafts and interactions are, so an in-flight entry on a reconnecting machine survives; add `tileSendStates` to the doc comment of `pruneBoard`; a test pins that an `isSending` entry for an unsettled machine survives pruning and that a settled machine's missing key is dropped (use the existing `RemiBoardOrder.keeping` tests as the model; the test may exercise `keeping` with the send-state value type).
2. One pure dictionary rule in `RemiBoardTileSendState.swift` (a small public or internal enum of rules next to `canSend`): `storing(_ state: RemiBoardTileSendState, forKey key: String, in states: [String: RemiBoardTileSendState]) -> [String: RemiBoardTileSendState]`: a state with `isSending` is stored; a failed (`sendFailed`, not sending) state is stored only if an entry for the key already exists (a failure that arrives after the entry was pruned is ignored, so no resurrection); an idle state removes the entry. The screen's binding setter calls it and drops the guard on the captured `sessions` (that guard reads a stale copy and never drops anything); table-test with literals: sending for a new key stores; sending for an existing key replaces; failure with an existing entry stores; failure with no entry is ignored (dictionary unchanged); idle removes an existing entry; idle for an absent key leaves the dictionary unchanged; both flags true counts as sending (the rule "isSending wins" in the type doc).
3. Pin the tile's setter routing with source guards: `externalSendState.wrappedValue = newValue` when an external binding exists and `internalSendState = newValue` otherwise (slice with `range(of:range:)`, one short fragment each).
4. Restore the clearing guard: the focus-restore slice in `RemiBoardCardPresentationTests` asserts `cardResizeDrags = [:]` (and its position before the `focusAfterLayoutChange(` call) and `RemiBoardCardResizeTests` keeps its own assertion in the form the code now has (`columnLayoutDidChange()` plus the clearing line); also pin `focusBeforeColumnChange = nil` and the `resolved.columnCount != columnLayout.columnCount` condition in the geometry handler.
5. Retry keeps the failure notice as today: `send()` sets `RemiBoardTileSendState(isSending: true, sendFailed: sendState.sendFailed)` (the notice stays during a retry, on the Mac and on the phone); a row in the `canSend` table for the combined state (sending with a previous failure is refused); correct the PR body (the Mac behavior is unchanged and now pinned).
6. Docs: the type doc of `RemiBoardTileSendState` states the lifecycle (transient, in memory only, never persisted, owned by the tile or the containing screen, cleared by the next send, dropped with the session) and the rule that sending wins over a failure flag; `canSend` and `selectedSendState` become internal (tests use `@testable`) if nothing outside RemiUI calls them, otherwise documented; `focusTask` is documented as the single pending-focus handle shared by `focusNext` and `columnLayoutDidChange`, `focusBeforeColumnChange` as the focus captured immediately before `columnLayout` changes (with the ordering reason at the capture site: the `composerKeys` observer would clear it first), `columnLayoutDidChange` mentions its focus clear; the comment above `focusNext` mentions both writers.
7. Design doc (`ipad-board.md`): reconcile the section: replace "a column change only moves cards" with the true statement (it moves cards between columns, except between one and two columns where the one-column stack is replaced and the tile is rebuilt); name the pinned test on the "A test pins the first of these" line; reword the new sentence to "focus is reasserted 60 ms after the column count changes when that card still has a composer" and "send state survives by construction (it lives in the screen), not yet observed on a device"; amend the slice 4 row to what the PR ships (pure rules and source guards) and that the focus-retention and simulator-drag evidence is owed to the owner-run checks; add one sentence that a layout change cancels a pending next-card focus and reasserts the old one (rare, focus is not lost).
8. PR body: rewrite what changed in this round; "no assertion was removed" becomes the precise statement (the clearing guard was rewritten to the new handler and is now pinned again); the not-verified list stays.
Not changing (rejected with reason): changing the focus race between `focusNext` and the layout change in code (rare, no focus loss; documented instead).
The worker may choose: names of the rules enum and test names.

Never do: delete or invert an assertion; change the Mac or the one-column stack beyond item 5's preserved behavior.

## Acceptance

1. Items 1 to 8 are done; the named tests exist and pass under `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoard`.
2. A mutation check, each alone with its own log in the evidence folder `P06/r3`: pruning with the plain filter (the unsettled-machine test fails), the setter routing always internal, the failure-for-absent-key rule removed, the clearing line removed, `sendFailed` dropped at retry start; restore after each.
3. The build script ends with a receipt for the final head, no simulator.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoard` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected FINAL_HEAD --receipt-dir /Volumes/S1/derived/remi-board-state-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing.

## Stop conditions

The pure rule cannot express the late-completion case without a change outside the scoped files; a test outside the scoped files fails.

## Report

The preamble's report, plus one line per item above with the commit, the per-mutation log paths, and the final head after one push.
