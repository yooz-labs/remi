# Native visual acceptance

Visual acceptance is tied to the exact commit under review. A screenshot from a
different checkout, build, or simulator does not satisfy this gate.

## Before capturing

1. Record `git rev-parse HEAD` from the feature worktree.
2. Build that worktree's `RemiNative.xcodeproj` and confirm the installed app is
   from the same build.
3. Use an iPhone simulator at a standard text size, then repeat the affected
   screen at Accessibility 5. Test both light and dark appearances.
4. Repeat affected translucent surfaces with Reduce Transparency enabled and
   animated state changes with Reduce Motion enabled.

## Interaction checks

- Every visible control performs an action; no preview-only default callback is
  accepted in production UI.
- Tap targets remain at least 44 by 44 points even when their visual treatment
  is compact.
- Long labels wrap without clipping, overlapping, or forcing horizontal scroll.
- Selection is communicated once, without nested borders or duplicate shapes.
- Pending, sending, answered elsewhere, failed, empty, and disconnected states
  are distinguishable without relying on color alone.
- VoiceOver labels describe the action and do not read decorative icons.
- Keyboard focus, Escape/cancel, and default actions work on Mac.

## Required evidence

Capture the changed screen at standard size and its highest-risk variant (long
content, Accessibility 5, or reduced effects). Record the commit, device, OS,
appearance, text size, result, and any accepted limitation in the pull request.
