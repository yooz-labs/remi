# Remi

> Cross-platform Claude Code session monitor with WhatsApp-style messaging

Remi lets you monitor and respond to Claude Code CLI sessions from your phone, tablet, or browser. Get notified when Claude asks a question and respond with a tap; whether you're at a coffee shop, on a train, or away from your desk.

## Features

- **Zero friction** - No VPN or external apps required; just install and connect
- **Encrypted P2P** - WebRTC with DTLS encryption (automatic)
- **Reliable delivery** - Message states like WhatsApp (✓ sent, ✓✓ delivered, read)
- **Live updates** - Agent messages update in real-time as work progresses
- **Cross-platform** - iOS, Android, Web, macOS, Windows, Linux
- **Notifications** - Get alerted when Claude needs your input

## How It Works

```
┌─────────────────────┐                      ┌─────────────────────┐
│   Your Phone        │   WebRTC + DTLS      │   Your Server       │
│   (Remi App)        │◄────────────────────►│   (Remi Daemon)     │
└─────────────────────┘   (encrypted P2P)    └──────────┬──────────┘
                                                        │ PTY
                                             ┌──────────▼──────────┐
                                             │   Claude Code CLI   │
                                             └─────────────────────┘
```

1. Daemon runs on your server, spawning Claude in a PTY
2. Phone connects via WebRTC (NAT traversal handled automatically)
3. Messages stream with delivery acknowledgments
4. You respond; daemon sends to Claude

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

# Start daemon
remi daemon

# Or wrap Claude directly
remi claude "build a feature"
```

### On Your Phone

1. Install Remi app (iOS/Android) or open web app
2. Scan QR code or enter connection code
3. Start monitoring

## Tech Stack

- **Backend:** Bun with native PTY support
- **Frontend:** React + Capacitor
- **Transport:** WebRTC DataChannel (DTLS encrypted)
- **NAT Traversal:** STUN/TURN (automatic)
- **Protocol:** Custom messaging with ACKs and editing

## Why Remi?

| Feature | Remi | Happy Coder |
|---------|------|-------------|
| External App Required | No | No |
| Transport | WebRTC (P2P) | Custom relay |
| Encryption | DTLS (automatic) | Custom crypto |
| Message Delivery | ACKs (WhatsApp-style) | ? |
| Message Editing | Yes | ? |
| Server to Maintain | None (P2P) | happy-server |

## Status

Phase 0: Research & Foundation (complete)

See `.context/plan.md` for development roadmap.

## License

MIT
