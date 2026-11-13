# Native chat following (#1568)

The owner reported that signed iPhone build 13 loads history but does not
automatically show the latest activity. The phone check also showed older
entries after loading. Both native screens only bound a top entry and refreshed
search state; neither requested initial or growing latest content.

The correction shares SwiftUI scroll behavior between the two native screens.
Fresh or delayed history starts at the latest activity. Appended entries,
streaming growth and viewport reflow stay followed while the reader remains
near the bottom, using the web client's existing 100-point threshold.
User interaction takes priority over layout following. Search, specific-question
focus and restored review positions pause following. Both screens expose Latest;
the jump targets the padded conversation container, rather than the start of a
potentially long final entry.

The standalone renderer control compiles a byte-identical copy of the shipping
MacSessionDetail with its actual RemiUI dependency. It uses only owned fixture
content and a real SwiftUI/AppKit window and event loop. It does not read owner
identity, sessions or credentials. Its launcher owns a four-minute deadline and
signal cleanup. Run it with the selected Xcode and an evidence directory:

```sh
DEVELOPER_DIR=/path/to/Xcode.app/Contents/Developer \
  bash scripts/test-native-chat-scroll.sh /tmp/remi-scroll-evidence
```

Before the correction, the rendered long history started 6,351 points above its
actual bottom. From a verified bottom position, append and streaming growth
left content below the viewport; delayed history also started at the top.
The fixture accounts for the composer's 76-point scroll inset with AppKit's
actual constrained scroll range. Original probes, including the earlier inset
measurement limitation, are retained in the release artifacts.

An unconditional bottom anchor followed new content but failed the older-history
reading control. The final control passes all 14 checks: ten behavior cases
(initial history, append, growth, resize, history review, delayed history,
session replacement, explicit question focus, selecting Latest from history and
following the next append) plus four setup controls. The Latest interaction uses
the actual rendered toolbar control's Command-Down shortcut in the owned window;
it never reproduces the action closure or manually moves the viewport afterward.
A separate owned copy with only the Latest action disconnected fails exactly
those two interaction cases; the other 12 still pass. The gates were not relaxed
to accept the partial candidates.

Native package tests, native Mac build/tests and iPhone simulator build pass.
The separate owned source-hub/Worker run passes with four remaining configured
source/security opt-in skips. The renderer is a separate local gate, not claimed
as a hosted or physical-iPhone result. The owned iPhone preview built and launched;
Simulator was not exposed to the connected UI controller, so interactive preview
acceptance is not claimed. Repeat the original case on signed build 14 before
claiming phone acceptance.

Marketing version remains 0.2.0. The existing version script advances build 14
and its legacy stamps; the native archive script applies and verifies that shared
version at export. CLI 0.8.0 publication proceeds independently. The change needs
fresh hosted checks and an independent review before merge into develop.
