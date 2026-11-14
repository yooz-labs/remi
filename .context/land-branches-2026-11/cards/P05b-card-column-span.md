# Card P05b: a card can span several columns (issue #1763, part 2)

Status: ready
Tier: worker
Timebox: L, 8 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: P05a merged (corner handles, `RemiBoardCardResize`, `cornerResize` extras)
Branch: `feature/issue-1763-card-span` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/board-span` (the manager creates it with `git worktree add -b`, then `bun install`)
Plan: issue #1763 (read it), `packages/native/handoff/ipad-board.md` "Placement" and "Resizing"; P05a's code and tests are the model

## Goal

At two or more Board columns, dragging a card's right-corner handle sideways makes the card span two or more adjacent columns (snapping to column boundaries), the span is stored with the card, placement and layout handle spanning cards, and a span is ignored at one column and clamped when the column count drops; the Mac and the one-column phone are unchanged.

## Context

- Today: `RemiBoardColumns.place(_:columnCount:heights:)` packs items into columns by shortest height; `RemiBoardColumnsLayout` (a SwiftUI `Layout`) takes `columns: [[Int]]` (subview indices per column) and positions subviews at `columnWidth`; P05a added the corner handles and the pure `RemiBoardCardResize` mapping (vertical drag steps the size); `RemiBoardState` stores `sizes` per key (additive, old boards decode).
- Spanning needs placements that occupy several columns, so the layout's input changes from per-column lists to per-card placements. This is a deliberate refactor of P02a/P02b/P03 code; keep every existing test's intent (update the call shapes, never delete an assertion).
- No simulator, no app launch, no Xcode MCP in this card. The manager renders previews after your push.

## Scope

May change: `packages/native/RemiKit/Sources/RemiUI/RemiBoard.swift` (additive: `spans` in `RemiBoardState`); `packages/native/RemiKit/Sources/RemiUI/RemiBoardColumns.swift`; `packages/native/RemiKit/Sources/RemiUI/RemiBoardColumnsLayout.swift`; `packages/native/RemiKit/Sources/RemiUI/RemiBoardCardResize.swift`; `packages/native/RemiKit/Sources/RemiUI/BoardTile.swift` (additive: horizontal drag and the Widen and Narrow actions on the existing handle); `packages/native/iPhone/PhoneBoardScreen.swift`; the matching tests under `packages/native/RemiKit/Tests/RemiKitTests/` (existing files may be updated for new call shapes, new file `RemiBoardSpanTests.swift` allowed); one sentence each in `packages/native/handoff/ipad-board.md` under "Placement" and "Resizing"; the PR body.
No other file.

## Decided design

Settled:
1. `RemiBoardState` gains `span(for:) -> Int` (1 when none), `setSpan(_:for:)`, `explicitSpan(for:) -> Int?`, `clearSpans()` and `hasExplicitSpans`, stored additively next to `sizes` (an old stored board decodes unchanged; a stored span below 1 decodes as absent). "Reset card sizes" also clears spans (rename its title to "Reset card sizes and widths" if the label is shared).
2. Pure placement with spans in `RemiBoardColumns` (one function, one result type): items in reading order, each with a span clamped to 1 through `columnCount` and a height; a card of span `s` goes in the window of `s` adjacent columns whose tallest column is lowest (ties to the leftmost window) and starts at that height; every covered column's running height becomes start plus the card height plus the 12 pt gap. The result is a list of placements (item index, first column, span). With every span 1 it must equal what `place` returns today (keep the old `place` as a thin wrapper or prove equality with a test table), so the P03 tables stay valid.
3. `RemiBoardColumnsLayout` takes the placements (first column and span per subview index) instead of `[[Int]]`; its pure `frames` function lays out spanning cards at width `span * columnWidth + (span - 1) * spacing` and y equal to the maximum running height over the covered columns; unassigned subviews keep a zero frame, out-of-range indices are ignored (as today). Update the tests to the new shape and add spanning tables.
4. Gesture: extend the pure mapping in `RemiBoardCardResize` with a horizontal part: from the start span, the horizontal translation in points, the column pitch (`columnWidth + spacing`) and the column count, return the span whose width is nearest the dragged width (`startWidth + translation`), clamped to 1 through the column count; the vertical part stays as P05a made it, both can change in one drag. A nonfinite translation keeps the start values.
5. Screen: at two or more columns the stored span of each card (default 1, clamped to the current column count for display only; the stored value is kept so unfolding restores it) feeds `place`; the drag updates the displayed span live as it steps and stores it on drag end like the size; a cancelled drag restores both; at one column spans are ignored and no handle exists (as today).
6. Accessibility and keyboard: the handle's actions Widen and Narrow step the span by one; the existing Make larger and Make smaller step the size; arrow keys Left and Right step the span, Up and Down the size; VoiceOver announces the new width as "N columns wide".
7. The card's width at a span never exceeds what the columns give; a spanning card is centered with the group like any other (the group is as wide as all columns).
The worker may choose: names, the result type of the placement function.

Never do: change the Mac Board or the one-column phone; store a span clamped by the current column count (store what the person chose); change the sizes' storage format.

## Acceptance

1. Literal tables pin: spans all 1 equal today's `place` results (reuse the P03 tables); a span-2 card in a 3-column board lands in the lowest window of two adjacent columns (write out at least four cases including ties and a span equal to the column count); span larger than the column count clamps; span with an empty list; heights shorter than items (missing heights use the regular phone height as today); the layout frames for spanning cards (x, y, width, height literals); storage: old board decodes, span round trip, span below 1 ignored, `clearSpans`.
2. The pure drag mapping tables: horizontal translations around each midpoint between spans for 2, 3 and 4 columns (literal boundary values), combined with vertical, nonfinite, extremes.
3. Reading the source: the one-column path and the Mac tile are untouched; the stored span is not clamped on write; a cancelled drag restores.
4. The build script ends with a receipt for the final head, no simulator.
5. The PR body states what changed, which test covers each acceptance item, what is untested (the gesture wiring), and that no visual run was done by the worker.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoard` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected FINAL_HEAD --receipt-dir /Volumes/S1/derived/remi-board-span-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree.

## Stop conditions

Spanning cannot be done inside `RemiBoardColumnsLayout` without per-column containers (stop, say why; do not fall back to per-column stacks, they rebuild tiles); a change would alter what the Mac draws; a test outside the scoped files fails.

## Report

The preamble's report, plus one line per acceptance item with the test or command that covers it and the receipt path.
