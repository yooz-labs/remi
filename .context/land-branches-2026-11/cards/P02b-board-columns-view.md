# Card P02b: the Board lays out in columns (slice 2a of #1745)

Status: ready
Tier: worker
Timebox: M, 6 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: P02a merged (PR #1755, the `RemiBoardColumns` resolver on `develop`)
Branch: `feature/issue-1745-board-columns-view` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/board-columns-view` (the manager creates it with `git worktree add -b`, then `bun install`)
Plan: `packages/native/handoff/ipad-board.md`, sections "The rule", "Placement", "Resizing", "Fold, unfold, Split View, external display", slice 2 (this card is the Board half; the shell's sidebar rule is P02c)

## Goal

`PhoneBoardScreen` lays its cards in the number of columns `RemiBoardColumns.resolve` gives for the width the Board was actually laid out in, one column stays today's screen exactly, and the focus, drafts, order freeze and "next live card" behavior are untouched; the shell is not changed here.

## Context

- Read the design doc first, then `RemiBoardColumns.swift` (slice 1), `RemiBoard.swift` (`RemiBoardOrder.columns(heights:count:spacing:)`, `RemiTileSize.estimatedHeight`) and `PhoneBoardScreen.swift` (`boardScroll`, `tile`, `content`).
- Today `boardScroll` is one `ScrollView` holding one `LazyVStack` (banners, machine problem rows, chips, then `ForEach(ordered)`), padded with `RemiTheme.Spacing.m` and `.remiReadableScrollColumn()`, with `.animation(..., value: order)`.
- The width comes from the pane, never from a device, an idiom, the orientation, a size class or `UIScreen`: measure it with `onGeometryChange(for: CGFloat.self)` on the scroll view (the width the Board was given). The pane width is what `RemiBoardColumns.resolve(paneWidth:)` takes; pass the previous resolved count as `previousColumnCount` so the 24 pt hysteresis works during a drag.
- Placement is by `RemiBoardOrder.columns(heights:count:)` with each card's density `estimatedHeight`, never by live content height, so the assignment depends only on the order and the density.
- No simulator, no app launch, no Xcode MCP in this card (the owner's rule: a simulator may hold the real hub). Visual checks are done by the manager with previews after your push.

## Scope

May change: `packages/native/iPhone/PhoneBoardScreen.swift`; `packages/native/RemiKit/Sources/RemiUI/RemiBoardColumns.swift` (additive only: one pure placement helper, see below); `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardColumnsTests.swift` and, if cleaner, one new test file next to it.
No other file: not `PhoneLiveRootView.swift`, not the Mac, not the project file, not the other RemiUI files.

## Decided design

Settled:
1. A pure helper in `RemiBoardColumns.swift`: `public static func place<Item>(_ items: [Item], columnCount: Int, cardHeight: CGFloat) -> [[Item]]` (or an equivalent name) that returns the items per column using `RemiBoardOrder.columns(heights:count:)`; for a count of 1 it returns `[items]`; for an empty list it returns `columnCount` empty columns; every item appears exactly once and the order inside a column is the order of the list.
2. `PhoneBoardScreen` keeps one vertical `ScrollView` and one `ScrollViewReader`. Above the columns (full pane width, as today): the error and notice banners, the machine problem rows, the chips and the empty state. Below them, with one column, the existing `LazyVStack` with the existing padding, `.remiReadableScrollColumn()` and animation, unchanged. With two or more, an `HStack(alignment: .top, spacing: RemiBoardColumns.spacing)` of `columnCount` `LazyVStack`s, each `cardWidth` wide, the group `groupWidth` wide and centered, with the page margin `RemiBoardColumns.margin`.
3. Card identity: `.id(RemiBoardOrder.key(for: session))` and `@FocusState` stay on the tile, so a column change only moves cards; the `@State` (board, drafts, interactions, focus, shownOrder) stays above the column layout and does not move into a column view.
4. The count is held in `@State` (`columnCount`), updated from the geometry callback with the previous value; at the first pass before any measurement there is one column (so the first frame is today's screen).
5. During a resize nothing animates except the column count change; the existing `.animation(..., value: order)` is kept for the one-column stack and is not applied across a column change. No new animation on every width tick.
6. Reading order and "next live card" use the single ordered list (`liveOrder`) exactly as today; `scrollTo(next, anchor: .center)` works across columns because every tile keeps its `.id`.
7. Compact density: the same code path (cards are placed by their compact `estimatedHeight`); the density menu and `RemiTileSize.phoneDensities` are unchanged.
8. Previews: keep `#Preview("Board")` and add previews named "Board, 466 pt", "Board, 744 pt", "Board, 1033 pt" and "Board, 1376 pt" that frame the screen at those widths (a `.frame(width:)` on the `NavigationStack`), so the manager can render the Duo outer, iPad mini portrait, iPad Pro portrait with the sidebar hidden and the iPad Pro landscape cases.
The worker may choose: names of private helpers, whether the column group is a small private view or a function, the exact test layout.

Never do: read `UIDevice`, `userInterfaceIdiom`, orientation, `horizontalSizeClass` or `UIScreen` for the column count; change the one-column rendering or its order; rebuild the composer when the count changes; add a stored property to the store or the board storage.

## Acceptance

1. `RemiBoardColumnsTests` (or the new file) pins the helper: 1 column returns the list as is; 2 and 3 columns assign the same ordered list the same way every time (a fixed table of items and heights with the expected columns written out); every item once; order preserved inside a column; empty list; a count larger than the list length; two different counts for the same ordered list contain the same set of keys (the "keys stay stable across a column change" pin from the design); the assignment depends on the density's `estimatedHeight`, not on any other input.
2. Reading the source, the one-column branch of `boardScroll` is the previous code path (the manager checks the diff for this: the existing `LazyVStack`, padding, readable column and animation untouched).
3. The count follows the measured pane width through `onGeometryChange` and `RemiBoardColumns.resolve(paneWidth:previousColumnCount:)`; no other input.
4. The previews in item 8 compile and are named as written.
5. The exact-build script compiles the iPhone app for the simulator (no launch).
6. The PR body states what changed, which acceptance items are covered by which test, that the shell's sidebar rule is not in this PR (P02c), and that no visual run was done by the worker.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoardColumnsTests` passes; then the full `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected <final head> --receipt-dir <EVID>/receipt --simulator` ends with a receipt for that head and a successful build (it does not launch anything); `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree for the git hooks.

## Stop conditions

The one-column screen would change in any way (a different order, padding, animation or id); the pane width cannot be measured without a size class or a device read; a test outside the scoped files fails; the build script needs the owner's keychain or a hub (stop and report; do not launch a simulator).

## Report

The preamble's report, plus one line per acceptance item with the test or command that covers it, the receipt path, and the list of preview names.
