# Card P02c-fix-r1: review round-1 fixes for PR #1760

Status: ready
Tier: worker
Timebox: M, 4 hours; escalate at 1 day
Needs: xcode
Depends: P02c (PR #1760, head `81663904`, three Sonnet round-1 reviews in)
Branch: `feature/issue-1745-sidebar-rule` (the PR's own branch; commits on it, one push)
Worktree: `/Volumes/S1/worktrees/remi/board-sidebar` (exists)
Plan: `packages/native/handoff/ipad-board.md`, "The rule" part 1

## Goal

Every accepted round-1 finding is fixed on the PR branch in one push; the split view keeps one stable identity at every width, so a resize, a rotation or the first measurement never rebuilds the shell; only a person's own show or hide is recorded as a choice; and there is no third review round.

## Context

Three reviews (contract, verification, maintainability) found: (1) `PhoneSidebarSplitStyle` swaps `.prominentDetail` and `.balanced` in an if/else, which gives the two branches different identity, so crossing 1000 pt (an iPad mini rotation 744 to 1133, a window drag, the first measurement) rebuilds the whole `NavigationSplitView` subtree and loses composer drafts and every descendant `@State` (before this PR the style was fixed and nothing was lost); (2) the `columnVisibility` setter records a choice on every write, including system-driven and same-value writes, which become a permanent choice in `@SceneStorage`; (3) `columnLayout` and `effectiveColumnLayout` are dead state and the record-a-choice logic is written twice; (4) public API is under-documented, the `.nan` first-frame trick is opaque, the preview comment is cut off; (5) the tests guard the single threshold for `isBeside` only, mirror the implementation in two expectations, and do not pin the stored strings; (6) the PR body claims more than the code verifies.
Read the three reviews in `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/P02c/r2/` (`contract.json`, `verification.json`, `maintainability.json`) first.

## Scope

May change: `packages/native/iPhone/PhoneLiveRootView.swift`; `packages/native/iPhone/ScreenPreviews.swift` (previews only); `packages/native/RemiKit/Sources/RemiUI/RemiSidebarPlacement.swift`; `packages/native/RemiKit/Tests/RemiKitTests/RemiSidebarPlacementTests.swift`; the PR body (extend it); one sentence in `packages/native/handoff/ipad-board.md` ("The rule" part 1, item 7).
No other file.

## Decided design

Settled, in this order, as atomic commits where natural:
1. One stable split view: delete `PhoneSidebarSplitStyle` and `usesProminentDetail`; `rootLayout` uses `.navigationSplitViewStyle(.balanced)` at every width exactly as it did on `develop`. Below 1000 pt the default is a hidden sidebar (so the Board keeps the whole width and shows several columns); if the person shows the sidebar below 1000 pt it narrows the Board, as the split view always has. The design's "comes over the content" is deliberately not implemented here, because it needs a style swap that rebuilds the shell; say so in the PR body and in the design doc sentence (item 7).
2. Record only the person's choices. A pure, public, tested rule in `RemiSidebarPlacement.swift`: given the visibility the split view asks for and the current effective visibility, return the explicit choice to record, or nil when nothing changed (a same-value write is never a choice). `.detailOnly` records hidden; `.all`, `.doubleColumn` and `.automatic` record shown. `toggleSidebar` (button and keyboard) records through the same helper with the opposite of the effective visibility. The binding setter calls the helper and writes `sidebarChoiceStorage` only for a non-nil result.
3. One source of truth: delete `columnLayout`, `effectiveColumnLayout` and the `RemiMacColumnLayout` use in this file; the binding getter and `showsSidebarToggle(sidebarHidden:)` read `sidebarPlacement.visibility`; one `private func recordSidebarChoice(...)` is the only writer of `sidebarChoiceStorage`.
4. First frame: make the unmeasured width explicit instead of `.nan`: `RemiSidebarPlacement.init(windowWidth: CGFloat?, explicitChoice:)` where nil means "not measured yet, treated as narrow (hidden unless the person chose shown)"; a nonfinite or negative width is also narrow. Document both on the init. The PR body says plainly: the first frame is hidden at every width and a wide iPad shows the sidebar after the first measurement (a visibility change only, no rebuild now that the style is fixed); `onGeometryChange` delivering its initial value is relied on and is supported by the Board's own preview, which resolved three columns from it, and it is unverified on a device.
5. Doc comments on every public member of `RemiSidebarPlacement` and its `ExplicitChoice` (the threshold and the precedence: no choice follows `RemiBoardColumns.sidebarBeside`, an explicit choice wins over the default visibility and over `isBeside` only through visibility; what `isBeside` means; what the storage strings are). American English, no em dashes.
6. Tests (`RemiSidebarPlacementTests`): the 0 to 2000 sweep (step 1) also asserts `visibility == (sidebarBeside(w) ? .all : .detailOnly)` and `isBeside == sidebarBeside(w)` with no choice, plus the fractional widths 999.5, 999.999 and 1000.001; replace the two mirrored explicit-choice expectations with literals (explicit shown at 744: visible, not beside; at 1000 shown: beside; explicit hidden at 1376: hidden, not beside); `nil`, `.nan`, `-1` and `.infinity` widths with each explicit choice; the stored strings are literal (`"shown"`, `"hidden"`) and `"Shown"`, `" shown"`, `"shown,hidden"`, `"all"` and `""` parse to nil; a table for the new choice-recording helper (`.detailOnly` while shown gives hidden, `.all` while hidden gives shown, `.doubleColumn` and `.automatic` give shown, every same-value write gives nil, a toggle from the default-hidden state at 744 gives shown).
7. Design doc: one sentence in "The rule" part 1 stating the balanced split is used at every width, that below 1000 pt the sidebar is hidden by default and narrows the Board when the person opens it, and that an overlay would need a state-preserving structure (slice 4 may revisit). The owner confirms this as a new decision (the manager records it).
8. Previews: rewrite the `RegularShellPreview` doc comment as complete sentences (the fixed canvases are window widths with a forced regular size class; the sidebar visibility comes from `RemiSidebarPlacement` and the style is the same `.balanced` as the shell); one style call, no if/else; name the two kept 1194 previews "Shell, 1194 pt" and "Shell, 1194 pt, dark".
9. The PR body: update everything above, state which behaviors have an automated test (the pure resolver and the recording helper) and which do not (the binding wiring, the toggle, the measurement), and that the visual and Device Hub checks were not run by the worker.
Not changing: nothing rejected.
The worker may choose: names of the new helper and parameters, test names.

Never do: a second 1000 constant; change the compact layout or the Mac; remove the system toggle fallback.

## Acceptance

1. Items 1 to 9 are done; the tests named exist and pass.
2. `PhoneSidebarSplitStyle` and `usesProminentDetail` are gone, `rootLayout`'s regular branch has `.navigationSplitViewStyle(.balanced)` as on `develop`, and the compact branch is unchanged.
3. `columnLayout` and `effectiveColumnLayout` are gone; `sidebarChoiceStorage` has one writer.
4. The build script ends with a receipt for the final head.
5. The PR body states what changed, the deliberate non-overlay, the first-frame cost, and what is and is not tested.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiSidebarPlacementTests` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected <final head> --receipt-dir /Volumes/S1/derived/remi-board-sidebar-receipt` (no `--simulator`) ends with `Receipt:` for that head; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing.

## Stop conditions

Keeping one stable style needs a change outside the scoped files; a test outside the scoped files fails.

## Report

The preamble's report, plus one line per item above with the commit that did it, the receipt path, and the final head after one push.
