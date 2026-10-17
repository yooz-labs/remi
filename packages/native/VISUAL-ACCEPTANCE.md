# Native visual acceptance

Visual acceptance is tied to the exact commit under review. A screenshot from a
different checkout, build, or simulator does not satisfy this gate.

## Before capturing

1. Commit the native changes. Exact acceptance rejects a dirty native tree.
2. Run `packages/native/scripts/build-exact-native.sh --expected <commit>`. It
   builds both schemes from that worktree, embeds the full commit in each app,
   verifies both bundles, and writes `acceptance-receipt.txt` with the source,
   Xcode, scheme, destination, and bundle hashes.
3. For iPhone runtime acceptance, boot the intended simulator and add
   `--simulator <device-identifier>`. The verifier uses Xcode's local simulator
   signing so Keychain-backed startup works, installs the built app, and
   independently checks the commit embedded in the installed bundle before
   evidence is used.
4. Use `packages/native/scripts/open-exact-xcode.sh --expected <commit>` when
   opening Xcode. This refuses a different or dirty native checkout.
5. Use an iPhone simulator at a standard text size, then repeat the affected
   screen at Accessibility 5. Test both light and dark appearances.
6. Repeat affected translucent surfaces with Reduce Transparency enabled and
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
content, Accessibility 5, or reduced effects). Attach the generated receipt and
record the screenshot filename, device, OS, appearance, text size, result, and
any accepted limitation in the pull request. Evidence without a matching bundle
commit and receipt is stale and must be rejected.
