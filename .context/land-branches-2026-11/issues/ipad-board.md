## Problem

On iOS 27.2 an iPad connected to an external display can run apps in a large, Mac-like window. The native iPhone app's regular-width shell (#1629) shows one readable column there, so the dashboard wastes the space. The owner wants the iPad dashboard to show session cards in multiple columns and rows, resizable like the Mac Board (epic #1708, #1729).

## Starting point (verified 2026-11-12 on develop 1cbdcc6f)

- `RemiLayoutMode` (`packages/native/RemiKit/Sources/RemiUI/RemiLayoutMode.swift`) resolves `compact` or `regular` from the horizontal size class, with a 700-point fallback; `remiReadableColumn` caps content at the readable width.
- The Mac Board is `packages/native/RemiKit/Sources/RemiUI/RemiBoard.swift` (686 lines) in the shared RemiUI module.
- The RemiPhone target's build settings list `TARGETED_DEVICE_FAMILY = "1,2"` (Debug and Release), while #1629 recorded "device family stays iPhone (owner decision for iPad later)". Which one ships today is to be verified, not assumed.

## Scope

1. Design (one short doc): what the iPad window and scene model allows on iOS 27.2 with and without an external display (window sizes, resizing, scenes, size classes), verified against current Apple documentation and the simulator; how much of `RemiBoard` can be shared; the column and row rules; the device-family decision for the owner.
2. Implementation in slices after the owner approves the design, each with visual acceptance per `packages/native/VISUAL-ACCEPTANCE.md` (exact-commit receipt, standard text size and Accessibility 5, light and dark, reduced transparency and motion) and the parity rules in `packages/native/PARITY.md`.

## Not in scope

Mac Board changes beyond extracting shared pieces; Watch, widgets, Live Activities; any wire change.

## Acceptance

The design is approved by the owner; each implementation PR carries its visual-acceptance receipt and screenshots for the iPad sizes the design names.
