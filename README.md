# Remi

> Your agents need you. Yes or No.

Remi is a cross-platform monitor for Claude Code sessions. Run your AI agents on any machine, walk away, and stay connected from your phone, tablet, or browser. Get notified when Claude needs input. Respond with a tap. Never lose a session.

## The Problem

You start a Claude Code session on your workstation. It's working on a complex task. You need to leave. Your options today: keep the terminal open and hope nothing goes wrong, or kill it and start over later.

## What Remi Does

**1. Session Persistence** - Like tmux for AI agents. Close your terminal, your session survives. Detach with `Ctrl+B d`, reattach from anywhere with `remi attach`.

**2. Multi-Machine Discovery** - Run agents across multiple machines. One command to see everything: `remi ls --network`. **Opt-in since #880:** the daemon binds `127.0.0.1` by default, and mDNS does not advertise on a loopback bind — so discovery finds nothing until you set `daemon.bind` (and read the auth warning that comes with it).

**3. Chat Interface** - Monitor your agents from a clean chat view on your phone. See the conversation without the code noise. Answer questions, approve actions, keep things moving.

## Quick Start

```bash
# Install
bun install -g @yooz-labs/remi

# The installed binary is still named `remi`
# If you previously installed the unrelated unscoped package, remove it first:
bun remove -g remi

# Start Claude Code with Remi (session persists if terminal closes)
remi -- claude

# Detach: Ctrl+B d
# List sessions
remi ls

# Reattach
remi attach macbook/remi/main

# See sessions on all machines
remi ls --network

# Attach to a remote session
remi attach --host 192.168.1.5 macbook/remi/main
```

### From Your Phone

1. Open the web app or install the mobile app (iOS/Android)
2. Connect via local network, connection code, or direct address
3. Monitor and respond to all your agent sessions

## Features

- **Session persistence** - Survives terminal close (SIGHUP), detach/reattach like tmux
- **Human-readable session names** - `hostname/project/branch` instead of UUIDs
- **LAN discovery** - mDNS/Bonjour finds Remi daemons on your network, once you widen `daemon.bind`. Not on by default (#880): a stock daemon is loopback-only and does not advertise
- **Multiple connection methods** - Direct WebSocket, relay via Cloudflare, SSH tunnel, Tailscale
- **Chat view** - Clean conversation interface without terminal noise
- **Live updates** - Agent messages stream in real-time as work progresses
- **Cross-platform** - iOS, Android, Web, macOS, Windows, Linux
- **macOS menu-bar app** - a status "r" tracking live connections plus the full web UI in a native window; see [docs/MACOS_APP.md](docs/MACOS_APP.md)
- **Notifications** - Push alerts when Claude needs your input
- **Encrypted relay, when authenticated** - with an authenticated permanent code (`--auth --permanent-code`, or `[auth] enabled = true` plus `--permanent-code`), relay traffic is end-to-end encrypted (P-256 ECDH signed by each side's Ed25519 identity, AES-256-GCM) and the Cloudflare Worker cannot read it. The default rotating-code mode never derives session keys, where the daemon **refuses to send** rather than downgrade, and **accepts unencrypted inbound messages** — so the relay does not currently work end to end without auth, and what a client did send arrived in the clear (#881). Even when encrypted, the Worker still sees the room code and who talks to whom and when: this hides content, not metadata
- **No cloud dependency** - direct connections never touch a server at all. On a stock install only the SSH tunnel works out of the box: LAN and Tailscale direct need `daemon.bind` widened first (#880). Do **not** use `tailscale serve` for this — it is a same-host reverse proxy, so every tailnet peer arrives as `127.0.0.1` and inherits the loopback auth exemption (#869). The relay is the other exception, and see the caveat above

## Connection Methods

```
Phone/Browser ──► Direct WebSocket (same network, Tailscale, VPN — needs daemon.bind widened)
                ──► SSH Tunnel (ssh -L 28765:localhost:28765 server)
                ──► Relay (connection code, works from anywhere)
```

## Architecture

```
┌─────────────────────┐                      ┌─────────────────────┐
│   Your Phone        │                      │   Your Dev Machine  │
│   (Remi App)        │◄════════════════════►│   (Remi Daemon)     │
│                     │   WebSocket / Relay   │   mDNS: _remi._tcp │
│   Chat View         │   (end-to-end enc.)  ├─────────────────────┤
│   Session List      │                      │   PTY Manager       │
│   Notifications     │                      │   Session Registry  │
└─────────────────────┘                      │   Transcript Parser │
                                             └──────────┬──────────┘
                                                        │ PTY
                                             ┌──────────▼──────────┐
                                             │   Claude Code CLI   │
                                             └─────────────────────┘
```

## Tech Stack

- **Backend:** Bun + TypeScript, native PTY support
- **Frontend:** React + Vite + Capacitor (iOS/Android/Web)
- **Transport:** WebSocket (direct) or Cloudflare Workers relay
- **Discovery:** mDNS/Bonjour (`_remi._tcp`), off unless `daemon.bind` is non-loopback
- **Protocol:** Structured messages with delivery states and deduplication

## Development

```bash
bun install           # Install deps + set up pre-commit hooks
bun run dev           # Web dev server
bun run daemon        # Start Remi daemon
bun test              # Run tests (854 tests)
bun run lint          # Biome check
bun run typecheck     # TypeScript check
```

## Roadmap

See `.context/plan.md` for the detailed development roadmap.

## License

Source code is licensed under [**PolyForm Shield 1.0.0**](LICENSE.md). You can:

- Read, fork, modify, and use it for any purpose **except** building a competing product.
- Embed it in apps that aren't direct Remi substitutes.
- Contribute back via PRs.

You cannot offer a re-skinned commercial fork of Remi. For the strategic rationale, see [`yooz-engine/LICENSING.md`](https://github.com/yooz-labs/yooz-engine/blob/main/LICENSING.md).

For commercial-use or dual-license inquiries: **dev@yooz.info**.

## Contributing

PRs welcome. Sign your commits with `Signed-off-by: Your Name <you@example.com>` (DCO style); see [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: see [`SECURITY.md`](SECURITY.md).

---

*Part of the [Yooz ecosystem](https://github.com/yooz-labs). Sovereign Intelligence. Built for the skeptical.*
