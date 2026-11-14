# Card P02c: the sidebar sits beside the Board only from 1000 pt windows (slice 2b of #1745)

Status: ready
Tier: worker
Timebox: M, 6 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: P02b merged (PR #1756, Board columns on `develop`)
Branch: `feature/issue-1745-sidebar-rule` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/board-sidebar` (the manager creates it with `git worktree add -b`, then `bun install`)
Plan: `packages/native/handoff/ipad-board.md`, "The rule" part 1 and "Owner decisions" 5; `RemiBoardColumns.sidebarBeside(windowWidth:)` from slice 1 is the threshold

## Goal

In the iPhone target's regular-width shell, the session sidebar is beside the content only when the window is at least 1000 pt wide; below that it is hidden by default and, when the person opens it, it comes over the content instead of squeezing it; the person's explicit show or hide choice wins over the default and is kept for that window; compact (phone) layout and the Mac are unchanged.

## Context

- Read the design doc first ("The rule" part 1), then `PhoneLiveRootView.swift` (`rootLayout`, `columnLayout`, `columnVisibility`, `toggleSidebar`, `shellContent`, the toolbar toggle), `RemiShellChrome.swift`, `RemiLayoutMode.swift` and `MacWorkspaceNavigation.swift` (`RemiMacColumnLayout`, with `storageValue` for scene storage and `togglingNavigation`).
- Today a regular size class always builds `NavigationSplitView(columnVisibility:)` with `.balanced` style and the sidebar open (`.all`), which takes 340 pt of a portrait iPad (744 pt mini, 834 pt Air) and leaves the Board a narrow pane. The owner requires several columns even in portrait, so below 1000 pt the Board must keep the whole width.
- SwiftUI facts to check before relying on them (Apple's documentation and a quick preview or build; do not guess): `NavigationSplitViewStyle.prominentDetail` keeps the detail's size and lets the sidebar come over it, `.balanced` shrinks the detail; the system adds its own sidebar toggle to the detail's toolbar when the sidebar is hidden (the shell already relies on this, see the comment on `sidebarToggleButton`).
- The window width is the width the shell is laid out in, measured with `onGeometryChange` on the shell's root view; never read a device, an idiom, an orientation, a size class (other than the existing compact/regular split) or `UIScreen` for it. A fold, unfold, Split View change or window resize all arrive as a size change.
- Owner decision 5 (open): below 1000 pt the system toggle in the navigation bar is the way to the sidebar; a left-edge swipe is not added in this card.
- No simulator, no app launch, no Xcode MCP in this card (a simulator may hold the real hub). The manager renders previews after your push.

## Scope

May change: `packages/native/iPhone/PhoneLiveRootView.swift`; `packages/native/iPhone/ScreenPreviews.swift` (previews only); new `packages/native/RemiKit/Sources/RemiUI/RemiSidebarPlacement.swift` and new `packages/native/RemiKit/Tests/RemiKitTests/RemiSidebarPlacementTests.swift`; the PR body.
No other file: not the Mac shell, not `RemiShellChrome`'s compact behavior, not the Board, not the project file.

## Decided design

Settled:
1. A pure, public type in `RemiSidebarPlacement.swift` that decides the sidebar for a window width and the person's choice: inputs are the window width and an optional explicit choice (shown or hidden, nil when the person has not chosen); outputs are the `NavigationSplitViewVisibility` to apply and whether the sidebar sits beside the content (`RemiBoardColumns.sidebarBeside(windowWidth:)` is the only threshold, never a second 1000). With no explicit choice: at least 1000 pt gives the sidebar shown beside the content, below gives it hidden. An explicit choice wins at every width and survives resizes, folds and unfolds. A nonfinite or negative width counts as below the threshold.
2. The shell keeps `RemiMacColumnLayout` for the toggle semantics it already has (`togglingNavigation`, the keyboard command, the Go to Inbox reveal), and adds the explicit-choice state beside it: a toggle by the person (button, system toggle or keyboard) records the choice; the default is derived from the measured window width on every pass until a choice exists. The choice is kept per window with `@SceneStorage` (a value that survives a relaunch of that window), with a malformed or empty stored value meaning "no choice".
3. Below 1000 pt the split view uses the style that lets the sidebar come over the detail (`.prominentDetail`, if the check in Context confirms it) so the Board keeps its width when the sidebar opens; from 1000 pt the existing `.balanced`. The compact (phone) layout is not touched: `chrome.usesSidebar` stays false there and the drawer is unchanged.
4. The measured width is the window's, measured once at the shell root; the first frame before a measurement behaves as today (sidebar shown) only if that cannot flash a wrong layout on an iPad, otherwise as below 1000 pt (hidden); say which and why in the PR body.
5. Previews: add "Shell, 744 pt", "Shell, 1032 pt" and "Shell, 1376 pt" previews in `ScreenPreviews.swift` that show the regular shell at those window widths (reuse what the existing split preview there already uses), so the manager can render the iPad mini portrait, the iPad Pro 13-inch portrait and landscape cases.
The worker may choose: the type's names and shape, how the first frame is handled (within item 4), the preview data.

Never do: add a second threshold constant; read device, idiom, orientation or `UIScreen`; change the compact drawer, the Mac, the Board or the keyboard-command set; remove the system toggle fallback.

## Acceptance

1. `RemiSidebarPlacementTests` (Swift Testing) pins: no choice at 999 (hidden, overlay), 1000 (shown, beside), 1032, 1133, 1376; widths 744, 834 (hidden) and the design-table rows; an explicit hide at 1376 (hidden) and an explicit show at 744 (shown, not beside) and at 999 and 1000; the choice survives a width change in both directions (same choice, widths on both sides of 1000); nonfinite and negative widths; the output for `beside` always equals `RemiBoardColumns.sidebarBeside(windowWidth:)` when there is no choice; and a test fails if a second threshold is introduced (the test calls `sidebarBeside` and compares).
2. Reading the source: the shell reads no device, idiom, orientation or `UIScreen`; the only width input is the measured window width; the compact branch of `rootLayout` is byte-for-byte what it was.
3. `@SceneStorage` round trip: a stored choice string is parsed with a failable initializer, and an empty or malformed string means no choice (a test for the parse in RemiUI, not for the property wrapper).
4. The three previews exist with those names and the build compiles them.
5. The build script ends with a receipt for the final head, no simulator.
6. The PR body says what changed, which acceptance item each test covers, how the first frame is handled and why, that the visual and Device Hub checks (fold and unfold on the Duo, a real iPad window resize, the external display) were not run by the worker, and which SwiftUI behaviors were checked against Apple's documentation and how.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiSidebarPlacementTests` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected <final head> --receipt-dir /Volumes/S1/derived/remi-board-sidebar-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; `bun install` was run once in the worktree for the git hooks.

## Stop conditions

The only way to keep the Board's width below 1000 pt is to replace `NavigationSplitView` or to change the compact layout (stop and report with what you tried); the sidebar toggle disappears at some width (the system's toggle or ours must always exist when the sidebar is hidden); a test outside the scoped files fails; the build script needs a keychain or a hub.

## Report

The preamble's report, plus one line per acceptance item with the test or command that covers it, the receipt path, and the preview names.
