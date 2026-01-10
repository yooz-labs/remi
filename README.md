# Remi

> Cross-platform Claude Code session monitor and responder

Remi lets you monitor and respond to Claude Code CLI sessions from your phone, tablet, or any browser. When Claude asks a question, get notified and tap to respond; no need to stay at your desk.

## Features

- **Cross-platform** - iOS, Android, Web, macOS, Windows, Linux
- **Local-first** - Your code never leaves your machine
- **Real-time** - WebSocket streaming for instant updates
- **Simple responses** - One-tap Yes/No buttons for common questions
- **Notifications** - Get alerted when Claude needs your input

## Architecture

```
┌─────────────────────┐     WebSocket     ┌─────────────────────┐
│   Remi Client       │◄──────────────────►│   Remi Daemon       │
│   (Phone/Browser)   │                    │   (Your Machine)    │
└─────────────────────┘                    └──────────┬──────────┘
                                                      │ PTY
                                           ┌──────────▼──────────┐
                                           │   Claude Code CLI   │
                                           └─────────────────────┘
```

## Quick Start

```bash
# Install
bun install -g remi

# Start Claude with Remi
remi claude "build a feature"

# Open http://localhost:8765 on your phone
```

## Tech Stack

- **Backend:** Bun with native PTY support
- **Frontend:** React + Capacitor
- **Terminal:** xterm.js
- **Communication:** WebSocket

## Status

Phase 0: Research & Foundation (complete)

See `.context/plan.md` for development roadmap.

## License

MIT
