# Remi Development Plan

## Completed Work

### Remote Connectivity via Relay (PR #15, Issue #10)
Initial implementation of relay-based remote access:
- Signaling server on Cloudflare Workers + Durable Objects
- `ConnectionRoom` handles register/join/relay message forwarding
- Daemon `SignalingClient` and `RelayAdapter` for signaling connection
- Web client `signaling-client.ts` for code-based remote connection
- Relay-first approach (no WebRTC needed; signaling server forwards all messages)

### tmux-style CLI (PR #18)
- `remi ls` lists running sessions
- `remi attach <id>` attaches to a session in terminal

### Daemon Signaling Integration (PR #23, Issue #21)
Comprehensive fix and hardening of remote access. Four phases:

**Phase 1: Signaling Server Hardening**
- Fixed critical code mismatch bug: room code now derived from URL path, not randomly generated
- Fixed Durable Object hibernation bug: state persisted to storage, peer roles tracked via WebSocket attachments
- Added per-IP rate limiting (10 connections/minute, fixed-window)
- Tightened room limit to 2 peers
- Cleaned up legacy `DeviceRoom` DO via migration v3

**Phase 2: Daemon Always-On Signaling**
- Persistent connection codes in `~/.remi/connection-code` (`CodeStore` class)
- Unambiguous character set: `ABCDEFGHJKMNPQRSTUVWXYZ` + `23456789` (no 0/O/1/I/L)
- Relay adapter starts automatically (no `--remote` flag needed)
- `--no-relay` opt-out flag added
- `remi code` prints current code; `remi code --refresh` generates a new one

**Phase 3: Web Client Relay Fix**
- All message types now route through relay when in relay mode (was only `hello` before)
- Connection mode tracking (`direct` vs `relay` state)
- `relaySend()` wrapper dispatches to signaling client
- Relay connection status shown in UI
- Error handling for dynamic import and disconnected relay

**Phase 4: Testing**
- `code-store.test.ts`: load/save/refresh, permissions, invalid formats, ambiguous chars
- `signaling-client.test.ts`: connect with provided code, pattern validation
- `rate-limiter.test.ts`: allow/block thresholds, window reset
- 671+ tests passing, CI green

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    REMI CLIENT (Phone/Browser)                   │
│  React + Capacitor (iOS/Android/Web/Desktop)                     │
│  Chat View (xterm.js) | Session List | Notifications             │
└──────────┬───────────────────────────────┬──────────────────────┘
           │ Direct WebSocket              │ Relay (via signaling)
           │ (LAN/Tailscale/VPN)           │ (remote, any network)
           │                               │
┌──────────▼───────────────────────────────▼──────────────────────┐
│                 REMI DAEMON (on dev machine)                     │
│  PTY Manager | Session Registry | Event Parser                   │
│  WebSocket :28765 | RelayAdapter (always-on)                     │
│  Persistent code: ~/.remi/connection-code                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │ PTY
┌──────────────────────────▼──────────────────────────────────────┐
│                      CLAUDE CODE CLI                             │
└─────────────────────────────────────────────────────────────────┘

Relay path:
  Daemon ←→ wss://remi-signaling.dev-941.workers.dev ←→ Web Client
  (register+code)        (Durable Object room)        (join+code)
```

## Deployments

| Service | URL | Deploy Command |
|---------|-----|----------------|
| Signaling | `wss://remi-signaling.dev-941.workers.dev` | `cd packages/signaling && npx cfman wrangler --account yooz-labs deploy` |
| Web App | `https://remi-app.pages.dev` | `cd packages/web && bun run build && npx cfman wrangler --account yooz-labs pages deploy dist --project-name remi-app --branch main` |

## Key Files

| File | Purpose |
|------|---------|
| `packages/signaling/src/connection-room.ts` | Durable Object: room state, hibernation-safe, peer management |
| `packages/signaling/src/index.ts` | Worker entry: routing, rate limiting, CORS |
| `packages/signaling/src/rate-limiter.ts` | Per-IP fixed-window rate limiter |
| `packages/daemon/src/remote/code-store.ts` | Persistent connection code storage |
| `packages/daemon/src/remote/signaling-client.ts` | WebSocket client for signaling server |
| `packages/daemon/src/remote/relay-adapter.ts` | Bridges signaling to daemon adapter system |
| `packages/daemon/src/cli.ts` | CLI entry: daemon start, `remi code`, `remi ls`, `remi attach` |
| `packages/web/src/App.tsx` | Web client: direct + relay connection modes |
| `packages/web/src/lib/signaling-client.ts` | Web signaling client for relay mode |

## Future Work

### WebRTC Upgrade (P2P)
- Use signaling server for initial handshake only
- Browser-native WebRTC DataChannel for web client
- Research `node-datachannel` Bun compatibility for daemon
- Keep relay as fallback for symmetric NAT

### Authentication
- Connection codes provide room isolation but no auth
- Consider TOTP or challenge-response for daemon identity verification
- Rate limiting provides basic abuse protection for now

### Notifications
- Push notifications for mobile (Capacitor)
- Question detection alerts when agent needs input
