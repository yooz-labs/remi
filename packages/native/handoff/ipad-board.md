# iPad and iPhone Duo Board: design (#1745)

Status: design for the owner to approve; no Swift source changes.
Written 2026-11-13 against `develop` `b4a53f0d` (0.8.3-dev.26) and Xcode 27.2.

## Goal

The native app shows session cards in several columns, and as many rows as the content needs, whenever the window is wide: an iPad full screen, an iPad window the person made large (including on an external display on iPadOS 27.x), and the unfolded iPhone Duo.
One column stays exactly as it is today wherever the window is narrow, so the iPhone is unchanged.
The Board decides from the width it is given, never from the device, and an iPad in portrait gets several columns as well (owner requirement, 2026-11-13).

## Precondition result

The Xcode MCP server answers on this host (2026-11-13): `XcodeOpenWorkspace` on `packages/native/Remi.xcodeproj` returned a workspace identifier after the owner approved the agent in Xcode.
The builds and runs below used `xcodebuild`, `xcrun simctl` and the exact-build script, as the card and `VISUAL-ACCEPTANCE.md` prescribe.

## Verified facts

Apple's text, with sources and what was not found, is recorded once in [PLATFORM-KNOWLEDGE.md](../PLATFORM-KNOWLEDGE.md), "Resizable windows, iPad external displays and iPhone Duo".
The ones this design relies on:

- Layout follows size classes and the space the scene has, never the idiom, the device or the orientation (WWDC26 session 278; the iPhone Duo talks).
- The iPhone Duo inner display reports regular width and regular height; the outer display behaves like other iPhones. Folding and unfolding resize the app (iPhone Duo talk 111461 and prepare page).
- The iOS 27.1 SDK lets an app use the whole inner display (prepare page).
- `UIRequiresFullScreen` no longer opts an app out of resizing from the iOS 27 SDK (TN3192).

Verified in this repository on 2026-11-13:

