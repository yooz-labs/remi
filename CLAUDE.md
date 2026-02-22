# Remi - Cross-Platform Claude Code Monitor

## Project Overview

**Purpose:** Lightweight, cross-platform client for monitoring Claude Code CLI sessions remotely
**Tech Stack:** Bun + TypeScript (backend), React + Capacitor (frontend), WebSocket, xterm.js
**Philosophy:** "My agent needs me. Yes or No."

## Quick Start

```bash
bun install
bun run dev              # Web dev server
bun run daemon           # Start Remi daemon
bun run test             # Run tests

# Mobile
bun run build && npx cap sync ios && npx cap open ios
bun run build && npx cap sync android && npx cap open android
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    REMI CLIENT (Phone/Browser)                   │
│  React + Capacitor (iOS/Android/Web/Desktop)                     │
│  Chat View (xterm.js) | Session List | Notifications             │
└──────────────────────────┬──────────────────────────────────────┘
                           │ WebSocket (encrypted by transport)
┌──────────────────────────▼──────────────────────────────────────┐
│                 REMI DAEMON (on server/dev machine)              │
│  PTY Manager | Session Registry | Event Parser | WebSocket:8765  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ PTY
┌──────────────────────────▼──────────────────────────────────────┐
│                      CLAUDE CODE CLI                             │
└─────────────────────────────────────────────────────────────────┘
```

## Key Differentiators

| vs. | Remi Advantage |
|-----|----------------|
| Happy Coder | No custom relay; delegates to Tailscale/SSH |
| Muxer (Swift) | Cross-platform; faster development |

## Transport Options

| Method | When to Use |
|--------|-------------|
| Direct Connection | Same WiFi, Tailscale, VPN, SSH tunnel |
| Signaling + WebRTC | No direct access (STUN/TURN fallback) |

## Question Detection

| Pattern | Response |
|---------|----------|
| `[Y/n]`, `[y/N]` | `y\n` or `n\n` |
| `[Y/n/a]`, `[Y/n/q]` | `a\n` (all) |
| `1)`, `1.` | Numbered selection |
| `>`, `Enter:` | Free text |

## Core Principles

1. **Zero Friction:** WebRTC provides DTLS encryption automatically
2. **Reliable Messaging:** WhatsApp-style delivery states (sending → sent → delivered → read)
3. **No Data in Cloud:** P2P when possible; TURN relay only forwards encrypted blobs
4. **Graceful Degradation:** If parsing fails, show raw text

## Project Structure

```
remi/
├── packages/
│   ├── daemon/          # Bun backend (PTY, WebSocket, parsing)
│   ├── web/             # React frontend (Vite, Capacitor)
│   ├── shared/          # Shared types and protocol
│   └── signaling/       # Cloudflare Workers signaling server
├── .context/            # plan.md, research.md
└── .rules/              # Development standards
```

## Code Intelligence

Use **Serena MCP** for efficient code navigation instead of reading entire files:

| Tool | Use Case |
|------|----------|
| `get_symbols_overview` | Get file structure (classes, functions, exports) |
| `find_symbol` | Search for specific symbols by name |
| `find_referencing_symbols` | Find all usages of a symbol |
| `search_for_pattern` | Regex search across codebase |
| `replace_symbol_body` | Edit entire function/method bodies |

## Deployment

Use `cfman` (multi-account Cloudflare CLI) with the `yooz-labs` account for all Cloudflare deployments. Never use `wrangler` directly.

```bash
# Signaling server (Cloudflare Workers + Durable Objects)
cd packages/signaling
npx cfman wrangler --account yooz-labs deploy

# Web client (Cloudflare Pages)
cd packages/web && bun run build
npx cfman wrangler --account yooz-labs pages deploy dist --project-name remi-app --branch main
```

## CI

GitHub Actions runs on push/PR to main: `bunx biome check`, `bun run typecheck`, `bun test --coverage` with 60% minimum threshold.

---

*Part of the Yooz ecosystem; Local-first, graceful degradation, fast iteration*
