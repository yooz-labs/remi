# Remi — Cross-Platform Claude Code Monitor

Project-specific agent instructions. Ecosystem-wide rules live in `../AGENTS.md`.

## Project Overview

- **Purpose:** Lightweight, cross-platform client for monitoring Claude Code CLI sessions remotely.
- **Tech stack:** Bun + TypeScript (backend), React + Capacitor (frontend), WebSocket, xterm.js.
- **Philosophy:** "My agent needs me. Yes or No."

## Quick Start

```bash
bun install
bun run dev          # web dev server
bun run daemon       # start Remi daemon
bun test             # tests (NO MOCKS)

# Mobile
bun run build && npx cap sync ios && npx cap open ios
bun run build && npx cap sync android && npx cap open android
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    REMI CLIENT (Phone / Browser)                 │
│  React + Capacitor (iOS / Android / Web / Desktop)               │
│  Chat View (xterm.js) | Session List | Notifications             │
└──────────────────────────┬───────────────────────────────────────┘
                           │ WebSocket (transport-encrypted)
┌──────────────────────────▼───────────────────────────────────────┐
│                 REMI DAEMON (server / dev machine)               │
│  PTY Manager | Session Registry | Event Parser | WebSocket:8765  │
└──────────────────────────┬───────────────────────────────────────┘
                           │ PTY
┌──────────────────────────▼───────────────────────────────────────┐
│                      CLAUDE CODE CLI                             │
└──────────────────────────────────────────────────────────────────┘
```

## Repository Structure

```
remi/
├── packages/
│   ├── daemon/          # Bun + TypeScript backend, CLI, PTY, sessions
│   ├── shared/          # Protocol, crypto, identity, types
│   ├── signaling/       # Cloudflare Workers signaling / relay service
│   └── web/             # React + Vite + Capacitor client
├── tests/
│   ├── e2e/             # Playwright end-to-end tests
│   └── integration/     # Integration scripts and Docker assets
├── scripts/             # Release / publish / install helpers
├── .context/            # Plan, research, ideas, scratch notes
└── .rules/              # Repo-specific standards
```

Key directories to know:

- `packages/daemon/src` — CLI, PTY / session management, transcript parsing, adapters, auth, mDNS
- `packages/shared/src` — protocol and shared types consumed across packages
- `packages/signaling/src` — Durable Object room logic and signaling utilities
- `packages/web/src` — React UI, connection flow, chat / session components, hooks, lib utilities

## Differentiators

| vs. | Remi advantage |
|---|---|
| Happy Coder | No custom relay; delegates to Tailscale / SSH |
| Muxer (Swift) | Cross-platform; faster development |

## Transport Options

| Method | When to use |
|---|---|
| Direct connection | Same Wi-Fi, Tailscale, VPN, SSH tunnel |
| Signaling + WebRTC | No direct access (STUN / TURN fallback) |

## Question Detection and Notifications

See `.context/notification-and-session-flow.md` for the full flow diagram.

**Question sources** (daemon side):

- `HookEventBridge` — emits questions from `PermissionRequest` hooks; suppresses redundant notifications.
- `OutputProcessor` — PTY-output parsing (fallback when hooks are unavailable).

**Notification channel — APNS push only** (no local notifications for questions):

- Daemon sends WebSocket `question` (in-app display) AND APNS push (lock screen).
- Signaling server (Cloudflare Worker) relays push payloads to APNS.
- iOS categories `REMI_YN`, `REMI_YNA`, `REMI_MULTI` registered in `AppDelegate.swift`.

**Constraints from real logs (2026-04-12 analysis):**

- Bash `PermissionRequest` has `permission_suggestions=undefined` (no suggestions).
- Notification message is plain text ("Claude needs your permission to use Bash"), no numbered options.
- Claude Code always offers 3 options for permissions: Yes / Yes always / No.
- Numbered option text appears only in the terminal UI, not in hook events.
- `HookEventBridge` emits the default 3-option set immediately; no parsing or merge timer needed.
- Redeploy the signaling server after any `packages/signaling/` change.

### PTY-fallback question patterns

| Pattern | Response |
|---|---|
| `[Y/n]`, `[y/N]` | `y\n` or `n\n` |
| `[Y/n/a]`, `[Y/n/q]` | `a\n` (all) |
| `1)`, `1.` | numbered selection |
| `>`, `Enter:` | free text |

## Core Principles

1. **Zero friction** — WebRTC provides DTLS encryption automatically.
2. **Reliable messaging** — WhatsApp-style states (sending → sent → delivered → read).
3. **No data in cloud** — peer-to-peer when possible; TURN only relays encrypted blobs.
4. **Graceful degradation** — if parsing fails, show raw text.

## Branch Strategy

```
main        Stable release branch; users install from here
develop     Integration branch; features land here first via PRs
feature/*   Short-lived branches off develop
```

- Feature work → branch off `develop`, PR back into `develop`.
- Releases → when `develop` is stable, merge to `main` and tag.
- Hotfixes → branch off `main`, PR to both `main` and `develop`.
- **Never push directly to `main` or `develop`.**

## Local Binary Installation

The local `remi` binary is symlinked into `PATH`:

```bash
sudo ln -sf /path/to/yooz/remi/dist/remi /opt/homebrew/bin/remi
```

**Not Homebrew-managed** — manual symlink pointing directly at `dist/remi`. After any build the symlink picks up the new binary automatically.

```bash
bun run build:binary
remi --version   # reflects new version immediately
```

For PR / branch test builds, set a recognizable version:

```bash
./scripts/bump-version.sh set 0.4.23-p292.1
bun run build:binary   # /opt/homebrew/bin/remi picks it up
```

## Releasing

**Always use `bump-version.sh`** — never hand-edit version numbers.

```bash
# Dev release on develop (npm @dev tag, GitHub prerelease)
git checkout develop
./scripts/bump-version.sh --push dev   # 0.4.3 → 0.4.4-dev.1
./scripts/bump-version.sh --push dev   # 0.4.4-dev.1 → 0.4.4-dev.2

# Promote to main when stable (CI strips dev suffix and releases)
git checkout main && git merge develop && git push origin main
# CI: 0.4.4-dev.6 → 0.4.4 (tag + npm publish + Homebrew)

# After release: sync develop and start the next dev cycle
git checkout develop && git merge origin/main && git push origin develop
./scripts/bump-version.sh --push dev   # 0.4.4 → 0.4.5-dev.1

# Stable release (CI: build, npm @latest, GitHub release, Homebrew)
./scripts/bump-version.sh --push patch     # 0.4.4-dev.2 → 0.4.4
./scripts/bump-version.sh --push minor     # 0.3.9 → 0.4.0
./scripts/bump-version.sh --push major     # 0.3.9 → 1.0.0
./scripts/bump-version.sh --push set 1.0.0 # explicit

# Without --push: commits and tags locally, prints push commands
./scripts/bump-version.sh patch
```

The script updates `package.json` and the `REMI_COMPILED_VERSION` fallback in `cli.ts`, commits, tags, and (with `--push`) pushes to trigger the release pipeline.

## CI

GitHub Actions on push / PR to `main`: `bunx biome check`, `bun run typecheck`, `bun test --coverage` with a 60% minimum threshold.

---

*Part of the Yooz ecosystem. Local-first; graceful degradation; fast iteration.*
