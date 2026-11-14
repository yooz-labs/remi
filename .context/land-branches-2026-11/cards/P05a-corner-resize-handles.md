# Card P05a: corner resize handles that step a card's size on iPad (issue #1763, part 1)

Status: ready
Tier: worker
Timebox: L, 8 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: P03 merged (PR #1761: per-card sizes, `RemiBoardState.explicitSize`, height-aware `place`, `growsToContent`) and P02c merged (PR #1760)
Branch: `feature/issue-1763-corner-handles` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/board-handles` (the manager creates it with `git worktree add -b`, then `bun install`)
Plan: issue #1763 (read it first), `packages/native/handoff/ipad-board.md` "Resizing"; the Mac handle in `BoardTile.swift` (`BoardResizeCorner`, `resizeHandle(top:)`) is the visual and accessibility model

## Goal

At two or more Board columns, every card has a small curved corner handle at its bottom-right and its top-right corner, in the same drawing as the Mac Board's; dragging it up or down steps the card's size between Compact, Medium and Long with the card following the finger, the choice is stored as the card's explicit size (P03), and the handle works with touch, pointer (with the system resize cursor) and VoiceOver; the Mac and the one-column phone are unchanged. Horizontal span (a card across two columns) is P05b, not this card.

## Context

- The Mac handle (`BoardTile.swift`): a rounded corner bracket stroke (`BoardResizeCorner`, 1.4 pt line, 15 pt drawing in a 26 pt target, hover highlight, accent when the tile needs you), drag callbacks on `RemiBoardTilePlacement`, arrow keys step 24 pt, accessibility label "Resize tile" with hint and actions Widen, Narrow, Make taller, Make shorter. It is shown only when `extras.placement != nil` (the Mac canvas).
- Apple: the system window corner grabber is drawn by iPadOS for windows and has no API for views; for a pointer, SwiftUI has `PointerStyle.frameResize(position:directions:)` (apply with `.pointerStyle(_:)`). Check its availability in the SDK (`xcrun --sdk iphonesimulator --show-sdk-path`, then the SwiftUI `.swiftinterface`) and use `#available` if the deployment target is lower; if a direction set cannot express "vertical only" for a corner, use the closest documented one.
- P03 gives: `RemiTileSize.phoneCardHeight` (row 96, regular 240, large 440), `RemiTileSize.phoneDensities` (Compact row, Medium regular, Long large), `RemiBoardState.explicitSize/setSize`, `effectivePhoneSize`, `place(_:columnCount:heights:)`.
- The card header is draggable for reordering (`draggable` payload); the scroll view scrolls vertically. The handle's drag must win over both: give it a high-priority drag gesture with a small minimum distance and a hit area of at least 44 pt (`RemiTheme.Size.minimumTapTarget`) while the drawing stays 15 pt.
- No simulator, no app launch, no Xcode MCP (a simulator may hold the real hub). The manager renders previews after your push.

## Scope

May change: `packages/native/RemiKit/Sources/RemiUI/BoardTile.swift` (additive: a new opt-in `RemiBoardTileExtras.cornerResize`, the shared handle view; the Mac's `placement` path stays byte-for-byte as it is); a new `packages/native/RemiKit/Sources/RemiUI/RemiBoardCardResize.swift` (pure gesture mapping) and `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardCardResizeTests.swift`; `packages/native/iPhone/PhoneBoardScreen.swift`; the PR body.
No other file: not `PhoneLiveRootView.swift`, not the Mac, not `RemiBoardColumns.swift`, not the project file.

## Decided design

Settled:
1. A pure, public mapping in `RemiBoardCardResize.swift`: from the size at the start of the drag, the vertical translation in points and which corner (top or bottom), return the size to show. The target height is the start's phone card height plus the translation (down enlarges at the bottom corner; up enlarges at the top corner, as the Mac's "drag up and right to enlarge"); the result is the phone density (`RemiTileSize.phoneDensities`) whose phone card height is nearest, with the boundaries at the midpoints between 96, 240 and 440 (168 and 340); a start size that is not a phone density counts as Medium. No hysteresis, no storage, no view code.
2. The shared handle view: make the Mac's corner drawing reusable (internal or public as needed) without changing the Mac's output; a `RemiBoardResizeHandle` view with `top: Bool`, the same stroke and the accent when the card needs you, a 44 pt hit area, the hover highlight, `.pointerStyle(.frameResize(...))` on hover, accessibility label "Resize card" with the hint "Drag up or down to change the card size" and actions "Make larger" and "Make smaller" that step to the neighboring density (Compact, Medium, Long), and the arrow keys Up and Down doing the same. VoiceOver announces the new size title (`densityTitle`).
3. `RemiBoardTileExtras` gets `cornerResize: RemiBoardCornerResize?` (nil by default, so the Mac and the one-column phone get no handle), a small struct with the callbacks the tile needs: drag changed with the vertical translation and the corner, drag ended, and the step actions. `BoardTile` draws the two handles at its trailing corners (top and bottom) only when `cornerResize != nil` and `placement == nil`.
4. `PhoneBoardScreen` passes `cornerResize` only at two or more columns. While a drag runs, the card's size is the mapping's result for the current translation (captured start size per key held in `@State` for the drag only, never in storage); the layout updates as the card steps (placement uses the stepped height); on end the final size is stored with `setSize` and the Board is saved once; a cancelled drag restores the start size. The drag must not start a reorder drag or a scroll.
5. A drag in progress does not rebuild the tile (stable identity: the tile keeps its `.id`), does not animate the column assignment on every point of movement (animate only when the stepped size changes, with `RemiTheme.Motion.standard`, and respect Reduce Motion), and never changes the toolbar's Card size or other cards.
6. Previews: the existing multi-column Board previews already show the handles; add "Board, 1032 pt pane, handles" only if a distinct state is needed (for example one card at Long and a dragging state is not previewable; then no new preview).
The worker may choose: names, the exact handle struct fields, whether the shared drawing lives in `BoardTile.swift` or a new file within RemiUI.

Never do: change the Mac handle or the one-column phone; store drag state in `RemiBoardState`; use a size class, device, idiom, orientation or `UIScreen`; hoist `BoardTile`'s send state (#1757); change the span or column logic (P05b).

## Acceptance

1. `RemiBoardCardResizeTests` pin, with literal expectations: from Medium, a bottom-corner drag of 0 stays Medium, +60 stays, +100 gives Long (boundary at 90 from Medium to Long is the 340 midpoint: write the exact boundary values), -73 and -72 around the 168 midpoint to Compact, from Compact +40 and +72, from Long -100 and -101, the top corner mirrored (dragging up enlarges), a start size that is not a phone density counts as Medium, and the extremes (huge positive and negative translations clamp to Long and Compact, nonfinite translation keeps the start size).
2. A test that `RemiBoardTileExtras()` has `cornerResize == nil` (so the Mac gets no handle) and that the Mac's placement path still draws its own handles (source read by the manager).
3. Reading the source: the handle drag is a high-priority gesture on the handle only; the stored size changes only on drag end; a cancelled drag restores the start; the one-column path passes `cornerResize: nil`.
4. The build script ends with a receipt for the final head, no simulator.
5. The PR body states what changed, which test covers each acceptance item, the SDK availability check for the pointer style and how it was verified, that horizontal span is P05b, that no visual or device run was done by the worker, and what the manager's previews will show.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoardCardResizeTests` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected <final head> --receipt-dir /Volumes/S1/derived/remi-board-handles-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree.

## Stop conditions

The drag cannot win over the scroll view or the header's reorder drag without changing code outside the scope; the pointer style cannot be applied without raising the deployment target; a change would alter what the Mac draws or does; a test outside the scoped files fails.

## Report

The preamble's report, plus one line per acceptance item with the test or command that covers it, the receipt path, and how the pointer-style availability was checked.
