# Card P03: per-card density and content-height cards at two or more columns (slice 3 of #1745)

Status: ready
Tier: worker
Timebox: L, 8 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: P02b merged (Board columns, PR #1756, on `develop` at `01aae106`); independent of P02c (sidebar rule), which touches other files
Branch: `feature/issue-1745-per-card-density` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/board-density` (the manager creates it with `git worktree add -b`, then `bun install`)
Plan: `packages/native/handoff/ipad-board.md`, "Resizing" and slice 3; issue #1759 (fixed card height clips a waiting card without a question when text wraps; read it)

## Goal

At two or more Board columns a person can set the size of one card (Compact, Medium or Long) from that card's own menu, the choice is kept with the existing Board storage, cards are placed in columns by their real sizes, and a card's height grows with its content instead of clipping; at one column the screen is exactly what it is today.

## Context

- Today the phone Board has one density for every card (the toolbar's Card size menu: `RemiTileSize.phoneDensities` = row, regular, large, titled Compact, Medium, Long) and passes `RemiBoardTileExtras(sizeChoices: [], height: density == .large ? 440 : 240)`, so a tile has no menu of its own and a fixed height. `RemiBoardState` already stores `sizes` per card key (persisted with the Board in `@AppStorage("remi.phone.board")`) but has no way to ask whether a size was set explicitly (`size(for:)` falls back to `.regular`).
- `RemiBoardColumns.place` (slice 2a, `RemiBoardColumns.swift`) is reading-order round-robin because every card shared one height; it was written without a height argument on purpose and says that per-card heights would enter `RemiBoardOrder.columns(heights:count:)` when cards differ. This card is that moment.
- Issue #1759: `BoardTile` gives a tile a fixed `frame(height:)` unless it holds a waiting question; at card widths near the design's 300 pt minimum the text wraps and the top of the transcript clips.
- Read first: the design doc, `PhoneBoardScreen.swift` (`tile`, `densityMenu`, `composerKeys`, `arranged`, `multipleColumnStack`), `BoardTile.swift` (`RemiBoardTileExtras`, the size `Picker`, `TileHeight`/`BoardTileSizing`), `RemiBoard.swift` (`RemiBoardState`, `RemiTileSize`), `RemiBoardColumns.swift` and its tests. `BoardTile` is also the Mac Board's tile: every change there must be additive with a default that keeps the Mac exactly as it is.
- No simulator, no app launch, no Xcode MCP in this card (a simulator may hold the real hub). The manager renders previews after your push.

## Scope

May change: `packages/native/iPhone/PhoneBoardScreen.swift`; `packages/native/RemiKit/Sources/RemiUI/BoardTile.swift` (additive only); `packages/native/RemiKit/Sources/RemiUI/RemiBoard.swift` (additive only: `RemiBoardState` and `RemiTileSize`); `packages/native/RemiKit/Sources/RemiUI/RemiBoardColumns.swift`; `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardColumnsTests.swift`; new `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardCardSizeTests.swift`; the PR body.
No other file: not the Mac Board, not `PhoneLiveRootView.swift`, not `ScreenPreviews.swift` (P02c edits those), not the project file.

## Decided design

Settled:
1. `RemiBoardState` gains `explicitSize(for key: String) -> RemiTileSize?` (nil when none was set), `clearSizes()` and `clearSize(for:)`; the existing `size(for:)` and the stored format do not change, and a test pins that an old stored board still decodes and `size(for:)` keeps returning `.regular` for a key with no entry.
2. `RemiTileSize` gains a phone card height used by both the tile and the placement: row 96, regular 240, large 440 (a single source; the literals `440` and `240` in `PhoneBoardScreen.tile` are replaced by it). Compact rows keep their own height behavior in the tile.
3. The effective size of a card at two or more columns is its explicit size if it has one, else the toolbar's density; at one column it is always the toolbar's density (explicit sizes are kept in storage and apply again when the width returns to two or more columns). `composerKeys` and `showsComposer` logic use the effective size of each card, so a Compact card never counts as having a composer and a draft in it never freezes the order.
4. At two or more columns each tile gets `sizeChoices: RemiTileSize.phoneDensities` and an `onSetSize` that stores the explicit size (`setSize`) and saves the Board; at one column `sizeChoices` stays `[]` as today. Changing the toolbar's Card size clears all explicit sizes (`clearSizes()`), so the toolbar menu is also the way back to one size for every card; say so in the menu's help text or the PR body.
5. `RemiBoardColumns.place` takes per-card heights again: `place(_ items:, columnCount:, heights:)` using `RemiBoardOrder.columns(heights:count:)` (the shortest-column pack); the heights are the phone card heights of the effective sizes; the doc comment is updated to say heights are real now. The slice 2a tests that pinned round-robin for equal heights stay true for equal heights and are kept; add a literal unequal-height table (for example heights 440,96,96,96,96 at 2 columns gives `[[a],[b,c,d,e]]`, and a Long card first at 3 columns), a nonpositive count, an empty list, a heights array shorter or longer than the items (missing heights are treated as the regular phone height, extra heights ignored), and that every item appears once in input order within a column.
6. #1759: `RemiBoardTileExtras` gains `growsToContent: Bool = false` (public, default false so the Mac and the one-column phone keep the fixed height); when true the tile uses `frame(minHeight:)` with the same height instead of `frame(height:)` (the existing waiting-question rule already does this). `PhoneBoardScreen` sets it true only at two or more columns. A test pins the default and that the phone one-column call passes false.
7. The one-column path (`singleColumnStack` and everything it uses) is unchanged: same tiles, same fixed height, no menu; the manager checks the diff.
8. Previews are not in this card's scope (the previews live in `PhoneBoardScreen.swift`; add one preview "Board, 1032 pt pane, mixed sizes" whose preview data sets explicit sizes for three cards through a `RemiBoardState` the preview owns, so the manager can render different heights in columns).
The worker may choose: names of the new state methods and the preview, how the per-card menu text reads (reuse `densityTitle`).

Never do: change the one-column behavior; change what the Mac Board does; read device, idiom, orientation or `UIScreen`; put a column or an index into a tile's identity; hoist `BoardTile`'s send state (that is #1757, slice 4); store anything outside `RemiBoardState`.

## Acceptance

1. Tests (`RemiBoardCardSizeTests` and the extended `RemiBoardColumnsTests`) pin: `explicitSize` is nil for a key with no entry and returns what `setSize` stored, `clearSize` and `clearSizes` remove entries, an old stored board decodes unchanged; the phone card heights (96, 240, 440) as literals; the unequal-height `place` tables and degenerate inputs from item 5; the effective-size rule as a pure function in `RemiUI` (one column: toolbar density always; two or more: explicit wins, else toolbar density; compact rows have no composer) with a table over both cases; `growsToContent` defaults to false.
2. Reading the source: at one column the tile receives `sizeChoices: []` and `growsToContent: false` and the fixed height; the `singleColumnStack` code is unchanged.
3. `composerKeys` and the order-freeze logic use effective sizes (a source read plus the pure-function test).
4. The preview "Board, 1032 pt pane, mixed sizes" exists and compiles.
5. The build script ends with a receipt for the final head, no simulator.
6. The PR body states what changed, which acceptance item each test covers, that #1759 is fixed for two or more columns only and that #1757 and #1758 are untouched, and that no visual run was done by the worker.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoardColumns --filter RemiBoardCardSizeTests` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected <final head> --receipt-dir /Volumes/S1/derived/remi-board-density-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree for the git hooks.

## Stop conditions

A change to `BoardTile` would alter the Mac's rendering or the one-column phone; the existing size `Picker` in the tile cannot be used for the per-card menu without a new tile API beyond the two additive fields (stop and report what is needed); a test outside the scoped files fails; the build script needs a keychain or a hub.

## Report

The preamble's report, plus one line per acceptance item with the test or command that covers it, the receipt path, and the preview name.
