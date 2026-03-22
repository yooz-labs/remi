# Remi Development Plan

## Product Vision

Remi is a session manager and remote monitor for Claude Code. Three core workflows:

1. **Session Persistence** - Like tmux for AI agents. Start a session, walk away, reattach from anywhere.
2. **Multi-Machine Discovery** - See all your agent sessions across all machines on the network.
3. **Chat Interface** - Monitor agents from a clean chat view on your phone; no terminal noise, just the conversation.

## Roadmap

### Phase 1: Infrastructure (SHIPPED)

Remote connectivity, relay, authentication, mDNS discovery, session persistence, CLI tooling.

| Feature | Status | PR/Issue |
|---------|--------|----------|
| PTY manager + WebSocket server | Done | - |
| Transcript file watching + parsing | Done | - |
| `remi ls` / `remi attach` CLI | Done | PR #18 |
| Relay via Cloudflare Workers | Done | PR #15, #23 |
| Connection codes + QR | Done | PR #23 |
| Authentication (TOFU + passphrase) | Done | PR #31 |
| mDNS/Bonjour LAN discovery | Done | PR #35 |
| `--host` flag for remote ls/attach | Done | PR #44, #37 |
| SIGHUP handler (session survives terminal close) | Done | PR #44, #38 |
| Ctrl+B d detach in wrapper mode | Done | PR #44, #39 |
| Web client reconnect resilience | Done | PR #44, #40 |
| Question routing by sessionId | Done | PR #44, #41 |
| Message deduplication | Done | PR #44, #42 |
| `remi ls --network` (mDNS scan) | Done | PR #44, #43 |
| Parallel CI (spelling, lint, typecheck, test) | Done | PR #44 |
| Pre-commit hook (lefthook + biome) | Done | PR #44 |

### Phase 2: Session UX (NEXT)

Make sessions feel like tmux, not like debugging infrastructure.

| Feature | Status | Issue |
|---------|--------|-------|
| Human-readable session names (`hostname/dir/branch`) | Todo | #45 |
| Explicit `remi new` / `remi detach` / `remi kill` commands | Todo | #46 |
| Session list shows name, status, duration, last activity | Todo | #47 |
| Orphan timeout configurable (`--timeout 30m`) | Todo | - |

**Session Naming Convention:**
Sessions should be named `hostname/directory/branch` instead of UUID hashes. For example:
- `macbook/remi/main` - Remi project on macbook, main branch
- `workstation/yooz-engine/feature-stt` - Engine project on workstation, feature branch
- `macbook/remi/main:2` - Second session in the same context

The name is derived automatically from:
- `os.hostname()` - machine name
- Last component of the working directory
- Current git branch or worktree name
- Numeric suffix for duplicates

Users see these names in `remi ls`, `remi attach`, and the web client session list.

### Phase 3: Chat Mode (NEXT)

Transform the web client from a terminal mirror to a clean chat interface.

| Feature | Status | Issue |
|---------|--------|-------|
| Chat mode view (structured messages, no terminal rendering) | Todo | #48 |
| Separate code blocks from conversation text | Todo | #48 |
| Collapsible tool-use sections | Todo | #48 |
| Question cards with tap-to-answer | Todo | #49 |
| Session switcher with unread badges | Todo | #50 |
| Push notifications (Capacitor) | Todo | #51 |

**Chat mode design:**
The daemon already sends structured `transcript_content` messages with role, content, and type information parsed from Claude's JSONL transcript. The web client currently renders everything through xterm.js (terminal emulator). Chat mode renders the same data as a messaging interface:

- **Assistant messages** - Clean text with syntax-highlighted code blocks
- **User messages** - What the user typed/approved
- **Tool use** - Collapsible sections showing what Claude did (file reads, edits, commands)
- **Questions** - Cards with the question text and response buttons (Yes/No/custom)
- **Status** - Progress indicators (thinking, reading, writing)

### Phase 4: Polish and Ship

| Feature | Status | Issue |
|---------|--------|-------|
| iOS app (Capacitor build + App Store) | Todo | - |
| Android app (Capacitor build + Play Store) | Todo | - |
| Homebrew formula | Todo | - |
| Documentation site | Todo | - |
| Voice interaction (STT/TTS via yooz-engine) | Future | - |

## Completed Work (Historical)

### Remote Connectivity via Relay (PR #15, Issue #10)
- Signaling server on Cloudflare Workers + Durable Objects
- `ConnectionRoom` handles register/join/relay message forwarding
- Daemon `SignalingClient` and `RelayAdapter` for signaling connection
- Web client `signaling-client.ts` for code-based remote connection
- Relay-first approach (no WebRTC needed; signaling server forwards all messages)

### tmux-style CLI (PR #18)
- `remi ls` lists running sessions
- `remi attach <id>` attaches to a session in terminal

### Daemon Signaling Integration (PR #23, Issue #21)
Four phases: signaling server hardening, daemon always-on signaling, web client relay fix, testing.

### Authentication (PR #31)
- Optional passphrase, Trust on First Use (TOFU), auto-auth on localhost
- Identity auto-generated if missing; `REMI_PASSPHRASE` for non-interactive

### Ship-Ready Workflows (PR #44, Issue #36)
- Session persistence (SIGHUP, Ctrl+B d detach)
- Multi-machine access (`--host`, `--network`, mDNS)
- Web client resilience (reconnect, dedup, question routing)
- CI improvements (parallel jobs, pre-commit hooks)

## Deployments

| Service | URL | Deploy Command |
|---------|-----|----------------|
| Signaling | `wss://remi-signaling.yooz.workers.dev` | `cd packages/signaling && npx cfman wrangler --account yooz-labs deploy` |
| Web App | `https://remi-app.pages.dev` | `cd packages/web && bun run build && npx cfman wrangler --account yooz-labs pages deploy dist --project-name remi-app --branch main` |

## Key Files

| File | Purpose |
|------|---------|
| `packages/daemon/src/cli.ts` | CLI entry: daemon start, wrapper mode, ls, attach |
| `packages/daemon/src/cli/detach-scanner.ts` | Ctrl+B d byte-level detection |
| `packages/daemon/src/mdns/` | mDNS publisher + browser for LAN discovery |
| `packages/daemon/src/session/session-registry.ts` | Session lifecycle management |
| `packages/daemon/src/transcript/` | JSONL transcript file watching + parsing |
| `packages/signaling/src/connection-room.ts` | Durable Object: relay room state |
| `packages/web/src/App.tsx` | Web client: sessions, messages, questions |
| `packages/web/src/lib/message-dedup.ts` | Cross-type message deduplication |
| `packages/web/src/lib/signaling-client.ts` | Web signaling client for relay mode |
