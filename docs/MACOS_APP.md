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

Reconnects back off exponentially (1 s doubling to a 30 s cap) after a hub
disconnects. The onboarding panel's "Check Again" button (`HubClient.rescanNow()`,
#773) triggers an immediate scan instead of waiting out that backoff; it is a
no-op while already scanning or connected, so it can never race the scheduled
reconnect into a duplicate socket. A failed manual rescan also cancels
whatever backoff timer was already pending before scheduling the next one, so
repeated "Check Again" clicks can't stack independent reconnect chains.

The main window only shows the onboarding panel before the client has EVER
connected to a peer. Once it has, the window keeps showing the web UI for the
rest of the app's lifetime, even through transient disconnects (a missed
ping, a brief network blip, a hub restart mid-upgrade) — those are the web
app's own problem to surface, not a reason to tear down and reload the
embedded WKWebView and lose client-side state.

## What the app deliberately cannot do

The app runs in the App Sandbox (required for TestFlight/App Store) with the
network-client capability only. It **cannot**:

- **Start the hub.** Install the hub's LaunchAgent once with `remi --install`
  (starts at login, crash-restarts), or run `remi start` for the current
  session. Before the app has ever found a hub, the main window shows an
  onboarding panel (#773) walking through installing `remi`, starting the
  hub, and setting up its login item, each with a one-click Copy button for
  the terminal command. The Settings scene (⌘,) repeats the login-item
  command alongside the current hub status for later reference.
- **Stop the hub.** "Quit Remi" quits the app; the hub and every session it
  supervises keep running. Stop the hub with `remi stop` (running session
  daemons keep serving even then). A protocol-level stop from the app is
  tracked in #747, blocked on #535.
- Read `~/.remi` or signal processes. Everything it knows arrives over the
  loopback WebSocket.

## Lifecycle (#651, Dock presence #785)

- Closing the window hides the UI; the menu-bar item and your hub stay up.
- The app launches as an accessory (no Dock icon, no Cmd-Tab entry) and
  stays that way whenever no app window is open — the menu-bar "r" is the
  app. When a window (the main web-UI window or Settings) becomes key, the
  app promotes itself to a regular app so it shows in the Dock and Cmd-Tab
  like anything else; when the last such window closes, it drops back to
  accessory. `ActivationPolicy.derive` is the pure window-count -> policy
  decision (`ActivationPolicy.swift`); `AppDelegate` wires
  `NSWindow.didBecomeKeyNotification`/`willCloseNotification` to it, plus
  one manual sync right after registering (launch-ordering race).
- "Open Remi at Login" registers the APP as a login item (SMAppService).
  This is independent of the HUB's autostart — the LaunchAgent from
  `remi --install`. For the full always-on setup, enable both.
- The main window never tears down its WKWebView once a hub has ever been
  seen (see "Relationship to the hub" above) — only the true first-run,
  never-connected case shows the onboarding panel instead.

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
