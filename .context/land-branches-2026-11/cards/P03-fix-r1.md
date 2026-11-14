# Card P03-fix-r1: review round-1 fixes for PR #1761

Status: ready
Tier: worker
Timebox: M, 4 hours; escalate at 1 day
Needs: xcode
Depends: P03 (PR #1761, head `d7351b42`, three Sonnet round-1 reviews in)
Branch: `feature/issue-1745-per-card-density` (the PR's own branch; commits on it, one push)
Worktree: `/Volumes/S1/worktrees/remi/board-density` (exists)
Plan: `packages/native/handoff/ipad-board.md` "Resizing", "Placement"; the P03 card

## Goal

Every accepted round-1 finding is fixed on the PR branch in one push: the multi-column presentation rule and the #1759 grow-to-content rule are pure, public and table-tested; the call sites in the screen are guarded by source-read tests in the repo's existing style; the placement tests use literal tables; the comments and the design say what the code does; the preview scaffolding is out of the production path; and a few small edge cases from the contract review are closed. There is no third review round.

## Context

Read the three reviews in `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/P03/r2/` first (`contract.json` had no findings but listed residual risks that are accepted here; `verification.json`; `maintainability.json`).
Repo precedent for source-read tests: `ComposerSubmissionTests.imageNoticeAndOfferPolicyAreUsedByBothCallSites` reads a source file through `#filePath`; follow it.
Another worker (P02c) edits `PhoneLiveRootView.swift`, `ScreenPreviews.swift`, `RemiSidebarPlacement*` and one sentence in `ipad-board.md` "The rule"; do not touch those.

## Scope

May change: `packages/native/iPhone/PhoneBoardScreen.swift`; `packages/native/RemiKit/Sources/RemiUI/BoardTile.swift`; `packages/native/RemiKit/Sources/RemiUI/RemiBoard.swift`; `packages/native/RemiKit/Sources/RemiUI/RemiBoardColumns.swift`; `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardCardSizeTests.swift`; `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardColumnsTests.swift`; new `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardCardPresentationTests.swift`; the PR body (extend it); one sentence in `packages/native/handoff/ipad-board.md` under "Placement" (item 7).
No other file.

## Decided design

Settled, in this order, as atomic commits where natural:
1. One multi-column rule. A small public pure type in `RemiUI` (for example `RemiBoardCardPresentation`) built from the Board's resolved column count: `isMultiColumn` (count of 2 or more; zero and negative are not), `sizeChoices` (`RemiTileSize.phoneDensities` when multi-column, else `[]`) and `growsToContent` (true when multi-column). `effectivePhoneSize`, the tile's `extras` and `boardScroll`'s one-column branch all read it; the literal `>= 2` appears once. Table-test counts -1, 0, 1, 2, 3, 6.
2. The #1759 rule as a pure public function in `BoardTile.swift` (for example `RemiBoardTileSizing.growsToContent(optedIn:needsYou:hasQuestion:)`), used by the tile; table-test all eight combinations (opted in alone grows; needs you with a question grows; needs you without a question does not grow unless opted in; nothing set does not grow). The private `TileHeight` keeps choosing minimum height versus fixed height from it. The default `RemiBoardTileExtras()` still has `growsToContent == false`.
3. Source-read tests in `RemiBoardCardPresentationTests` (precedent above) asserting that `PhoneBoardScreen.swift` builds the tile's `sizeChoices` and `growsToContent` from the presentation type (not from a literal comparison), calls `board.clearSizes()` from the toolbar size setter, computes `composerKeys`, `liveOrder` and the placement heights from `effectiveSize(for:)`, and no longer contains `density.showsComposer`; read the strings the final code has, keep each assertion to one short fragment, and say in the PR body that these are guards on call sites, not behavior tests.
4. Placement tests: replace the self-comparing `expected` in the missing and extra heights test with literals (heights 440,240,240,240,240 at 2 columns give `[[a, d], [b, c, e]]`; a heights array shorter by one and longer by one give the same columns), add `columnCount` 0 and -1 with a heights array (one column holding everything in order), and keep the other tables.
5. Effective-size tests: put the composer expectation in the table as a literal per row (`.large` true, `.row` false) instead of recomputing `showsComposer`; add rows for column counts 0 and -1 (toolbar density wins); a stored explicit size that is not a phone density (`.compact`) is treated as the toolbar density's neighbor Medium: `effectivePhoneSize` normalizes an explicit size to the phone densities (`.compact` to `.regular`, any other non-phone size to `.regular`) and a test pins it.
6. Small behavior fixes from the contract review: (a) when the focused card's composer disappears (its effective size becomes Compact or the column count changes so that it has none), clear `focus` (an `onChange` of `composerKeys`, clearing only if the focused key is no longer in it); (b) the toolbar size menu gains an explicit "Reset card sizes" button, shown only at two or more columns and only when `RemiBoardState.hasExplicitSizes` (a new additive property), which clears all explicit sizes and saves; the informational `Text` row in the menu is removed and the picker's help is carried by the button; (c) the toolbar setter still clears all explicit sizes and saves, in that order, and the PR body says that at one column a toolbar change also clears the stored explicit sizes.
7. Docs: the `PhoneBoardScreen` header comment says the toolbar sets one density for every card and, from two columns, a card's own menu overrides it until the toolbar or "Reset card sizes" is used; `RemiBoardState.explicitSize` (nil when none was chosen, unlike `size(for:)`, which falls back to Medium), `clearSizes`, `hasExplicitSizes` have doc comments; delete `clearSize(for:)` and its test lines (no caller); `phoneCardHeight` uses `estimatedHeight` for `.row` and `.compact` instead of repeating the literal 96 where it can; in `ipad-board.md` "Placement" add one sentence that placement packs by each card's phone card height (96, 240, 440), which are minimums because cards grow to content at two or more columns, so columns can be unbalanced by design (this replaces the sentence that says every card shares one height).
8. Preview scaffolding out of production: remove the `phoneBoardPreviewState` environment key, its extension, the `@Environment` property and the `loadBoard` branch; seed the mixed-sizes preview with a plain optional initial board parameter on `PhoneBoardScreen` (for example `var initialBoard: RemiBoardState? = nil`, defaulting to nil so every call site is unchanged), used only when the stored board is empty or by `loadBoard` when set; document it as preview and test seeding.
9. The PR body: update to the above; say that the #1759 behavior has a pure rule table-tested and was also seen rendered in the manager's mixed-size preview (cards at 1032 pt grow to their transcript; the manager attaches the image path `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/P03/r2/previews/pane-1032-mixed-sizes.png`, which is local only); say which behaviors are source-guarded rather than behavior-tested; that #1757 and #1758 are untouched.
Not changing: the placement heuristic (nominal minimum heights, columns may be unbalanced when cards grow), the toolbar-clears-sizes rule.
The worker may choose: names of the new types and the new property, test names.

Never do: change the one-column rendering; change the Mac Board; touch the files P02c owns.

## Acceptance

1. Items 1 to 9 are done; the named tests exist and pass.
2. `>= 2` for the multi-column rule appears once in the sources (the presentation type); `density.showsComposer` no longer appears in `PhoneBoardScreen.swift`.
3. The preview environment key is gone and the mixed-sizes preview still compiles.
4. The build script ends with a receipt for the final head, no simulator.
5. The PR body matches the code and tests.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoardColumns --filter RemiBoardCardSizeTests --filter RemiBoardCardPresentationTests` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected <final head> --receipt-dir /Volumes/S1/derived/remi-board-density-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing.

## Stop conditions

A fix would change the one-column screen or the Mac Board; a test outside the scoped files fails.

## Report

The preamble's report, plus one line per item above with the commit that did it, the receipt path, and the final head after one push.
