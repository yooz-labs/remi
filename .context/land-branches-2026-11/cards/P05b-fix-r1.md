# Card P05b-fix-r1: review round-1 fixes for PR #1767

Status: ready
Tier: worker
Timebox: M, 5 hours; escalate at 1 day
Needs: xcode
Depends: P05b (PR #1767, head `66dd89ec`, three Sonnet round-1 reviews in)
Branch: `feature/issue-1763-card-span` (the PR's own branch; commits on it, one push)
Worktree: `/Volumes/S1/worktrees/remi/board-span` (exists)
Plan: issue #1763, the P05b card

## Goal

Every accepted round-1 finding is fixed on the PR branch in one push: no assertion that existed is gone or inverted, the placement and layout tests can fail for the core of the span feature, there is one placement algorithm, the drag claims its card on the first callback again, the VoiceOver text is grammatical, the revert evidence is isolated per mutation, and the docs and PR body say what the code does. There is no third review round.

## Context

Read the three reviews in `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/P05b/r2/` first (`contract.json`, `verification.json`, `maintainability.json`).
Origin of the dropped assertions: PR #1765's guards in `RemiBoardCardPresentationTests` and `RemiBoardCardResizeTests` (restore them; adapt only the string if the code legitimately changed, and say so in the PR body).

## Scope

May change: the files of the PR (`RemiBoard.swift`, `RemiBoardColumns.swift`, `RemiBoardColumnsLayout.swift`, `RemiBoardCardResize.swift`, `BoardTile.swift` under `packages/native/RemiKit/Sources/RemiUI/`; `packages/native/iPhone/PhoneBoardScreen.swift`; the tests `RemiBoardSpanTests.swift`, `RemiBoardColumnsLayoutTests.swift`, `RemiBoardCardPresentationTests.swift`, `RemiBoardCardResizeTests.swift`, `RemiBoardTests.swift`, `RemiBoardColumnsTests.swift` under `packages/native/RemiKit/Tests/RemiKitTests/`); `packages/native/handoff/ipad-board.md`; the PR body (rewrite the claims).
No other file.

## Decided design

Settled, in this order:
1. Restore the dropped guards: the `onChange(of: composerKeys)` focus-clearing assertions (`.onChange(of: composerKeys) { _, keys in` and `if let focusedKey = focus, !keys.contains(focusedKey) { focus = nil }`), and the picker-setter assertion `densityStorage = size.rawValue` (extend the slice so it includes that line); restore the drag claim in `updateCardResizePreview`: on the first callback of a drag the new `CardResizeDrag` is stored even when the mapped size and span equal the start (no board value is written; only `finishCardResize` writes, and only when size or span changed), with the original assertion `if activeDrag == nil { cardResizeDrags[key] = drag }` (not negated); a test pins the ownership semantics (a second corner is refused after the first callback).
2. Placement and layout tests that can fail for the core: add a literal table for columnCount 3, heights 40, 20, 72, 10, 10 and spans 1, 1, 1, 2, 1 expecting placements (index, first column, span) of (0, 0, 1), (1, 1, 1), (2, 2, 1), (3, 0, 2), (4, 0, 1) (columns stand at 52, 32, 84 before item 3; a first-column-height mutant picks the window of columns 1 and 2; item 4 lands in column 0 only if both covered columns were raised to 74); add the same placements to a layout frames case expecting y 52 for the span-2 card and y 74 for the follower; add at least one more case with a span-2 card in the middle windows (columns 1 and 2) and one with a follower under a span equal to the column count.
3. Nonfinite and invalid inputs for the horizontal mapping: `span(startingAt: 2, horizontalTranslation: .infinity` and `-.infinity, columnWidth: 100, spacing: 12, columnCount: 4)` give 2; calls with columnWidth 0, `.nan` and negative spacing give the clamped start; a 1-to-3 jump in one gesture has a literal boundary case.
4. `RemiBoardState.resetLayout` test: set a span before the reset and assert it is gone (`explicitSpan` nil, `hasExplicitSpans` false).
5. One placement algorithm: `RemiBoardColumns.placements` takes a `spacing` parameter (default `RemiBoardColumns.spacing`); `RemiBoardOrder.columns(heights:count:spacing:)` and `RemiBoardColumns.place` become thin wrappers over it (all spans 1, mapped to `[[Int]]`), with no second implementation; keep every existing test of both as parity tests, and add one test that the three agree on a table; their docs say which one the screen uses (`placements`).
6. Helpers instead of duplicated logic: add `isValid(columnCount:)` and `width(columnWidth:spacing:)` on `RemiBoardColumnPlacement` and use them in `frames`, `measuredHeights` and `RemiBoardCardResize.cardWidth`, so measure and place cannot use different widths.
7. VoiceOver text: `widthTitle` is "1 column wide" for span 1 and "N columns wide" otherwise; update the `BoardTile.swift` comment and pin both strings in a test.
8. Docs: units (points, columns, zero-based) on `RemiBoardColumnPlacement`, `Adjustment`, `placements` and `span(startingAt:...)`; `span` says the result is clamped to 1 through the column count and the caller decides what to store; `setSpan` says values below 1 clear the choice; the `onStep` comment says callers pass 0 for the axis they do not change; the `RemiBoardCardResize` type comment covers density and span; in `ipad-board.md` update the stale lines (state described as pins, sizes and spans; `RemiBoardColumns.placements` as the shared placement; the per-card menu still sets height; item 4 of "Selecting a session" no longer says placement extends `RemiBoardOrder.columns`).
9. Revert evidence: rerun each mutation ALONE (one log per mutation with its diff and the names of the failing tests, in the evidence folder): rightmost tie-break, first-column window height, first-column-only update after a span, pitch off by one, clamp on write instead of display, horizontal finite guard removed, `spanChanged` removed from the finish and save conditions, `spans.removeAll()` removed from `resetLayout`; restore the source after each and say so.
10. PR body: rewrite "Ships disabled" (spans are live at two or more columns); list what is not verified: the layout measurement at span width under real SwiftUI, runtime clamping on unfold, the 1-to-3 jump on a device, a right-to-left layout, and that there was no visual run; mention the restored assertions and the restored drag claim.
Not changing: placement uses nominal heights (the layout stacks from real heights, so a spanning card cannot overlap; the chosen window can be suboptimal), noted in the PR body.
The worker may choose: names.

Never do: delete or invert an assertion; weaken a guard; change the Mac Board or the one-column phone.

## Acceptance

1. Items 1 to 10 are done; the named tests exist and pass under `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoard`.
2. The diff of the test files against develop contains no removed assertion (the worker lists any assertion line whose text changed and why).
3. One placement algorithm: `RemiBoardOrder.columns` and `place` delegate to `placements`.
4. The build script ends with a receipt for the final head, no simulator.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoard` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected FINAL_HEAD --receipt-dir /Volumes/S1/derived/remi-board-span-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing.

## Stop conditions

Making the old wrappers delegate would change a Mac result (stop and report which test shows it); a test outside the scoped files fails.

## Report

The preamble's report, plus one line per item above with the commit, the per-mutation log paths, and the final head after one push.
