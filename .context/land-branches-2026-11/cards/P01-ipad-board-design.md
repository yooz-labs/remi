# Card P01: iPad adaptive multi-column Board, design

Status: ready
Tier: lead
Timebox: M, 1 day; escalate at 2 days
Needs: xcode, simulator
Depends: L99 (all landing steps done or dropped); the iPad issue filed (issues-to-file.md); its number is a live fact, called ISSUE below
Branch: `feature/issue-ISSUE-ipad-board` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/ipad-board` (the manager creates it with `git worktree add -b`, runbook section 5)
Plan: plan.md section 5.1; checkpoint CP3

## Goal

A short design doc, verified against current Apple documentation and the iPad simulator, that says how the iPad app shows session cards in multiple resizable columns and rows in large windows (including an iPad driving an external display on iOS 27.2), what it reuses from the Mac Board, and what the owner must decide; no implementation code.

## Context

- Owner context: on iOS 27.2 an iPad connected to a second monitor can expand any app to a large, Mac-like window; the owner wants the iPad dashboard to show cards in multiple columns and rows, resizable like the Mac Board, not one column.
- Verified on develop `1cbdcc6f`: #1629 (closed) gave the iPhone app a regular-width shell with one readable column (`packages/native/RemiKit/Sources/RemiUI/RemiLayoutMode.swift`, `remiReadableColumn`); the Mac Board (epic #1708, #1729 merged) is `packages/native/RemiKit/Sources/RemiUI/RemiBoard.swift` in the shared RemiUI module.
- Contradiction to resolve: #1629 recorded "device family stays iPhone (owner decision for iPad later)", yet `Remi.xcodeproj` sets `TARGETED_DEVICE_FAMILY = "1,2"` for RemiPhone in Debug and Release. Find out what ships and what the App Store listing implies.
- Read first: `packages/native/AGENTS.md`, `packages/native/DESIGN.md`, `packages/native/PARITY.md`, `packages/native/VISUAL-ACCEPTANCE.md`, `packages/native/PLATFORM-KNOWLEDGE.md`, `RemiBoard.swift`, `RemiLayoutMode.swift`.
- Precondition: the Xcode MCP server answers on this host (it was not responding at the coordinator's last check). Check it first; if it does not answer, use `xcrun simctl` and `xcodebuild` directly and say so.
- Never connect a simulator to the owner's real hub on port 18765 (`packages/native/AGENTS.md`).

## Scope

May change: a new design doc `packages/native/handoff/ipad-board.md` (or the location `packages/native/AGENTS.md` names for designs), and screenshots under `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/P01/`.
No Swift source, project or scheme changes.

## Decided design

Settled: design only; the doc separates verified facts (with the Apple documentation URL and date read, or the simulator run) from assumptions; it proposes implementation slices small enough for one PR each, each with its visual-acceptance gate (devices, sizes, text sizes, appearances); it reuses `RemiBoard` pieces where the Mac and iPad share behavior, and names what cannot be shared.
The lead may choose: the column and row rules, the resize model, and how many slices.

## Acceptance

1. The precondition result (Xcode MCP answered, or the fallback used) is in the doc.
2. Apple documentation for iPad windowing, scenes, size classes and external displays on the current SDK is cited with URLs and the date read; any claim about iOS 27.2 behavior not found in docs is marked unverified.
3. Simulator evidence: `xcrun simctl list devices available | grep -i ipad` output, and at least two screenshots of the current RemiPhone build on an iPad simulator (a full-screen size and the smallest regular-width window the design targets), built with `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone -destination 'platform=iOS Simulator,name=IPAD_NAME' -derivedDataPath /Volumes/S1/derived/remi-ipad-board -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build` (IPAD_NAME from that list), installed with `xcrun simctl install` and captured with `xcrun simctl io booted screenshot`.
4. The doc ends with owner decisions as numbered questions with a recommended option each (at least: iPad device family and listing; minimum window width for two columns).
5. A docs-only PR into `develop`, "Part of #ISSUE"; the manager does not merge it before the owner approves at CP3.

## Gates

`typos packages/native/handoff/ipad-board.md` is clean; `git diff --check origin/develop...HEAD` prints nothing.

## Stop conditions

The design needs a wire or protocol change; the simulator cannot run the app (report the error); a visible GUI run would be needed (it needs the owner's announced consent: stop and ask).

## Report

The preamble's report, plus the screenshot paths and the owner questions.
