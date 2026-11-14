# Card P02c-fix-r2: two leftovers from the delta review of PR #1760

Status: ready
Tier: worker
Timebox: S, 1 hour
Needs: xcode
Depends: P02c fix round r3 pushed (head `0f3116e7`), delta review clean
Branch: `feature/issue-1745-sidebar-rule` (the PR's own branch; one commit, one push)
Worktree: `/Volumes/S1/worktrees/remi/board-sidebar` (exists)
Plan: `packages/native/handoff/ipad-board.md` "The rule"

## Goal

The design table and one doc comment say what the code does after the decision to keep one stable balanced split: below 1000 pt the sidebar is hidden by default and narrows the Board when the person opens it; no overlay.

## Context

The delta review (`/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/P02c/r4/review.json`, `omitted_findings`) found: (1) `ipad-board.md` table rows (about lines 73 to 85) still label the narrow-window sidebar column "overlay", contradicting the new sentence in "The rule" part 1; (2) the doc comment on `sidebarToggleButton` in `PhoneLiveRootView.swift` still says it is "driven by the same column layout the keyboard shortcut uses", but that state was removed. `RemiSidebarPlacement.isBeside` having no production caller is rejected as a finding: it is documented public API pinned by tests and available to the shell.

## Scope

May change: `packages/native/handoff/ipad-board.md` (the table's Sidebar column and the sentences under the table that say "overlay", nothing else); the one doc comment in `packages/native/iPhone/PhoneLiveRootView.swift`; the PR body (one sentence).
No other file.

## Decided design

Settled: in the table, rows whose sidebar was "overlay" read "hidden" (the Board keeps the whole pane; opening the sidebar narrows it) and the sentences that call it an overlay say the sidebar is hidden by default and narrows the Board when the person opens it; the comment on `sidebarToggleButton` says it is driven by the same recorded choice and visibility as the keyboard shortcut (`sidebarPlacement` and `recordSidebarChoice`). American English, no em dashes. The pane widths and column counts in the table do not change.
The worker may choose: exact wording.

## Acceptance

1. No remaining "overlay" wording about the sidebar in `ipad-board.md` except where it describes the iPhone drawer or history; the table's numbers are unchanged.
2. The comment matches the code.

## Gates

`typos packages/native/handoff/ipad-board.md packages/native/iPhone/PhoneLiveRootView.swift` is clean; `git diff --check origin/develop...HEAD` prints nothing; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected <final head> --receipt-dir /Volumes/S1/derived/remi-board-sidebar-receipt` (no `--simulator`) ends with `Receipt:` for that head; `swift test --package-path packages/native/RemiKit --filter RemiSidebarPlacementTests` still passes (run under the same `lockf` as before).

## Stop conditions

Fixing the table would change a pane width or a column count; a file outside the scope would need to change.

## Report

The preamble's report with the final head after one push.
