# Card P02a: the Board column resolver (slice 1 of #1745)

Status: ready
Tier: worker
Timebox: S, 4 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: P01 approved by the owner (2026-11-13: "yes good go")
Branch: `feature/issue-1745-board-columns` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/board-columns` (the manager creates it with `git worktree add -b`)
Plan: `packages/native/handoff/ipad-board.md` (PR #1754), section "The rule" and "Slices", slice 1

## Goal

A pure, tested function in `RemiUI` turns the width a Board pane was given into a column count and a card width, and says whether the sidebar sits beside the Board at a window width, so slices 2 and 3 only call it; no view changes.

## Context

- The rule (read the design doc first, it is authoritative): `available = pane - 2 x 16`; `columns = floor((available + 12) / (300 + 12))`, at least 1, at most 6; a card is as wide as its column and at most 720 pt (`RemiTheme.Size.readableContentWidth`); the sidebar sits beside the Board only when the window is at least 1000 pt wide.
- `RemiBoardOrder.columnCount(width:minimumTile:spacing:)` already computes the raw count (`RemiBoard.swift`, minimum tile defaults to 340 for the Mac); reuse it with `minimumTile: 300`, do not copy the formula.
- Hysteresis: a column is added at its threshold and removed only 24 pt below it, so a slow window drag at a threshold does not flip the layout every frame. The pane width where `n` columns start is `2 x 16 + n x 300 + (n - 1) x 12`: 644 for two, 956 for three, 1268 for four.
- `RemiLayoutMode.swift` and `RemiLayoutModeTests.swift` show the style of a small pure layout type and its tests.
- Never connect a simulator to the owner's real hub; this card runs no simulator.

## Scope

May change: new `packages/native/RemiKit/Sources/RemiUI/RemiBoardColumns.swift` and new `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardColumnsTests.swift`.
No view, store, project or scheme changes; do not touch `RemiBoard.swift` or the Mac Board.

## Decided design

Settled:
- `public struct RemiBoardColumns: Equatable, Sendable` with `columnCount: Int`, `cardWidth: CGFloat`, and `groupWidth: CGFloat` (the width the columns and their gaps occupy, so a view can center the group).
- `public static func resolve(paneWidth: CGFloat, previousColumnCount: Int? = nil) -> RemiBoardColumns`: with `previousColumnCount` set, it keeps that many columns while the pane is within 24 pt below that count's start width and the raw count is exactly one fewer; every other change is immediate.
- `public static func sidebarBeside(windowWidth: CGFloat) -> Bool` is true from 1000 pt.
- Constants are `public static let` with the values above (`minimumCardWidth` 300, `spacing` 12, `margin` 16, `hysteresis` 24, `sidebarBesideMinimumWindowWidth` 1000).
- A width that is not finite, zero or negative resolves to one column with `cardWidth` 0 and `groupWidth` 0 (never a crash, never more than one column).
- One column: `cardWidth` is the available width capped at 720 pt; two or more: `(available - 12 x (n - 1)) / n` capped at 720 pt.
The worker may choose: names of private helpers, the layout of the test file.

## Acceptance

1. `RemiBoardColumnsTests` (Swift Testing, in the style of `RemiLayoutModeTests`) pins every row of the design table: panes 466, 669, 951, 744, 793, 834, 692, 1032, 854, 1036, 1376 give the column counts the table lists (1, 2, 2, 2, 2, 2, 2, 3, 2, 3, 4).
2. Boundaries, each on both sides: 643 and 644, 955 and 956, 1267 and 1268, and the six-column cap at a very wide pane; `sidebarBeside` at 999 and 1000.
3. Hysteresis: from 3 columns at 956, a pane of 940 stays 3 and 931 drops to 2; from 2 at 644, 625 stays 2 and 619 drops to 1; going up is immediate; a drop of two columns at once is immediate.
4. Zero, negative, `.nan`, `.infinity` and a pane narrower than the margins resolve to one column and zero widths.
5. Card widths: a 1032 pane gives three columns whose `groupWidth` plus both margins is at most 1032 and whose card width is at least 300; the 720 cap holds at a 2000 pt pane with six columns.
6. A test fails if `RemiBoardColumns` stops delegating the raw count to `RemiBoardOrder.columnCount` with a 300 pt minimum (for example, assert the count equals `RemiBoardOrder.columnCount(width: pane - 32, minimumTile: 300, spacing: 12)` for a sweep of widths from 0 to 2400).
7. The PR body lists the design table next to the pinned values and says which tests would fail for which defect.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoardColumnsTests` passes; then the full `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes (the two skipped suites are the documented local baseline, Q20); `typos` on the two new files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree for the git hooks.

## Stop conditions

The design table and the formula disagree on a row (report the row, do not pick); the existing `RemiBoardOrder.columnCount` clamps differently from the rule; a test outside the two files fails.

## Report

The preamble's report, plus the pinned table and a line for each acceptance item with the test name that covers it.
