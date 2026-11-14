# Card P06: a card's state survives a layout change (slice 4 of #1745, issue #1757)

Status: ready
Tier: worker
Timebox: L, 8 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: P05b merged (PR #1767, card column span)
Branch: `feature/issue-1757-state-survives-layout` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/board-state` (the manager creates it with `git worktree add -b`, then `bun install`)
Plan: issue #1757 (read it), `packages/native/handoff/ipad-board.md` "Fold, unfold, Split View, external display" and slice 4

## Goal

When the Board changes layout (a fold or unfold, a rotation, a window resize that crosses the one-to-two-column boundary, a card moving between columns), a card's in-flight send, its failed-send notice and the person's focus in its composer survive, so a second Send cannot send the same text twice and the keyboard does not silently drop; the Mac and the one-column phone behave as today.

## Context

- At two or more columns the tiles live in one flat tree (`RemiBoardColumnsLayout`), so a card moving between columns keeps its identity; but the one-column stack and the multi-column container are different containers (`if columnLayout.columnCount == 1` in `PhoneBoardScreen.boardScroll`), so crossing between one and two columns rebuilds every tile. `BoardTile` keeps `sending`, `sendFailed`, `questionHeight` and some hover and focus flags as local `@State`; a rebuild resets them, while the draft (held by `PhoneBoardScreen.drafts`) survives: a send in flight shows `sending == false` with a non-empty draft, so a second Return or Send sends the same text again, and the failure footer is lost. See #1757 for the full description.
- Decided in review (owner and lead, 2026-11-13): keep the two containers (the one-column LazyVStack stays exactly as it is); fix the consequences instead: hoist the send state out of the tile, and put the focus back after a rebuild.
- The tile's draft and focus binding already live in the screen (`drafts`, `@FocusState focus`).
- No simulator, no app launch, no Xcode MCP in this card. The manager and the owner run the fold, unfold and window-resize checks later (a visible GUI run the owner announces); your job is the code and the pure rules, with tests, and an honest account of what is untested.

## Scope

May change: `packages/native/RemiKit/Sources/RemiUI/BoardTile.swift` (additive: an optional external send state with the old internal behavior as the default, so the Mac is unchanged); a new `packages/native/RemiKit/Sources/RemiUI/RemiBoardTileSendState.swift` (pure state and rules); `packages/native/iPhone/PhoneBoardScreen.swift`; new `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardTileSendStateTests.swift` and updates to the existing Board guard tests (never weakened); one sentence each in `packages/native/handoff/ipad-board.md` under "Fold, unfold, Split View, external display" (replace the "known limit" sentence with what now holds and what is not verified); the PR body.
No other file.

## Decided design

Settled:
1. A pure value type `RemiBoardTileSendState` (Equatable, Sendable: `isSending`, `failedMessage` or `sendFailed`) and a pure rule `canSend(draft:isLive:state:)` (not while sending; not for an empty or whitespace draft; only for a live session), moved out of the tile's private logic, with the tile using it; table-tested: a draft with `isSending` is refused, a failed state allows a retry, whitespace is refused, a dead session is refused.
2. `BoardTile` accepts an optional binding to the send state (default nil: it keeps its own `@State`, exactly as today, so the Mac and every other caller are unchanged); `PhoneBoardScreen` holds `[String: RemiBoardTileSendState]` keyed by the tile key and passes the binding per tile; the entry is pruned to live keys in `pruneBoard()` and cleared when a send finishes successfully.
3. The send task keeps writing to the keyed state (not to a view's `@State`), so a rebuilt tile shows the true state: an in-flight send still shows as sending after the rebuild, and a failure after the rebuild still shows "Not sent. Your text is still here." Make sure the async completion writes through the screen's dictionary by key and handles a key that no longer exists.
4. Focus: when the layout changes the container (the one-to-two or two-to-one change, tracked by an `onChange` of the resolved column count) and the key held in `focus` still has a working composer in the new layout, the screen reasserts `focus = key` after the new tile exists (a short cancelable task, as `focusNext` does with its 60 ms delay, using the same task handle pattern so two reassertions cannot race); if the focused card no longer has a composer (its effective size is Compact), `focus` is cleared as it is today. The rule is a pure function in RemiUI: `focusAfterLayoutChange(focusedKey:composerKeys:) -> String?`, table-tested (key still has a composer: kept; key gone or no composer: nil; nil in: nil).
5. Drafts, pins, sizes and spans are unchanged (already held by the screen or the board).
6. Source guards (the repo's `#filePath` style, sliced with `range(of:range:)` so a reorder cannot trap): the tile gets its send state from the screen's dictionary; the dictionary is pruned; the focus reassertion exists on the column-count change; the one-column stack is untouched.
7. The PR body states what survives now and what is not verified: the real focus and keyboard behavior across a fold, a rotation and a window resize (needs the owner-run GUI check), and the double-send case under a real slow send.
The worker may choose: names, where the reassertion task handle lives.

Never do: change the one-column container, the Mac tile behavior or the draft storage; store send state in `RemiBoardState` or any persistent storage (it is transient); weaken a guard.

## Acceptance

1. `RemiBoardTileSendStateTests` pin the send rule and the focus rule with literal tables; a test shows the external state wins over the internal default when provided, and that the default (nil) leaves the old behavior (a pure helper that chooses the source).
2. Reading the source: `BoardTile` without a binding behaves as before (the Mac and previews), the screen prunes the dictionary, the completion writes by key.
3. The build script ends with a receipt for the final head, no simulator.
4. The PR body lists what is untested and the owner-run checks needed: fold and unfold the Duo with a typed draft and a send in flight; rotate an iPad mini across 1000 pt; drag a window across the one-to-two-column width; a failed send across a rebuild.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoard` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected FINAL_HEAD --receipt-dir /Volumes/S1/derived/remi-board-state-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree.

## Stop conditions

Keeping the send state out of the tile needs a change to the Mac Board's use of `BoardTile`; the tile cannot take an external state without a public API break; a test outside the scoped files fails.

## Report

The preamble's report, plus one line per acceptance item with the test or command that covers it and the receipt path.
