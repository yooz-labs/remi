# Remi

> Cross-platform Claude Code session monitor with WhatsApp-style messaging

Remi lets you monitor and respond to Claude Code CLI sessions from your phone, tablet, or browser. Get notified when Claude asks a question and respond with a tap; whether you're at a coffee shop, on a train, or away from your desk.

## Features

- **Zero friction** - Direct connection or signaling-based; your choice
- **Encrypted P2P** - WebRTC with DTLS encryption (automatic)
- **Reliable delivery** - Message states like WhatsApp (✓ sent, ✓✓ delivered, read)
- **Live updates** - Agent messages update in real-time as work progresses
- **Cross-platform** - iOS, Android, Web, macOS, Windows, Linux
- **Notifications** - Get alerted when Claude needs your input

## Connection Methods

Remi tries the most direct path first:

### 1. Direct Connection (Best)
If you have SSH, Tailscale, VPN, or local network access:

```bash
# SSH tunnel (creates local path)
ssh -L 8765:localhost:8765 user@server
remi connect localhost

# Tailscale
remi connect 100.x.x.x

# Local network
remi connect 192.168.1.100
```

### 2. Signaling + WebRTC (Zero Config)
No direct path? Use a connection code:

```
Daemon                              Phone
   │                                  │
   ├── Register ──► Cloudflare ◄── Connect with code
   │                    │                │
   │◄─────── Exchange SDP/ICE ──────────►│
   │                                      │
   │◄════ P2P (or TURN relay) ══════════►│
            encrypted data
```

```bash
# On server
$ remi daemon
Connection code: AXBY-1234
[QR CODE]

# On phone: enter code or scan QR
```

## Message Delivery

Like WhatsApp, every message has a delivery state:

| State | Icon | Meaning |
|-------|------|---------|
| Sending | ○ | In queue |
| Sent | ✓ | Reached daemon |
| Delivered | ✓✓ | Reached your phone |
| Read | ✓✓ | You saw it |

Agent messages can be edited as work progresses:
```
"Thinking..."  →  "Reading files..."  →  "Done! Created 3 files"
```

## Quick Start

### On Your Server

```bash
# Install Remi
bun install -g remi

# Start daemon (shows connection options)
remi daemon
```

### On Your Phone

1. Install Remi app (iOS/Android) or open web app
2. Enter connection code, scan QR, or enter direct address
3. Start monitoring

## Architecture

```
┌─────────────────────┐                      ┌─────────────────────┐
│   Your Phone        │                      │   Your Server       │
│   (Remi App)        │◄════════════════════►│   (Remi Daemon)     │
└─────────────────────┘  Direct/WebRTC/TURN  └──────────┬──────────┘
                         (DTLS encrypted)               │ PTY
                                             ┌──────────▼──────────┐
                                             │   Claude Code CLI   │
                                             └─────────────────────┘
```

## Infrastructure

| Component | Provider | Cost |
|-----------|----------|------|
| Signaling | Cloudflare Workers | Free |
| STUN | Google/Twilio | Free |
| TURN | Self-hosted coturn | ~$5/mo |

## Tech Stack

- **Backend:** Bun with native PTY support
- **Frontend:** React + Capacitor
- **Transport:** WebRTC DataChannel or WebSocket (DTLS/TLS)
- **Signaling:** Cloudflare Workers
- **Protocol:** Custom messaging with ACKs and editing

## Status

Phase 0: Research & Foundation (complete)

See `.context/plan.md` for development roadmap.

## License

MIT
