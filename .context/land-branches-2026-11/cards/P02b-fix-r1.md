# Card P02b-fix-r1: review round-1 fixes for PR #1756

Status: ready
Tier: worker
Timebox: M, 4 hours; escalate at 1 day
Needs: xcode
Depends: P02b (PR #1756, head `591eb57c`, three Sonnet round-1 reviews in)
Branch: `feature/issue-1745-board-columns-view` (the PR's own branch; commits on it, one push)
Worktree: `/Volumes/S1/worktrees/remi/board-columns-view` (exists)
Plan: `packages/native/handoff/ipad-board.md`, "Placement" and "Fold, unfold, Split View, external display"

## Goal

Every accepted round-1 finding is fixed on the PR branch in one push: at two or more columns the tiles live in one flat tree that does not change when the column count or a card's column changes, the column state has one source of truth, the placement claims are honest, and the previews show filled columns; the one-column screen stays exactly as it is, and there is no third review round.

## Context

Three reviews (contract, verification, maintainability) found: (1) at two or more columns each column is its own `LazyVStack`, and `if columnCount == 1` switches between two trees, so a card that changes column or a 1-to-2 change rebuilds the tile (focus and tile-local `sending` state are lost); (2) `place` feeds one equal height for every card, so its result is round-robin for any height and the density test compares the code with itself; (3) `boardPaneWidth` and `columnCount` are two states resolved again in the body; (4) the previews hold at most two cards.
Read the design doc, `RemiBoardColumns.swift`, `PhoneBoardScreen.swift`, `BoardTile.swift` and the three review files in `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/P02b/r2/` first.

## Scope

May change: `packages/native/iPhone/PhoneBoardScreen.swift`; `packages/native/RemiKit/Sources/RemiUI/RemiBoardColumns.swift`; new `packages/native/RemiKit/Sources/RemiUI/RemiBoardColumnsLayout.swift`; `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardColumnsTests.swift`; new `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardColumnsLayoutTests.swift`; the PR body (extend it); one sentence each in `packages/native/handoff/ipad-board.md` under "Placement" and under "Fold, unfold, Split View, external display" (item 7).
No other file: not `BoardTile.swift`, not `PhoneLiveRootView.swift`, not the Mac.

## Decided design

Settled, in this order, as atomic commits where natural:
1. A pure, public layout in the new file: `public struct RemiBoardColumnsLayout: Layout` holding `columns: [[Int]]` (subview indices per column, in reading order inside a column), `columnWidth: CGFloat` and `spacing: CGFloat`. It proposes `columnWidth` to each subview, stacks each column's subviews top to bottom with `spacing` between them and puts the columns `columnWidth + spacing` apart; its own width is `columnCount * columnWidth + (columnCount - 1) * spacing` and its height is the tallest column. A subview index that no column names gets a zero-size frame; an out-of-range index is ignored. The frame arithmetic is a pure `public static func frames(columns: [[Int]], heights: [CGFloat], columnWidth: CGFloat, spacing: CGFloat) -> [CGRect]` that `placeSubviews` calls, so tests pin it without a view.
2. `PhoneBoardScreen` at two or more columns renders ONE flat `ForEach(ordered)` (each tile with `.id(RemiBoardOrder.key(for: session))`, in the list's own order, so accessibility and keyboard order follow reading order) as the children of `RemiBoardColumnsLayout`, whose `columns` come from `RemiBoardColumns.place` applied to `Array(ordered.indices)`, framed to `groupWidth` and centered (`frame(maxWidth: .infinity)`), inside the same outer container as today's header (`boardHeader`). No per-column stack, no `ForEach(columns.indices)`. Keep `.animation(RemiTheme.Motion.standard, value: order)` on the multi-column container so a reorder animates as at one column; nothing animates on a width change.
3. The one-column path stays literally as it is now (`singleColumnStack`, same LazyVStack, padding, readable column, animation, ids). The `columnCount == 1` branch between the two stacks stays; a 1-to-2 change still rebuilds the tiles, and that is recorded as a known limit (item 7) for slice 4, not fixed here.
4. One source of truth: replace `boardPaneWidth` and `columnCount` with a single `@State private var columnLayout = RemiBoardColumns.resolve(paneWidth: 0)`; the geometry callback sets `columnLayout = RemiBoardColumns.resolve(paneWidth: width, previousColumnCount: columnLayout.columnCount)` only when it differs from the current value (the struct is `Equatable`); the body branches on `columnLayout.columnCount == 1` and passes `columnLayout` to the multi-column stack; no second `resolve` in the body.
5. Placement honesty: `place` loses its `cardHeight` parameter (every card on the Board has the one selected density, so the heights are equal and the placement is reading-order round-robin); its doc comment says exactly that, that a count below 1 is treated as 1, that the result always has that many columns (empty ones included), that order inside a column follows the input, and that the 12 pt gap is the default of `RemiBoardOrder.columns`; remove the test `placeKeepsTheSameKeysAcrossColumnCountsAndUsesDensityEstimate` and its tautological `expected`. Replace it with literal tables (for example 5 items at 2 columns gives `[[a, c, e], [b, d]]`, at 3 columns `[[a, d], [b, e], [c]]`), `columnCount` 0 and -1 giving one column, empty input, more columns than items, and a test that two counts for the same ordered list hold the same set of items. Update the PR body to match (no density claim).
6. Layout tests (`RemiBoardColumnsLayoutTests`): `frames` for a literal two-column and three-column case with unequal heights (origins, widths, heights), one column, empty columns, an unassigned index (zero-size frame), an out-of-range index (ignored), `spacing` 12 between cards and columns, and that the group width formula equals `RemiBoardColumns.groupWidth` for the resolved layout at pane 1032 and at 1376.
7. Doc comments: on `singleColumnStack` (the pre-columns stack, kept unchanged for one column per the design), on `multipleColumnStack` (what it deliberately differs in: the full-width header and the centered group, no readable-column cap, one flat tile tree so a card moving between columns keeps its identity), on `boardHeader`, on `columnLayout`. In the design doc add one sentence under "Placement": with one density for every card the placement is reading-order round-robin and per-card heights would enter `RemiBoardOrder.columns` only when cards differ in height; and one under "Fold, unfold, Split View, external display": in this slice a change between one and two columns still rebuilds the tiles (the one-column stack is a different container), and slice 4 closes that with its focus-retention test.
8. Previews: `boardPreviewScreen` builds at least 7 live sessions (clone `RemiPreviewData.sessions` entries with unique ids as needed, in the preview only) so the 744, 1032 and 1376 previews show several rows per column; rename "Board, 1033 pt" to "Board, 1032 pt" and use `.frame(width: 1_032)`; the preview names say they are pane widths (for example "Board, 744 pt pane").
Not changing (rejected with reason): extracting the geometry callback into a helper and a source-pin test of the one-column stack, because with one `Equatable` state the callback is a single line over `resolve`, whose hysteresis is pinned by the existing tests, and a source test on the iPhone target is brittle; the manager checks the one-column diff and renders the previews itself.
The worker may choose: names of private helpers, how `Layout` caches measured heights.

Never do: put a column or the column index into a tile's identity; use `UIDevice`, idiom, orientation, size class or `UIScreen`; change the one-column code path; add a stored property outside `PhoneBoardScreen`'s `@State`.

## Acceptance

1. Items 1 to 8 are done; the tests named exist and pass; the removed test is gone.
2. At two or more columns the tiles are children of one `ForEach` over `ordered` (no per-column `ForEach` or stack), so a card changing column changes only its frame.
3. `columnLayout` is the only column state; the body has no `resolve` call.
4. The one-column diff against develop shows only the move into `singleColumnStack` plus `boardHeader`, as in the reviewed head.
5. The build script ends with a receipt for the final head.
6. The PR body states what changed in this round, the known limit (1-to-2 rebuild, slice 4), and that no visual run was done by the worker.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoardColumns` passes (both new and old suites); then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected <final head> --receipt-dir /Volumes/S1/derived/remi-board-columns-view-receipt` ends with `Receipt:` for that head (no `--simulator`; nothing is installed or launched); `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing.

## Stop conditions

A one-column change would be needed; `Layout` cannot hold the tile subviews without a per-column container (report why, do not fall back to per-column stacks); a test outside the scoped files fails.

## Report

The preamble's report, plus one line per item above with the commit that did it, the receipt path, and the final head after one push.
