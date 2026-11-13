# Remi — Cross-Platform Claude Code Monitor

Project-specific agent instructions. Ecosystem-wide rules live in `../AGENTS.md`.

## Project Overview

- **Purpose:** Lightweight, cross-platform client for monitoring Claude Code CLI sessions remotely.
- **Tech stack:** Bun + TypeScript (backend), React + Capacitor (frontend), WebSocket, xterm.js.
- **Philosophy:** "My agent needs me. Yes or No."

## Verify before you describe

**This repo's documentation has repeatedly described security behavior the code
did not have.** Not as sloppiness — as a specific, recurring failure that hid
real problems for months. Known cases, all confirmed:

| The claim | The reality | Cost |
|---|---|---|
| "peer-to-peer, TURN relays encrypted blobs" (this file) | no WebRTC exists; the Worker was the data path in plaintext | #543, unnoticed for months |
| "auto = based on bind address" (`AuthConfig.enabled`) | `'auto'` resolves to `false` on every bind, `0.0.0.0` included | #880 initially closed LAN exposure with loopback binding; #873 now resolves auto on and requires local approval |
| allow-patterns match tool names (`config.ts`) | substring match, so `Read` covered `cat x \| sh` | #536, a P0 |
| `relay-adapter-auth.test.ts` "tests the relay adapter" | never constructed one; 8 tests that could not fail on that claim (corrected from a stale "29" — ADR 0014) | mandatory kex shipped uncovered |
| "the relay is now end-to-end encrypted" (#543, believed done) | engages only when an authenticator exists, i.e. never by default | #881, found while *writing the README fix for the previous row* |
| README "Relay (connection code, works from anywhere)", on by default | no shipped client can join a room; the daemon registered one anyway and accepted an unauthenticated peer | #1193, closed by turning it off and failing closed |

The pattern is what matters: **a wrong security description reads as "this is
handled," so nobody looks again.** Docs that overstate protection are more
dangerous than docs that are missing.

Rules, all cheap:

1. **Before citing a doc/comment as evidence that something is safe, check the
   code.** One `grep` for the caller, one `curl` against the running daemon, one
   `git log -S`. Every case above was settled by a single command.
2. **A claim about a live data path needs a caller trace.** "The relay sends X in
   plaintext" is only true if something calls it — twice this turn a module was
   dead code. Grep for callers before you assert impact, and before you file the
   issue.
3. **When code and comment disagree, fix the comment in the same change**, even
   when the behavior is someone else's call. Leave the issue number in the
   comment (see `AuthConfig.enabled` for the shape).
4. **Say what ships, not what was intended.** Aspirations belong in issues.
5. **A test named for a component must construct it.** If it does not, the name
   is a claim about coverage that is not true.

Recorded as [ADR 0011](.context/decisions/0011-verify-before-you-describe.md).

## Roadmap

What comes next, in order, and how each step is tested: [`.context/plan.md`](.context/plan.md).
The work is tracked as GitHub milestones (0.7.16 release, Relay R7, Protocol freeze, then the native apps) and area labels; decisions the roadmap waits on are collected in #1233.

## Architecture decisions

Standing decisions live in [`.context/decisions/`](.context/decisions/) as ADRs.
**Start with its [README](.context/decisions/README.md)** — it carries the full
index plus a by-area grouping, and is the fastest way to find the decision that
covers what you are about to change.

Read the relevant one before changing behavior it covers; several exist
specifically because the decision looks like an inconsistency worth "cleaning
up", and the cleanup would reopen a security hole. Each ADR carries its
evidence, not just its conclusion.

## Quick Start

```bash
bun install
bun run dev          # web dev server
REMI_HOME=/tmp/remi-dev bun run daemon   # daemon from source; state under REMI_HOME, not ~/.remi
bun test             # tests (NO MOCKS); a bunfig preload unsets REMI_HOME for them

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
                           │ WebSocket (direct; WS or optional WSS, ADR 0009)
┌──────────────────────────▼───────────────────────────────────────┐
│                 REMI DAEMON (server / dev machine)               │
│  PTY Manager | Session Registry | Event Parser | WebSocket:8765  │
└──────────────────────────┬───────────────────────────────────────┘
                           │ PTY
┌──────────────────────────▼───────────────────────────────────────┐
│                      CLAUDE CODE CLI                             │
└──────────────────────────────────────────────────────────────────┘
```

**The harness seam (epic #1161, [ADR 0032](.context/decisions/0032-harness-seam-and-identity-shim.md)).**
Claude Code is the default harness and Codex the second (status, command approvals, turn events and chat, `remi codex`), both behind `packages/daemon/src/harness/`.
`Harness` (`types.ts`) is what the daemon asks of the CLI it wraps; `ClaudeHarness` (`claude.ts`) and `CodexHarness` (`codex/codex.ts`) implement it, and `ClaudeHarness.createSession` builds a session through `createClaudeSession` (`claude-session.ts`), which holds what `createNewSession` used to do inline: the question tracker, the PTY output parser, the pre-spawn session binding, the hook bridge and the unstarted PTY.
`createNewSession` in `cli.ts` is the neutral shell around it (message API, the session's APNS dispatcher registered in `sessionNotifiers` before `createSession`, `registerSession`, the `starting` status, `start()`, the child pid), and the daemon reaches each session through `harnessSessions` (`HarnessSession`: `pty`, `decisions`, `start()`, `dispose()`, an optional `acceptsTypedChat`, false for Codex, which makes the chat handler refuse typed chat with `PROMPT_WAITING`, and an optional `chat` (`HarnessChat.readHistory`), set by Codex, which answers `transcript_load_request` from the app-server through the transcript handler's `chatFor`; `decisions` is a `DecisionChannel`: the permission gate's handle and the screen reads for Claude, `CodexDecisions` for Codex).
The harness reads `hookServer`, `PORT`, the websocket port and `[prompts]` through getters, where the original read the global, because they change while the daemon runs or are known only after the harness is built.
`tests/harness/harness-boundary.test.ts` keeps `harness/types.ts`, `harness/decision.ts`, `cli/current-session.ts`, `cli/session-phases/pty-session-setup.ts` (the PTY spawn, which takes its command, environment and output sink as parameters), `cli/handlers/`, `api/` and `session/` from importing `hooks/`, `auto-approve/`, `transcript/`, `cli/session-phases/`, `cli/claude-binding` or the Claude screen parsers, apart from two documented handler imports (chat-seam debt; #1274 removed `session-events.ts`'s); fix the import rather than adding to that list.
A second rule lets only `cli.ts` and `harness/` import `harness/index`, `harness/claude` or `harness/claude-session` at runtime, which keeps the launch path from becoming an import cycle.
A third is an allowlist for `harness/codex/` (`CODEX_MAY_IMPORT` in the test): its own files, `node:*`, `@remi/shared`, `harness/types`, `harness/decision`, `cli/session-phases/pty-session-setup.ts` (and no other session phase) and, under `session/`, the session store, binding store, registry, live-sessions registry file, `legacy-writers` and `shell-quote`, plus `api/message-api` (the chat history's bullet structuring) and `notifications/turn-events` (as a type only, which a test pins); and only `cli.ts` may import `harness/codex/`, which is why `harness/index.ts` does not re-export it.
`remi codex` is the Codex adapter (epic #1175, ADR 0033): it launches Codex, finds the session's thread on the shared app-server, reports its status, shows the thread's command approvals as phone cards (see `docs/agent-reference/harnesses-and-codex.md`, "Codex approvals"), pushes how each turn ended and serves the thread's chat (see `docs/agent-reference/harnesses-and-codex.md`, "Codex turn events and chat"), and typed chat from a client is refused (`PROMPT_WAITING`) (`.context/codex-epic-plan-2026-10.md`).
Structured remote chat (#1207, proposed ADR0043) uses a separate strict submit/result pair and HarnessSession.structuredChat without typing text or Enter.
The signed direct service checks the original grant, attachment, binding and runtime and holds the grant lock through the app-server send.
The conditional structured_chat capability and web Send caller distinguish acceptance, refusal and uncertain delivery; unknown input is never automatically replayed.
Legacy user_input remains refused for Codex. Relay child chat reuses the original grant/enrollment snapshot and the child's sequence owner; losing that owner retires the machine channel. Warm/cold native startup and accountless direct/relay admission controls are recorded; hosted checks and native UI remain separate gates. See docs/codex-remote-chat.md.
The wire names the harness (`harness`, `harnessSessionId`, `hello_ack.harnesses`; see "Harness identity and `create_session_request`" in `docs/agent-reference/harnesses-and-codex.md`).
`Harness` has no `command`: the PTY spawn takes an optional `launch: {command, childEnv}` and an `outputSink`, and absent `launch` it is the Claude launch; whatever the launch, the agent's process does not inherit remi's own secrets (`REMI_PASSPHRASE`, `REMI_PUSH_SECRET`, `TELEGRAM_BOT_TOKEN`; `pty/child-env.ts`, #1249), and a test fails if a secret-named string literal under `packages/daemon/src` is not on that list (except a short, named list of literals that are not environment variables, such as the push paths' error codes, which a second test keeps out of every environment read). That stops inheritance only: a same-user process can still read the daemon's environment and arguments (`ps eww`, `/proc/<pid>/environ`; #1252), and commands Codex runs execute in its shared app-server, which keeps its own environment; `CodexHarness.preflight` (not a `Harness` member) is what `cli.ts` calls before it boots a Codex launch.
`Harness.transcriptPath` may return `null` (no transcript file), which every reader treats as "no file".
The store reads are harness-aware (#1176): `getMostRecent('claude')` and `resolveStoredSession(..., {harness: 'claude'})` (Claude-only since #1179: nothing resolved a Codex record by remi id or prefix, so that branch is gone) skip or refuse a record of another harness, `findByClaudeSessionId` and `updateClaudeSessionId` are Claude-only, and `--sessions` labels a record `claude:<first 8 of its id>` or, for another harness, `<harness>:<last 8 of its id>` (a Codex thread id is a UUIDv7, whose first eight characters are a timestamp).
`session/legacy-writers.ts` (the older-daemon gate, read before any Codex record is written) and `harness/codex/codex-args.ts` (argument validation) are called by the Codex launch; the gate narrows the older-daemon hazard and does not close it (see its header).

## Repository Structure

```
remi/
├── packages/
│   ├── daemon/          # Bun + TypeScript backend, CLI, PTY, sessions
│   ├── shared/          # Protocol, crypto, identity, types
│   ├── signaling/       # Cloudflare relay Worker (machine rooms, admission, global limiter, legacy /push)
│   ├── macos/           # WebView Mac app (a Swift shell around the web client)
│   ├── native/          # Native SwiftUI Mac and iPhone apps (Xcode; see packages/native/AGENTS.md)
│   └── web/             # React + Vite + Capacitor client
├── tests/
│   ├── e2e/             # Playwright end-to-end tests
│   └── integration/     # Integration scripts and Docker assets
├── scripts/             # Release / publish / install helpers
├── .context/            # Plan, research, ideas, scratch notes
└── .rules/              # Repo-specific standards
```

`packages/daemon` and `packages/shared` are the Apache-2.0 packages (see `LICENSE.md`); they must never import code from the PolyForm Shield packages (`packages/web`, `packages/signaling`, `packages/macos`, `packages/native`).
`packages/daemon/tests/license-boundary.test.ts` enforces it.

Key directories to know:

- `packages/daemon/src` — CLI, PTY / session management, transcript parsing, adapters, auth, mDNS
- `packages/shared/src` — protocol and shared types consumed across packages
- `packages/signaling/src`: the relay Worker, with the front door (`index.ts`), the per-machine room (`connection-room.ts`), admission checks, the global limiter, and the legacy `/push` with APNS
- `packages/web/src` — React UI, connection flow, chat / session components, hooks, lib utilities

## Differentiators

| vs. | Remi advantage |
|---|---|
| Happy Coder | Direct SSH / Tailscale access, with an opt-in v2 hub relay daemon |
| Muxer (Swift) | Cross-platform; faster development |

## Hub mode (`remi serve` / `remi start`)

The hub (epic #648) is a session-less supervisor.
It binds the well-known port (18765 preferred, 20-port probe), runs the shared services (WebSocket, mDNS, the relay when enabled, Telegram, device tokens), serves the machine's session list, and spawns child `remi --daemon` session daemons on create-session requests.
It never spawns Claude, never installs Claude hook config in its cwd, and never registers itself in live-sessions.
`remi serve` is the foreground hub (the LaunchAgent entrypoint); `remi start` is the detached launcher; `remi stop` and `remi status` manage it.
`daemon-status.json` belongs to the hub alone; every session daemon writes `status-<PORT>.json`.
A `resume_session_request` that reaches the hub starts a child session daemon with `--resume` through the same `startSession` path as a create request (#1129), so the remote-argument allowlist and the held-session refusal apply.
A daemon that hosts Codex refuses `resume_session_request` with `UNSUPPORTED`.

Read [docs/agent-reference/hub-mode.md](docs/agent-reference/hub-mode.md) before changing the hub, `--install`, the child start path or resume resolution.

## Transport Options

Direct connection (WS, or optional WSS) is the default; the signaling relay is v2, hub-owned and off by default (`remi serve --relay` or `network.relay = true`).
**Direct connection needs `daemon.bind` (#880).**
The default bind is `127.0.0.1`, so LAN direct, Tailscale direct and mDNS discovery stop until the user opts in (mDNS does not even advertise on a loopback bind).
Do NOT recommend `tailscale serve` as the workaround: it is a same-host reverse proxy, every tailnet peer arrives as `127.0.0.1`, and #873 requires identity or a real local capability even on loopback.
Recommend an SSH tunnel, or an explicit `bind` plus `--auth`.
Authentication is on for every bind (`auth.enabled = "auto"`, #873), unless explicitly disabled with `--no-auth` or `auth.enabled = false`: an unknown key is never trusted automatically, it becomes a pending candidate that the person approves at the daemon machine (`remi keys`, `remi authorize <exact-fingerprint> --label <name>`).
`remi pair` shows a QR link and approves the phone's fingerprint in the terminal (#1275, ADR 0037); no released app scans it yet.
The Worker in this repository is v2 (R2) and is not deployed; the legacy `POST /push` stays on by default until the R7 gate.
**There is no WebRTC** (#543); descriptions of peer-to-peer DTLS or TURN do not describe this source.

Read [docs/agent-reference/transport-auth-pairing.md](docs/agent-reference/transport-auth-pairing.md) before changing bind, TLS, the relay, authentication, pairing or key provisioning.

## Question Detection and Notifications

Question sources (daemon side): `HookEventBridge` (`PermissionRequest` hooks) and `OutputProcessor` (PTY-output parsing, the fallback when hooks are unavailable).
The old flow diagram is archived at `.context/archive/2026-h2/notification-and-session-flow.md`; #1145 tracks a new one.

Standing invariants, each with its evidence in the reference file:

- **remi relays permissions; Claude Code decides** (#1125, ADR 0030).
  There is no auto-approve evaluator or rule layer, and remi never answers a permission without a human choice.
  `AutoApproveGate` is a historical name for the relay.
- **A binary prompt is answered through its held hook while Claude's own dialog stays visible** (#1126, ADR 0031).
  The first answer wins; an answer maps the option's meaning to the hook response, never a position on Claude's screen; an empty response never decides anything.
  AskUserQuestion and ExitPlanMode are held the same way with a structured `updatedInput` (#1127).
- **No card answer is typed into the PTY for a hook-backed binary prompt.**
  Where no hold stands behind a card (hook-less prompts, multi-choice permissions), a typed answer is checked against the screen first (#1134), and a refusal means "answer at the terminal".
- **Chat text and Stop's `/exit` are refused while a prompt is up** (#1140, #1155), through the one `promptUp` signal; a typed Enter would confirm the highlighted option. Known limits: a terminal entry can age out while a dialog remains up, the no-tracker fallback fails open, and a PTY-parsed status can clear the observation; see "Limits" in [docs/agent-reference/questions-and-notifications.md](docs/agent-reference/questions-and-notifications.md).
- **Cards follow their push categories.** A `terminalOnly` card has no answer controls; a standing grant gets no lock-screen category; and a card with `detail` is answered in the app only.
- **Subagent permissions follow the terminal** (ADR 0004, amended by 0030 and 0031): a held card only when no local terminal exists (daemon or hub mode); `subagent_alert` covers calls that never prompt.
- **Push is APNS only.**
  The legacy plaintext push is ON by default until the R7 gate; enrolling a device over the relay latches it off for the whole machine, for good; the sealed secure path (R5) exists in source and is unverified on signed devices.
  Every push has a `kind`; a client cannot mute APNS on its own (preferences ride up on `register_device_token`); never filter `dismiss`, except for a device that is gone (unregistered, past its lease, or APNS-rejected); a phone is pushed only while its lease holds.
- **Redeploy the signaling server after any `packages/signaling/` change** (the owner does; the steps are in `docs/relay-worker-deploy-runbook.md`, and no agent deploys).

Read [docs/agent-reference/questions-and-notifications.md](docs/agent-reference/questions-and-notifications.md) before changing question detection, hook handling, answer paths, the chat guard, push classes, push preferences, leases or the secure push path.

### No local model

remi runs no local model any more (#1125): no Yooz engine or `llama-server`,
no first-run model download, and no reserved model port. The old model
command prints a one-line removal notice and exits 2. The old engine install under
`~/.remi/engine` is left on disk; the boot notice says it can be deleted by
hand.

### PTY-fallback question patterns

| Pattern | Response |
|---|---|
| `[Y/n]`, `[y/N]` | `y\n` or `n\n` |
| `[Y/n/a]`, `[Y/n/q]` | `a\n` (all) |
| `1)`, `1.` | numbered selection |
| `>`, `Enter:` | free text |

## Protocol, Workspaces and Harnesses

Short form; the detail and the live-verification evidence are in the reference files named at the end.

- **Protocol version and capabilities (#1237, ADR 0035).**
  Every `hello_ack` carries `protocolVersion` (now 1) and `capabilities` (`DAEMON_CAPABILITIES`).
  The version changes only on a breaking change, by hand; an additive change never changes it, and a new capability is added by the change that ships the feature.
  Clients decide with `hubSupport(ack, needs)`, never by comparing `daemonVersion`.
- **The decision object (#1235, ADR 0038).**
  A "the agent needs you" moment is the `question` message's `Question`, frozen for the native apps.
  `answerPath` (`structured`, `keystroke`, `none`) says how an answer reaches the harness; `question_resolved.resolvedBy` says what resolved a card, only where the daemon knows; every dismissal goes through `createQuestionResolver`; `kind` is open.
- **Workspaces (#1236, ADR 0036).**
  `create_session_request.workspace` names a repository and optionally a new worktree; the daemon lists the `workspaces` capability, and a client checks it first.
  Git runs with no shell, no prompt and a 60-second deadline; nothing deletes a worktree (owner decision, #1233).
- **Harness identity (epic #1175 phase 5, ADR 0033).**
  `harness` and `harnessSessionId` are dual-emitted; `hello_ack.harnesses` lists the harnesses whose command is on the PATH; a client sends `harness` or `args` only to a daemon that lists the harness.
  `create_session_request.harness` and `.args` are checked before a port is probed (`checkHarnessRequest`); for Codex, a remote request may only tighten the host's posture; a daemon reads harness arguments only from after `--`.
  A headless Codex success means the child registered, not that Codex is past its Update or Trust prompt.
- **Codex approvals (phase 4).**
  remi relays, Codex decides.
  Only a plain command approval of the main thread is answerable; everything else is a `terminalOnly` card or nothing; no phone answer, Cancel, free text or chat is typed into a Codex PTY, while raw input from `remi attach`, the web Escape button and `/interrupt` is still passed through; first answer wins; there is no deadline, because the request waits in the app-server without one.
- **Codex turn events and chat (phase 6).**
  One `createTurnEventSink` serves both harnesses; Codex's `turn/completed` maps to `turn_complete` or `turn_failed` with the same gates as Claude; history is served from `thread/items/list`; typed chat to Codex stays refused (`PROMPT_WAITING`).

Read before changing the area:

- [docs/agent-reference/protocol-and-workspaces.md](docs/agent-reference/protocol-and-workspaces.md): version and capabilities, the decision object, workspaces.
- [docs/agent-reference/harnesses-and-codex.md](docs/agent-reference/harnesses-and-codex.md): harness identity and `create_session_request`, Codex approvals, Codex turn events and chat, LV-1 to LV-5 evidence.

## Core Principles

1. **Local pairing** — a short-lived token and exact fingerprint confirmation in the machine owner's terminal, without an account.
2. **Reliable messaging** — receipt acknowledgments and actual answer outcomes are distinct; an uncertain result is never reported delivered.
3. **Cloud privacy** — R3 sends encrypted semantic frames through the Worker and refuses raw PTY. The Worker still observes routing metadata. The legacy push path, ON by default until the R7 gate, still sends plaintext prompt/excerpt text to the Worker and APNS, and enrolling a device over the relay turns it off for the whole machine for good; the daemon's sealed secure path (R5), the web Settings enable control and `SecurePushSubscriptions`, and the signed native-answer daemon contract (R6) exist in source. Swift background and Watch actions (#1242/#1201), deployed and signed-device acceptance, and the R7 gate remain unfinished; no signed build with the Notification Service Extension has been verified. Direct connections do not use the Worker. Historical v1 privacy claims and failures are preserved in ADR 0011 and ADR 0034; do not describe that retired transport as current.
4. **Graceful degradation** — direct terminal clients may show raw output. Relay semantic failure reports uncertainty or an explicit refusal, without a raw PTY fallback.

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

**Always use `bump-version.sh`** — never hand-edit version numbers. Most of the
release flow is automated by CI; you rarely run the script by hand.

**What's automated:**

- **Dev counter** — `auto-bump-dev.yml` increments `-dev.N` on every push to
  `develop` (e.g. `0.6.2-dev.1` → `0.6.2-dev.2`). Version-only; no builds or
  publishes. Skip it on a given commit with `[skip-bump]` in the message.
- **Stable release** — merging `develop` → `main` triggers `auto-release`
  (ci.yml): it strips the `-dev.N` suffix, commits, and pushes the stable tag
  `vX.Y.Z`, which triggers `release.yml` (per-platform binary build, npm
  `@latest` publish to `@yooz-labs/remi` + platform packages, GitHub release,
  Homebrew tap update).
- **Post-release sync** — `sync-develop` (ci.yml) then merges `main` back into
  `develop` and bumps to the next dev line (`X.Y.Z` → `X.Y.(Z+1)-dev.1`).

**What you do by hand:**

```bash
# Cut a release: PR develop -> main (never push to main directly), merge when
# green. CI does the strip/tag/publish/sync. Update CHANGELOG before the PR.

# Start a new minor/major (or explicit) line on develop, via a normal PR.
# The dev counter then auto-increments from there on each push.
./scripts/bump-version.sh minor          # 0.6.x-dev.N -> 0.7.0-dev.1
./scripts/bump-version.sh major          # -> 1.0.0-dev.1
./scripts/bump-version.sh set 1.2.0-dev.1
# 'dev' (manual counter bump) and 'patch' still exist but are rarely needed
# now that auto-bump-dev / sync-develop handle them.

# Without --push: commits + tags locally, prints push commands.
```

The script updates `package.json` and the `REMI_COMPILED_VERSION` fallback in
`cli.ts`, commits, and tags. `stable` is blocked on `develop` (CI-only).

## CI

GitHub Actions:
- **Gates** (PR to `main`/`develop`, push to `main`): `bunx biome check`,
  `bun run typecheck`, `bun test --coverage` (60% minimum), spelling (`typos`).
- **auto-bump-dev** (push to `develop`): increments the dev counter.
- **auto-release + sync-develop** (push to `main`): stable release + dev sync.
- **release.yml** (stable `vX.Y.Z` tag): build, npm publish, GitHub release,
  Homebrew.

---

*Part of the Yooz ecosystem. Local-first; graceful degradation; fast iteration.*
