# Remi - Cross-Platform Claude Code Monitor

## Purpose
Lightweight, cross-platform client for monitoring Claude Code CLI sessions remotely.
Philosophy: "My agent needs me. Yes or No."

## Tech Stack
- **Runtime:** Bun (TypeScript)
- **Backend:** Bun daemon with PTY, WebSocket, Telegram bot (grammy)
- **Frontend:** React 19 + Vite + Capacitor (iOS/Android/Web)
- **UI:** Tailwind CSS 4, Konsta UI, Lucide icons, assistant-ui/react
- **Signaling:** Cloudflare Workers (Wrangler)
- **Linting:** Biome (lint + format)
- **Type checking:** TypeScript (strict mode)
- **Testing:** Bun test (built-in, NO mocks policy)
- **Package manager:** Bun workspaces

## Architecture
```
Client (Phone/Browser) --WebSocket--> Daemon (PTY Manager) --PTY--> Claude Code CLI
```

## Monorepo Packages
- `@remi/daemon` - PTY management, session registry, output parsing, WebSocket server, Telegram adapter
- `@remi/shared` - Shared types and protocol definitions
- `@remi/web` - React frontend with Capacitor for mobile
- `@remi/signaling` - Cloudflare Worker for WebRTC signaling

## Key Dependencies
- grammy (Telegram bot framework)
- @assistant-ui/react (chat UI)
- @capacitor (mobile bridge)
- tailwindcss v4
- wrangler (Cloudflare Workers)
