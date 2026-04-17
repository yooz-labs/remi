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

### Phase 2: Session UX (PARTIAL)

| Feature | Status | Issue |
|---------|--------|-------|
| Human-readable session names (`hostname/dir/branch`) | Done | #45 |
| Explicit `remi new` / `remi detach` / `remi kill` commands | Partial | #46 |
| Session list shows name, status, duration, last activity | Done (iOS) | #47 |
| Orphan timeout configurable (`--timeout 30m`) | Todo | - |

Session names display in iOS app as `dir/branch` (hostname stripped for brevity).

### Phase 3: Chat Mode (PARTIAL)

iOS app ships a chat-style interface. Core pieces work; UX still rough.

| Feature | Status | Issue |
|---------|--------|-------|
| Chat view (structured messages, no terminal rendering) | Done | #48 |
| Tool chips (`Used Bash`, `$ cmd...`) | Done | - |
| Question cards with tap-to-answer | Done (buggy) | #49 |
| Session switcher | Done | #50 |
| Push notifications infra (APNS bridge) | Built, untested | #286 |
| Consistent history replay | In progress | #281 |
| Collapsible tool-use sections | Todo | #48 |
| Unread badges | Todo | #50 |

**Known chat UX issues (blocking MVP):**
- Chat history inconsistent: appears/disappears across reconnects
- Zero-storage reconnect model not fully implemented (stream 200 msgs on connect, clear on disconnect)
- Auth error messages leak into chat bubbles on localhost
- Stale question cards don't clear after answer
- Connection bars clutter header when all healthy

### Phase 4: iOS Polish Sprint (SHIPPED — Epic #267 closed)

P0 regressions (#269, #270, #264) and P1 polish (#271, #261, #262, #263, #268, #272, #265, #258, #235, #227) all shipped through dev.3–dev.8. One P2 item (#266 double text input) remains open but non-blocking.

### Phase 5: Auto-Approve + Session Reliability (SHIPPED in v0.5.1)

Shipping now as v0.5.1 stable (PR #323 merged 2026-04-17):

| Feature | Status | PR / Issue |
|---------|--------|------------|
| LLM auto-approve (Ollama, OpenRouter, any OpenAI-compat) | Done | #314 / #175 |
| User allow/deny/instructions in config | Done | #317 / #315 |
| Subagent/team hook filtering via `agent_id` | Done | #322 / #316 |
| PTY-liveness session classifier | Done | #320 / #319 |
| Config file system `~/.remi/config.toml` | Done | #314 / #150 |
| PermissionRequest hook with suggestions | Done | — / #178 |
| Release-blocker hardening (inject fallback, config type validation) | Done | #324 / — |

### Phase 6: MVP Blockers (NEXT — post v0.5.1)

Priority order. Everything ≤ MVP-blocking only; polish and refactors listed separately.

1. **#286** APNS end-to-end -- push works in dev but never verified on a physical device; without it lock-screen questions are dead on arrival.
2. **#287** Wrapper hot-reload -- running daemons keep old binary after build; fails silently until restart. High user-confusion cost during iteration.
3. **#321** Sibling-daemon-same-dir permanently blocks hook lock -- any user who runs two daemons in the same dir gets a silent no-op.
4. **#280** Daemon should reload transcript history on restart -- users lose past chat on restart.
5. **#257** Auth prompt on localhost -- localhost should not require auth; suppress or auto-complete.
6. **#241** Session lifecycle (Phase 3) -- disconnect / reconnect / resume buttons wired up end-to-end.
7. **#238** Message display redesign epic -- scope and ship Phase 1.

### Phase 7: Product Readiness (LATER)

| Feature | Status | Issue |
|---------|--------|-------|
| Android app | Future | - |
| App Store submission | Future | - |
| Homebrew formula | Done | - |
| Voice interaction (STT/TTS via yooz-engine) | Future | - |
| Server-daemon architecture | Future | #255 |
| Remote daemon spawning (`remi new --host`) | Future | #153 |
| iOS background persistence | Future | #276 |

**Deferred polish (P2/P3, not MVP-blocking):** #266, #226 (keyboard/scroll), #234 (image attach), #233 (keyboard shortcuts), #253 (toggle memory), #207 (notify third-party detach), #256 (kill-by-port), #168/#169/#170 (refactors), #129 (Xcode Cloud CI), #176 (subagent summaries), #174 (read-only UX), #203 (WorktreeCreate blocks subagent), #278 (lock-screen reply), #298 (interactive notification actions).

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
