# Card P05a-fix-r1: review round-1 fixes for PR #1765

Status: ready
Tier: worker
Timebox: M, 5 hours; escalate at 1 day
Needs: xcode
Depends: P05a (PR #1765, head `96af8467`, three Sonnet round-1 reviews in)
Branch: `feature/issue-1763-corner-handles` (the PR's own branch; commits on it, one push)
Worktree: `/Volumes/S1/worktrees/remi/board-handles` (exists)
Plan: issue #1763, the P05a card

## Goal

Every accepted round-1 finding is fixed on the PR branch in one push: the corner handle no longer swallows the composer's Send button, the drag stays stable while the card changes size under the finger, stale drag state cannot survive a column change, a no-op drag stores nothing, the keyboard and VoiceOver wording matches the Mac, and the tests can fail for what they claim. There is no third review round.

## Context

Read the three reviews in `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/P05a/r2/` first (`contract.json`, `verification.json`, `maintainability.json`).
Geometry the contract review measured: tile padding `Spacing.s` 12; composer padding `Spacing.xs` 8 on all sides; the Send button is 44 by 44 (`minimumTapTarget`); so the Send box spans 20 to 64 pt from the trailing edge and bottom, and the 44 by 44 handle square at the corner covers a 24 by 24 pt part of it, including the glyph center. The compact row's summary button is also covered over its trailing 44 pt.

## Scope

May change: `packages/native/RemiKit/Sources/RemiUI/BoardTile.swift` (the new handle, the composer and row trailing inset when the handle is present, docs; the Mac `placement` path stays byte-for-byte); `packages/native/RemiKit/Sources/RemiUI/RemiBoardCardResize.swift`; `packages/native/iPhone/PhoneBoardScreen.swift`; `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardCardResizeTests.swift`; `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardCardPresentationTests.swift` (guards only, never weakened); the PR body (rewrite the claims).
No other file.

## Decided design

Settled, in this order:
1. Hit testing: the handle keeps its 44 pt square. When `extras.cornerResize != nil && extras.placement == nil`, the composer (`quickComposer`) and the compact row summary get trailing padding of `minimumTapTarget - (Spacing.s + Spacing.xs)` (24 pt) so their controls start outside the handle square; the top handle's square must not cover the header's trailing tappable content (check and inset if it does). The inset is one named constant derived from the tap target and paddings, with a pure test that the inset plus the tile padding plus the composer padding is at least `minimumTapTarget`. Nothing changes when `cornerResize` is nil (the Mac and the one-column phone).
2. Drag space: `DragGesture(minimumDistance: 1, coordinateSpace: .global)` in the handle, with a one-line comment saying why (the handle moves with the resized card), as the Mac handles do; pin it in a source guard.
3. State: replace the two dictionaries by one small struct per key (start size, preview size) held in `PhoneBoardScreen`; ignore a second concurrent drag on the same card (a drag from the other corner while one runs); clear all of it when the column count changes (`onChange(of: columnLayout.columnCount)`), prune it to live keys in `pruneBoard()`, and have `displayedSize(for:)` return the preview only when `RemiBoardCardPresentation(columnCount:).isMultiColumn`, otherwise the effective size.
4. No-op drags: `finishCardResize` compares the final size with the start size and skips `board.setSize` and `saveBoard()` when equal (the preview and start entries are still cleared); exactly one `saveBoard()` call stays in the function.
5. Pure step: move the step logic into `RemiBoardCardResize.step(from:direction:) -> RemiTileSize` (Compact minus one stays Compact, Compact plus one Medium, Medium plus one Long, Long plus one stays, Long minus one Medium, a non-phone start counts as Medium); the VoiceOver actions and the arrow keys call it; table-test with literals.
6. Wording and keys (match the Mac handle): accessibility label "Resize card"; actions "Make taller" (step plus one) and "Make shorter" (step minus one); Down arrow means taller and Up arrow shorter on both corners (as the Mac's); hint per corner: bottom "Drag down to make the card taller. Use the up and down arrow keys to change its size.", top "Drag up to make the card taller. Use the up and down arrow keys to change its size."; the value is the size title. Pin the strings in the source guard.
7. Tests: add literal nonfinite cases whose unguarded result differs from the start: `.row` with `.nan`, `.large` with `.nan`, `.regular` with `.infinity` and with `-.infinity`, each for both corners; in the source guards slice with `range(of:range:)` (as the P03 guard does) so a reordered function cannot trap the test process, and pin the key lines: the start capture `if resizingCardStartSizes[key] == nil`-style line in its new form, the `guard wasDragging, !dragging` and `if !dragDidEnd { onDragCancelled() }` lines, the no-op skip, the column-change clearing, and the pruning; each assertion one short fragment.
8. Docs: one `///` line per closure of `RemiBoardCornerResize` (cumulative translation since the gesture began, in points, positive downward; `topCorner` says which handle fired; `direction` is plus one larger and minus one smaller; `onDragCancelled` is called instead of `onDragEnded` when the system cancels the gesture and the caller must discard its preview); extend the `RemiBoardCardResize.size` comment with the clamp, the non-phone fallback, the nonfinite fallback and the tie rule; drop "phone" from the type comment (the screen decides who gets the handle); fix the stale comment at the `liveOrder` filter ("displayed size").
9. PR body: rewrite to match; say "source guard checks" not "confirms"; reword "reuses the Mac corner drawing" to "reuses the Mac corner shape (`BoardResizeCorner`)"; add a "Not verified" list: no resize cursor on iPad (only `hoverEffect(.highlight)`, never seen), the drag winning over the scroll view and the header reorder drag, cancel, keyboard focus, VoiceOver and Reduce Motion behavior, the Send button and compact row taps with the handle present, and that a preview to Compact mid-drag clears the focused composer and a cancel does not restore it (known limit, slice 4); list what changed in this round.
Not changing (rejected with reason): extracting one shared corner-glyph view for the Mac and iPad handles, because the Mac path must stay byte-for-byte unchanged and a visual regression there cannot be checked without a run.
The worker may choose: the struct and constant names.

Never do: change the Mac `placement` handle; weaken a guard; use a device, idiom, orientation or `UIScreen`.

## Acceptance

1. Items 1 to 9 are done; the named tests exist and pass under `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoardCardResize`.
2. At two or more columns the composer's Send button and the compact row's summary button lie entirely outside the handle square by construction (the inset test).
3. The handle drag uses the global coordinate space; the one-column path and the Mac are unchanged.
4. The build script ends with a receipt for the final head, no simulator.
5. The PR body matches the code and tests and carries the "Not verified" list.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoardCardResize --filter RemiBoardCardPresentationTests --filter RemiBoardCardSizeTests` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected FINAL_HEAD --receipt-dir /Volumes/S1/derived/remi-board-handles-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing.

## Stop conditions

Keeping the Send button outside the handle square needs a layout change beyond the trailing inset; a change would alter what the Mac draws; a test outside the scoped files fails.

## Report

The preamble's report, plus one line per item above with the commit, and the final head after one push.