| Fact | Evidence |
|---|---|
| The iPhone target already runs on the iPad as a native iPad app: `TARGETED_DEVICE_FAMILY = "1,2"` in Debug and Release since 2026-10-25 (`00c8a68e`, #1239); `Info.plist` declares all four iPad orientations and no `UIRequiresFullScreen`, and `NativeBundleMetadataTests.theIPadDeclaresEveryOrientation` pins it. | `project.pbxproj`, `iPhone/Info.plist`, `git log -S`; the screenshots below show the app filling an iPad |
| #1629 said "device family stays iPhone (owner decision for iPad later)" and shipped the regular-width shell and the readable column; that sentence is stale. | issue #1629 against the project file |
| The regular-width shell is a `NavigationSplitView` with a 340 pt sidebar (`RemiTheme.Size.sidebarWidth`) and the destination beside it; `RemiLayoutMode` resolves compact or regular from the horizontal size class, with a 700 pt fallback only when no size class is given. | `RemiLayoutMode.swift`, `PhoneLiveRootView.rootLayout` |
| The iPhone and iPad Board is `PhoneBoardScreen`: one `LazyVStack` of cards inside `remiReadableScrollColumn()`, capped at 720 pt (`readableContentWidth`), in the density the person chose. | `PhoneBoardScreen.boardScroll` |
| The shared engine already does multi-column placement from a width: `RemiBoardOrder.columnCount(width:minimumTile:spacing:)` (340 pt tiles, 12 pt spacing, at most 6 columns), `columns(heights:count:)` (each card goes under the shortest column), `layout` and `canvasSize` for the Mac's freeform frames. The Mac `MacCommandCenter` is the only caller of `layout` and `canvasSize`; `PhoneBoardScreen` uses neither. | `RemiBoard.swift`, `MacCommandCenter.swift` |
| Row, Small, Medium and Long are `RemiTileSize` densities with estimated heights 96, 260, 420 and 640 pt; the phone offers Compact (row), Medium and Long. | `RemiTileSize` |
| Held state (the draft, the focused card, the shown order) lives in `@State` in the Board and above the compact and regular switch (#1629 fixed this for the draft). | `PhoneBoardScreen`, `PhoneLiveRootView` |

Evidence (`P01/` in the artifact folder; exact build of `b4a53f0d`, receipt `P01/receipt/acceptance-receipt.txt`, Xcode 27.2; the iOS 27.2 runtimes installed on 2026-11-13, `24B114` for iPad and iPhone and `24B91016s` for the iPhone Duo only):

- `simctl-devices.txt`: the iPad simulators listed on 2026-11-13 before the runtimes were replaced. The iPads now run on iOS 27.2 (`Remi P01 iPad Pro 13`, `Remi P01 iPad mini`), the Duo on `Remi P01 Duo`.
- `ipad-pro13-landscape-no-machine.png` and `ipad-mini-portrait-no-machine.png`: the exact build on an iPad Pro 13-inch (M5) full screen in landscape and on an iPad mini (A17 Pro) in portrait, empty state. The sidebar takes 340 pt at the first and shows over the Board at the second.
- `preview-board-*.png`: Xcode renders (`RenderPreview`, no hub, the existing "Board" preview with sample data) of today's Board: `ipad-pro13-landscape`, `ipad-pro13-portrait`, `ipad-mini-portrait`, `duo-inner` and `duo-outer`. At every width above 720 pt the Board is one 720 pt column with the rest of the screen empty; that is the problem this design solves. The preview shows the Board alone, not the split-view shell, so the sidebar is not in these images.
- Display sizes from the simulator device profiles (`capabilities.plist`, Xcode 27.2; these are the simulator's definition, not an Apple statement about the real device): iPad Pro 13-inch (M5) 2064 by 2752 px at 2x, so 1032 by 1376 pt; iPad mini (A17 Pro) 1488 by 2266 px at 2x, 744 by 1133 pt; iPhone Duo outer display 1398 by 2034 px at 3x, 466 by 678 pt; iPhone Duo inner display 2007 by 2853 px at 3x, 669 by 951 pt; and a "Resizable" scene display of 7680 by 4320 px at 3x that the Device Hub uses for resizable windows.
- One thing to check in the real app: in `preview-board-duo-outer.png` the camera cutout covers the toolbar's more button. A navigation toolbar normally avoids the cutout, so this may be an artifact of the preview, but it is recorded because the iOS 27.1 SDK changed how bars sit on the Duo.
- The first launch of the app on an old iPad Pro simulator connected to the owner's real hub, because that simulator still held a machine the owner had authorized earlier. It was terminated, the app uninstalled, the screenshot deleted and the simulator later removed with its runtime. Any run on a simulator must start from an uninstalled app and may add only a throwaway hub on a port above 18790 (`AGENTS.md`, "The dev app must never talk to a real hub").

## Not run

- The Duo fold and unfold themselves: the previews render the inner and the outer display, but the hinge, the fold animation and a live window change were not driven. `simctl io screenshot` hangs on the Duo's several framebuffers and the mobile tool's agent does not start on it, so a live run needs Device Hub (a visible GUI run, question 6).
- An iPad on a real external display: no physical iPad and display were available here. The owner reports (not Apple text, see PLATFORM-KNOWLEDGE) that on iPadOS 27.2 a window shrinks to almost phone width, grows to full screen and continues onto the external display as a larger window. The design therefore treats the external display as a large window of the same scene, so the Board must work at every width from phone-like to the external display's, and keeps a verification gate with Remi itself (slice 5).
- A drag-resized iPad window: the resizable simulator in Device Hub was not driven; the narrowest window the design targets is computed below.
- The app itself on the iPad with a populated Board: the previews stand in for it, because a populated app needs a throwaway hub with live sessions.

## Design

### The rule

Owner requirement (2026-11-13): an iPad in portrait gets several columns too, not only a wide landscape window.
Two things stood in the way of that with the first draft of this rule: a 340 pt sidebar beside the Board took a third of a portrait iPad, and a 340 pt minimum card width asked too much of what was left.
So the rule has two parts.

1. **The shell uses a balanced split view at every width. Below 1000 pt the sidebar is hidden by default, and opening it narrows the Board.** A person's explicit choice (shown or hidden) wins over the default and is kept per window. A future design that keeps the Board full width while the sidebar is open needs a state-preserving structure that slice 4 may revisit.
2. **The Board decides its column count from the width of its own pane**, measured where the Board is laid out (`onGeometryChange`), never from a device or the sidebar's assumed state:

`available = pane - 2 x 16 pt margin`
`columns = RemiBoardOrder.columnCount(width: available, minimumTile: 300, spacing: 12)`, at most 6, which is `floor((available + 12) / 312)`

The Mac keeps its 340 pt minimum for its freeform frames; the iPad and Duo Board uses a 300 pt minimum card.

| Window | Sidebar | Pane | Columns |
|---|---|---|---|
| iPhone, any | hidden | under 644 | 1 (unchanged) |
| iPhone Duo outer display, portrait, 466 pt | hidden | 466 | 1 |
| iPhone Duo inner display, portrait, 669 pt | hidden | 669 | 2 |
| iPhone Duo inner display, landscape, 951 pt | hidden | 951 | 2 |
| iPad mini, portrait, 744 pt | hidden | 744 | 2 |
| iPad mini, landscape, 1133 pt | beside | 793 | 2 |
| iPad mini, landscape, sidebar hidden | hidden | 1133 | 3 |
| iPad Air or Pro 11-inch, portrait, 834 pt | hidden | 834 | 2 |
| iPad Pro 13-inch, portrait, 1032 pt | beside | 692 | 2 |
| iPad Pro 13-inch, portrait, sidebar hidden | hidden | 1032 | 3 |
| iPad Pro 11-inch, landscape, 1194 pt | beside | 854 | 2 |
| iPad Pro 13-inch, landscape, 1376 pt | beside | 1036 | 3 |
| iPad Pro 13-inch, landscape, sidebar hidden | hidden | 1376 | 4 |
| Two columns need | | 644 | pane 644 pt (window 984 pt with the sidebar beside) |
| Three columns need | | 956 | pane 956 pt |
| Four columns need | | 1268 | pane 1268 pt |

Windows between 644 and 1000 pt wide are two columns without a sidebar beside them, and a window that a person drags down to almost phone width is one column with the sidebar hidden, exactly like the iPhone; from 1000 pt the sidebar sits beside the Board, and the iPad Pro 13-inch in portrait (1032 pt) is the narrowest such window, with two columns, or three if the person hides the sidebar.
At one column the screen is today's screen: same stack, same readable cap, same ordering, so no iPhone regression.
At two or more the readable cap does not apply to the whole pane; each column's cards fill their column (`(available - 12 x (columns - 1)) / columns`, at least 300 pt, except up to 24 pt divided by the column count less while a column is held) and the columns are centered when the cap on six columns is reached.
The iPhone Duo uses the same rule with the point widths from the simulator profile (466 pt outer, 669 by 951 pt inner): the unfolded display reports regular size classes, and below 1000 pt wide the sidebar is hidden by default, so the inner display gets two columns in portrait and in landscape.

### Placement

Placement packs by each card's phone card height (96, 240 or 440 pt). These are minimums because cards grow to fit their content at two or more columns, so columns can be unbalanced by design.
That keeps the existing rules intact: the order is frozen while someone writes (`isWriting`, `held`), and a column assignment does not move under a focused composer.
Reading order stays the order list; "send, then go to the next live card" (`RemiBoardOrder.next`) follows it, and a card in another column is scrolled to the same way (one vertical `ScrollView` holding the columns, `ScrollViewReader` unchanged).
The Needs-you cards still sort first, so they land at the top of the leftmost columns.
A card can span adjacent columns; placement chooses the window whose tallest occupied column is shortest, with ties going to the leftmost window.

### Resizing

At two or more columns, the corner handle previews and stores each card's Compact, Medium or Long height and adjacent-column span, snapping width to the nearest span.
The Mac's freeform frames (`RemiBoardFrame`: drag, snap to edges and a 24 pt grid, a 340 by 260 pt minimum, `reflow`) are pointer-first and are not ported in the first slices; whether to port them for pointer and keyboard use on iPad is question 3.
The window itself resizes continuously; the column count follows the pane width through `onGeometryChange`, with a small hysteresis (a column is added at its threshold and removed 24 pt below it) so a slow drag at a threshold does not flip layouts every frame.
During `isInteractivelyResizing` nothing animates except the column count change.

### Fold, unfold, Split View, external display

All of these are the same event, a size change: the Board never reads orientation or the device, and a size change must not rebuild a focused composer.
The Board keeps its `@State` above the column layout, cards keep stable ids across a column change, and a column change only moves cards.
A change between one and two columns still rebuilds the tiles in this slice because the one-column stack is a different container; slice 4 closes this with its focus-retention test.
A test pins the first of these: changing the width resolves a different column count for the same ordered list and the same keys.

### What is shared with the Mac and what is not

Shared in `RemiUI`: `RemiBoardOrder` (key, arrange, held order, visibility, feed, `columnCount`, `columns`), `RemiBoardState` (pins and sizes), `RemiTileSize` and the card views.
Not shared: the Mac canvas (`layout`, `canvasSize`, frames, drag and snap) and `MacCommandCenter`'s window state, which stay Mac-only until question 3 says otherwise.
The one new shared piece is a small pure resolver in `RemiUI` that turns a pane width and a sidebar state into a column count and a tile width, so the iPad and the Mac Board read the same rule and tests can pin it without a view.

### Selecting a session

Tapping a card opens the session in the destination as today, replacing the Board.
Showing the Board and the selected conversation side by side at very wide windows is a separate design (question 4) because it changes navigation, not layout.

## Slices

Each is one pull request into `develop`, with the visual gate from `VISUAL-ACCEPTANCE.md`: exact-commit receipt; an iPad full screen, the narrowest window that gets the layout the slice adds, and the iPhone Duo folded and unfolded once its runtime is available; standard text size and Accessibility 5; light and dark; Reduce Transparency and Reduce Motion for anything translucent or animated.

| Slice | What | Tests |
|---|---|---|
| 1 | The pure resolver in `RemiUI` (pane width to columns and tile width with the 300 pt minimum, the 1000 pt sidebar default, hysteresis) and its tests; no view change | Swift Testing: every row of the table above, both sides of each threshold (643 and 644, 955 and 956, 999 and 1000), the six-column cap, zero and negative widths |
| 2 | `PhoneBoardScreen` lays cards in the resolved columns, one column unchanged, and the shell's sidebar visibility follows the 1000 pt rule with the person's choice kept | a source test that one column renders the existing stack; previews at 3 widths; the visual gate above |
| 3 | Per-card density on iPad through the existing menu, including from a card in the second column | state tests for `sizes`; the visual gate |
| 4 | Fold and resize robustness: a draft and focus survive a width change; no animation storm at a threshold | a focus-retention test, a resizable-simulator drag recorded in the receipt |
| 5 | An iPad on a real external display and the Duo poses, recorded by the owner or on the Duo simulator | the receipt lists what was run and what was not |
| 6 (optional) | Pointer-first freeform frames on iPad, if question 3 says yes | reuse of `RemiBoardFrame` tests |

## Owner decisions

1. **Device family and listing.** The project already builds the iPhone target as a universal app (iPhone and iPad) and a test pins its iPad orientations; #1629's "stays iPhone" is stale. Recommended: confirm the iPad as a supported device and check in App Store Connect that the TestFlight and store listing show it. Alternative: set the family back to iPhone, which would run the app in iPhone compatibility mode on iPad and does not serve this goal.
2. **The card minimum and the sidebar threshold.** The owner requires multi-column in portrait, so the rule is a 300 pt minimum card and a sidebar that sits beside the Board only from 1000 pt windows. Recommended: exactly that. Alternative: a 320 pt minimum card (the iPad mini portrait still gets two columns, the Duo inner display in portrait gets one) or a 900 pt threshold.
3. **Freeform resizing on iPad.** Recommended: no, density presets only in slices 1 to 5, and revisit slice 6 after the owner has used it with a pointer. Alternative: port the Mac frames now.
4. **A selected session beside the Board.** Recommended: out of scope here; design it after slice 2 ships, because it changes navigation. Alternative: add it to this track.
5. **Where the sidebar toggle lives below 1000 pt.** Below 1000 pt the sidebar is hidden by default, and the system toggle in the navigation bar is the way to it; opening it narrows the Board. A left-edge swipe, as the phone drawer does, and a persistent compact rail of machine and session icons beside the Board at 600 to 1000 pt remain alternatives to decide later. Recommended: keep the system toggle.
6. **Duo poses through Device Hub.** The runtime is installed and the simulator device exists; the folded and unfolded poses can only be driven and captured in Device Hub, a visible GUI run. Recommended: the owner announces a session where this is done for slice 2 and the screenshots go into the receipt. Alternative: accept "not run" for the Duo until a real device is available.
7. **External display.** What iPadOS 27.x does with an app on an external display is not in the Apple text read. Recommended: the owner connects an iPad to a display once the first slice is on TestFlight and reports whether the window is resizable and interactive; slice 5 follows that result.
