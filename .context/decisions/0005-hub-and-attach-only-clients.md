# ADR 0005: Session-less hub + thin attach-only native clients

**Status:** accepted
**Date:** 2026-07-07
**Owner:** Yahya

## Context

`remi start` used to spawn a session daemon in the cwd, polluting the app
with junk conversations and leaving no always-on entry point for clients.
The macOS app needed a daemon to talk to, but a sandboxed App Store app
cannot spawn processes, read `~/.remi`, or write LaunchAgents.

## Decision

The hub (`remi serve` / `remi start`) is a session-less supervisor: it binds
the well-known port (18765, 20-port probe), runs shared services, serves the
session list, and spawns child session daemons — never Claude itself. Native
apps are thin attach-only clients that discover the hub by loopback port
scan and never manage its lifecycle: hub autostart is `remi --install`
(LaunchAgent, KeepAlive.SuccessfulExit=false), distinct from the app's own
SMAppService login item.

## Consequences

One durable endpoint for all clients; `remi stop` stops only the hub. The
app can only guide the user to commands (#773's onboarding panel + Settings)
— it cannot start or stop the hub (protocol-level stop is #747, blocked on
the loopback auth work #535). `hello_ack{sessionId: null}` distinguishes a
hub from a session daemon; `daemon-status.json` belongs exclusively to the
hub, session daemons write `status-<port>.json`.

## Alternatives considered

- **App bundles/spawns the daemon:** forces the daemon into the sandbox
  (PTYs need broad fs access) and fails App Store validation (ITMS-90296);
  rejected — same wall as the ecosystem engine-packaging doc.
- **Apple Events terminal handoff from the app:** viable follow-up for
  one-click setup (design A on #773), deferred.

## Receipts

Epic #648 (0.6.19, closed 2026-07-10); #542, #649, #650, #651, #773 (PR
#777); `docs/MACOS_APP.md`. Detail formerly in
`.context/hub-epic-648-research.md`, `plan-macos-app-648.md`,
`plan-773-hub-setup.md` (pruned 2026-07-10).
