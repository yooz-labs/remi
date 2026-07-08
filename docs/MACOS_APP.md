# Remi for macOS (menu-bar app)

A sandboxed menu-bar app that surfaces the Remi hub on your Mac without a
terminal: a rounded-square "r" in the menu bar whose fill tracks live
connections, and a window hosting the full Remi web UI. Part of epic #648.

```
menu bar:  [r]  idle (thin outline)      no clients connected
           [r]  bold "r"                 local client attached
           [■]  filled, "r" knocked out  remote client(s) connected
           [r]  dimmed                   hub not running
```

## Relationship to the hub

The app is an **attach-only client**. The hub daemon (`remi serve`) does all
the work; the app discovers it by scanning `127.0.0.1:18765-18784`, connects
in query mode (it never counts as a "client" in the icon state), and embeds
the web UI pointed at it. Session daemons spawned by the hub are discovered
through the hub's session list, exactly like the iPhone app does it.

## What the app deliberately cannot do

The app runs in the App Sandbox (required for TestFlight/App Store) with the
network-client capability only. It **cannot**:

- **Start the hub.** Install the hub's LaunchAgent once with `remi --install`
  (starts at login, crash-restarts), or run `remi start` for the current
  session. The menu offers a copy button for the install command when no hub
  is running.
- **Stop the hub.** "Quit Remi" quits the app; the hub and every session it
  supervises keep running. Stop the hub with `remi stop` (running session
  daemons keep serving even then). A protocol-level stop from the app is
  tracked in #747, blocked on #535.
- Read `~/.remi` or signal processes. Everything it knows arrives over the
  loopback WebSocket.

## Lifecycle (#651)

- Closing the window hides the UI; the menu-bar item and your hub stay up.
- There is no Dock icon (accessory app); the menu-bar "r" is the app.
- "Open Remi at Login" registers the APP as a login item (SMAppService).
  This is independent of the HUB's autostart — the LaunchAgent from
  `remi --install`. For the full always-on setup, enable both.

## Building from source

```bash
bun run build:macos-web        # build + stage the web UI into the app
open packages/macos/Remi.xcodeproj
```

Tests: `xcodebuild test -project packages/macos/Remi.xcodeproj -scheme Remi`.
The real-hub integration tests need `TEST_RUNNER_REMI_TEST_BINARY` pointing
at a remi binary (plain env vars never reach the xctest process).
Regenerate the Xcode project after target/file changes with
`scripts/generate-macos-project.sh`; regenerate the menu-bar icon PDFs from
their SVG sources with `scripts/generate-menubar-icons.sh`.
