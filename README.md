# Remi

> Your agents need you. Yes or No.

Remi is a cross-platform monitor for Claude Code sessions. Run your AI agents on any machine, walk away, and stay connected from your phone, tablet, or browser. Get notified when Claude needs input. Respond with a tap. Never lose a session.

## The Problem

You start a Claude Code session on your workstation. It's working on a complex task. You need to leave. Your options today: keep the terminal open and hope nothing goes wrong, or kill it and start over later.

## What Remi Does

**1. Session Persistence** - Like tmux for AI agents. Close your terminal, your session survives. Detach with `Ctrl+B d`, reattach from anywhere with `remi attach`.

**2. Multi-Machine Discovery** - Run agents across multiple machines. Remi discovers all your sessions on the local network automatically. One command to see everything: `remi ls --network`.

**3. Chat Interface** - Monitor your agents from a clean chat view on your phone. See the conversation without the code noise. Answer questions, approve actions, keep things moving.

## Quick Start

```bash
# Install
bun install -g remi

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
- **LAN discovery** - mDNS/Bonjour finds all Remi daemons on your network
- **Multiple connection methods** - Direct WebSocket, relay via Cloudflare, SSH tunnel, Tailscale
- **Chat view** - Clean conversation interface without terminal noise
- **Live updates** - Agent messages stream in real-time as work progresses
- **Cross-platform** - iOS, Android, Web, macOS, Windows, Linux
- **Notifications** - Push alerts when Claude needs your input
- **Encrypted** - TLS/DTLS transport encryption on all connections
- **No cloud dependency** - All data stays on your machines; relay only forwards encrypted blobs

## Connection Methods

```
Phone/Browser ──► Direct WebSocket (same network, Tailscale, VPN)
                ──► SSH Tunnel (ssh -L 28765:localhost:28765 server)
                ──► Relay (connection code, works from anywhere)
```

## Architecture

```
┌─────────────────────┐                      ┌─────────────────────┐
│   Your Phone        │                      │   Your Dev Machine  │
│   (Remi App)        │◄════════════════════►│   (Remi Daemon)     │
│                     │   WebSocket / Relay   │   mDNS: _remi._tcp │
│   Chat View         │   (TLS encrypted)    ├─────────────────────┤
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
- **Discovery:** mDNS/Bonjour (`_remi._tcp`)
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

MIT

---

*Part of the [Yooz](https://github.com/yooz-labs) ecosystem. Local-first, privacy-first, no compromises.*
