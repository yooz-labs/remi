# Remi

> Cross-platform Claude Code session monitor and responder

Remi lets you monitor and respond to Claude Code CLI sessions from your phone, tablet, or any browser; whether you're at a coffee shop, on a train, or away from your desk. When Claude asks a question, get notified and tap to respond.

## Features

- **Cross-platform** - iOS, Android, Web, macOS, Windows, Linux
- **Remote access** - Connect to your server from anywhere via Tailscale/SSH
- **Secure** - Transport encrypted via WireGuard (Tailscale) or SSH
- **Real-time** - WebSocket streaming for instant updates
- **Simple responses** - One-tap Yes/No buttons for common questions
- **Notifications** - Get alerted when Claude needs your input

## Architecture

```
┌─────────────────────┐                      ┌─────────────────────┐
│   Remi Client       │                      │   Remi Daemon       │
│   (Phone/Browser)   │                      │   (Your Server)     │
└──────────┬──────────┘                      └──────────┬──────────┘
           │                                            │
           │  ┌──────────────────────────┐              │
           └──┤ Tailscale / SSH / VPN    ├──────────────┘
              │ (WireGuard encryption)   │     WebSocket
              └──────────────────────────┘
                                                        │ PTY
                                           ┌────────────▼────────────┐
                                           │    Claude Code CLI      │
                                           └─────────────────────────┘
```

## Quick Start

### On Your Server

```bash
# Install Remi
bun install -g remi

# Start daemon (exposes WebSocket on port 8765)
remi daemon

# Or wrap Claude directly
remi claude "build a feature"
```

### Connect Securely

**Option 1: Tailscale (Recommended)**
```bash
# Install Tailscale on both devices
# Access via tailnet IP: ws://100.x.x.x:8765
```

**Option 2: SSH Tunnel**
```bash
ssh -L 8765:localhost:8765 user@server
# Then access: ws://localhost:8765
```

**Option 3: Headscale (Self-Hosted)**
```bash
# Run your own Tailscale control server
# Same WireGuard security, full control
```

## Tech Stack

- **Backend:** Bun with native PTY support
- **Frontend:** React + Capacitor
- **Terminal:** xterm.js
- **Communication:** WebSocket
- **Transport Security:** Tailscale/SSH/Headscale (your choice)

## Why Remi?

| Feature | Remi | Happy Coder |
|---------|------|-------------|
| Transport Security | Tailscale/SSH (battle-tested) | Custom relay |
| Server to Maintain | None (use existing infra) | happy-server |
| Encryption | WireGuard / SSH | Custom crypto |
| Works Offline | Yes (daemon continues) | Depends on relay |

## Status

Phase 0: Research & Foundation (complete)

See `.context/plan.md` for development roadmap.

## License

MIT
