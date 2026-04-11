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

## Branch Strategy

```
main        Stable release branch; users install from here
develop     Integration branch; features land here first via PRs
feature/*   Short-lived branches off develop
```

- **Feature work**: branch off `develop`, PR back into `develop`
- **Releases**: when `develop` is stable, merge to `main` and tag
- **Hotfixes**: branch off `main`, PR to both `main` and `develop`
- Never push directly to `main` or `develop`

## Local Binary Installation

The local `remi` binary is symlinked into PATH:

```bash
sudo ln -sf /Users/yahya/Documents/git/yooz/remi/dist/remi /opt/homebrew/bin/remi
```

**NOT Homebrew-managed** — it is a manual symlink pointing directly to `dist/remi`.
After any build, the symlink picks up the new binary automatically; no reinstall needed.

```bash
# Build and verify
bun run build:binary
remi --version   # should reflect new version immediately
```

For PR/branch test builds, use `set` to assign a recognizable version:
```bash
./scripts/bump-version.sh set 0.4.23-p292.1
bun run build:binary   # dist/remi updated; /opt/homebrew/bin/remi picks it up
```

## Releasing

**Always use the bump-version script for releases.** Never manually edit version numbers.

```bash
# Dev release on develop (publishes to npm with @dev tag, GitHub prerelease)
git checkout develop
./scripts/bump-version.sh --push dev     # 0.4.3 -> 0.4.4-dev.1
./scripts/bump-version.sh --push dev     # 0.4.4-dev.1 -> 0.4.4-dev.2

# Promote to main when stable (CI auto-strips dev suffix and releases)
git checkout main && git merge develop && git push origin main
# CI runs auto-release: 0.4.4-dev.6 -> 0.4.4 (tag + npm publish + Homebrew)

# After release: sync develop and start next dev cycle
git checkout develop && git merge origin/main && git push origin develop
./scripts/bump-version.sh --push dev     # 0.4.4 -> 0.4.5-dev.1

# Stable release (triggers CI: build, npm publish @latest, GitHub release, Homebrew update)
./scripts/bump-version.sh --push patch   # 0.4.4-dev.2 -> 0.4.4
./scripts/bump-version.sh --push minor   # 0.3.9 -> 0.4.0
./scripts/bump-version.sh --push major   # 0.3.9 -> 1.0.0
./scripts/bump-version.sh --push set 1.0.0  # Explicit version

# Without --push: commits and tags locally, prints push commands
./scripts/bump-version.sh patch
```

The script updates both `package.json` and the `REMI_COMPILED_VERSION` fallback in `cli.ts`, commits, tags, and (with `--push`) pushes to trigger the release pipeline.

## CI

GitHub Actions runs on push/PR to main: `bunx biome check`, `bun run typecheck`, `bun test --coverage` with 60% minimum threshold.

---

*Part of the Yooz ecosystem; Local-first, graceful degradation, fast iteration*
