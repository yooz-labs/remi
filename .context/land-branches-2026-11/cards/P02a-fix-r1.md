# Card P02a-fix-r1: review round-1 fixes for PR #1755

Status: ready
Tier: worker
Timebox: S, 2 hours; escalate at 1 day
Needs: xcode
Depends: P02a (PR #1755, head `24467f99`, three Sonnet round-1 reviews in)
Branch: `feature/issue-1745-board-columns` (the PR's own branch; commits on it, one push)
Worktree: `/Volumes/S1/worktrees/remi/board-columns` (exists)
Plan: `packages/native/handoff/ipad-board.md`, "The rule"

## Goal

Every accepted round-1 finding is fixed on the PR branch in one push, the gates pass on the final head, and the PR body says what changed; there is no third review round.

## Context

Three reviews (contract, verification, maintainability) found no wrong behavior, only an undocumented dip, missing pins and a crash edge. The behavior of `resolve` for normal widths does not change, except the clamp below and the single formula. Read the two source files and the design doc first.

## Scope

May change: `packages/native/RemiKit/Sources/RemiUI/RemiBoardColumns.swift`, `packages/native/RemiKit/Tests/RemiKitTests/RemiBoardColumnsTests.swift`, the PR body (extend it), and one sentence in `packages/native/handoff/ipad-board.md` (item 1 below).
No other file.

## Decided design

Settled (do each, in this order, as separate atomic commits where natural):
1. Hysteresis dip: while a column is held, `cardWidth` may fall below `minimumCardWidth` by at most `hysteresis / columnCount` (288 pt at two columns, 292 at three, 296 at six). Document it on the type, on `minimumCardWidth` and on `resolve`; change the design doc's "at least 300 pt" sentence to "at least 300 pt, except up to 24 pt divided by the column count less while a column is held".
2. Large finite widths: `resolve` must not trap for any finite pane. Clamp the available width before delegating (for example `min(paneWidth - 2 * margin, 1_000_000)`), keeping the result at `maximumColumns` and the 720 pt card cap. Test `.greatestFiniteMagnitude` and 1e300.
3. Narrow panes: keep the `paneWidth > 2 * margin` guard. Document that "too narrow" means a pane that is not wider than the margins, and that a pane just wider than the margins returns one column of the remaining width as is (pane 33 gives card width 1). Test pane 33 and pane 100.
4. Doc comments in the style of `RemiLayoutMode.swift`: on `resolve` (the `previousColumnCount` contract: pass the count this function returned for the previous layout of the same pane; `nil`, 1 and values outside 2 to 6 disable holding; an invalid pane returns one column with zero widths), on each constant (which design number it is, with a pointer to `handoff/ipad-board.md` "The rule"), on `groupWidth` (the width the caller centers), and on `sidebarBeside` (a shell-level rule kept here so the thresholds live together; slice 2 uses it from the shell). American English, no em dashes.
5. One formula for the card width: `let widthForEachCard = (availableWidth - spacing * CGFloat(columnCount - 1)) / CGFloat(columnCount)` and `min(widthForEachCard, RemiTheme.Size.readableContentWidth)`; remove the one-column branch.
6. Tests:
   - Label every design row with a device name and pass the label and pane to the `#expect` message; add the iPad mini landscape sidebar-hidden row (pane 1133, 3 columns) and a phone row (pane 393, 1 column).
   - Pin one-column widths: pane 466 gives card and group width 434; pane 643 gives 611.
   - Pin the six-column case at 2000: `abs(cardWidth - 318) < 0.01` and `groupWidth + 32 <= 2000`; at 5000 assert `cardWidth == 720` and `groupWidth == 6 * 720 + 5 * 12` as literals, and in a separate test that `RemiTheme.Size.readableContentWidth == 720`.
   - Hysteresis: a table over every previous count 2 to 6 asserting that `startWidth(prev) - 24` holds the count and one point below drops by exactly one (for example 1244 holds 4, 1243 gives 3, 1868 holds 6, 1867 gives 5); for 940 and 932 with previous 3 and for 625 and 620 with previous 2 assert `cardWidth >= minimumCardWidth - hysteresis / count`, the exact dipped width, and `groupWidth + 2 * margin <= paneWidth`; previous 4 at 643 and at 940 are immediate multi-column drops; previous 0, 1, 7 and -3 equal the raw result.
   - Rename `rawColumnCountDelegatesToBoardOrder` to `rawColumnCountMatchesBoardOrderAtDesignValues`, say in a comment that the literals 32, 300 and 12 are the design values on purpose so constant drift fails, step the sweep by 0.5 and add the fractional points 643.5, 643.99, 955.99 and 1267.99, and put the pane in every `#expect` message.
7. The PR body: update the design-row table to include the 1133 and phone rows, and reword the claims about the minimum width and delegation to match the tests.

Not changing (rejected with reason): a public memberwise initializer, because no consumer needs one and slice 2 can add it if it does.
The worker may choose: names of private helpers and test helper functions.

## Acceptance

1. Every item above is done; the tests named exist and pass.
2. `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiBoardColumnsTests` passes, then the full `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes.
3. `typos` on the changed files is clean and `git diff --check origin/develop...HEAD` prints nothing.
4. One push; the final head is reported.

## Gates

The two `swift test` commands, `typos` on the changed files and `git diff --check origin/develop...HEAD` from Acceptance items 2 and 3, each run on the final head and quoted.

## Stop conditions

A fix that changes the resolved column count for any pane in the design table; a test outside the two files fails.

## Report

The preamble's report, plus one line per item above with the commit that did it.
