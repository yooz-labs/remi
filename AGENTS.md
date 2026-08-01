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
| "auto = based on bind address" (`AuthConfig.enabled`) | `'auto'` resolves to `false` on every bind, `0.0.0.0` included | #880, still open |
| allow-patterns match tool names (`config.ts`) | substring match, so `Read` covered `cat x \| sh` | #536, a P0 |
| `relay-adapter-auth.test.ts` "tests the relay adapter" | never constructed one; 8 tests that could not fail on that claim (corrected from a stale "29" — ADR 0014) | mandatory kex shipped uncovered |
| "the relay is now end-to-end encrypted" (#543, believed done) | engages only when an authenticator exists, i.e. never by default | #881, found while *writing the README fix for the previous row* |

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

## Architecture decisions

Standing decisions live in [`.context/decisions/`](.context/decisions/) as ADRs.
Read the relevant one before changing behavior it covers; several exist
specifically because the decision looks like an inconsistency worth "cleaning
up", and the cleanup would reopen a security hole.

| ADR | Decision |
|---|---|
| [0001](.context/decisions/0001-transcript-path-source-of-truth.md) | Transcript path is the session source of truth |
| [0002](.context/decisions/0002-model-b-hold-the-hook-notifications.md) | Hold-the-hook notification model |
| [0003](.context/decisions/0003-synchronous-permission-decisions.md) | Synchronous permission decisions |
| [0004](.context/decisions/0004-pty-as-arbiter-subagent-questions.md) | PTY is the arbiter for subagent questions |
| [0005](.context/decisions/0005-hub-and-attach-only-clients.md) | Hub mode and attach-only clients |
| [0006](.context/decisions/0006-cc-ref-disavowed.md) | `cc-ref` is not ground truth for Claude Code |
| [0007](.context/decisions/0007-release-automation-and-pins.md) | Release automation and toolchain pins |
| [0008](.context/decisions/0008-testflight-local-upload.md) | TestFlight uploads are local, not Xcode Cloud |
| [0009](.context/decisions/0009-transport-encryption-scope.md) | Encryption is scoped to the relay; direct connections carry none |
| [0010](.context/decisions/0010-allow-deny-matching-asymmetry.md) | Allow matching is precise, deny is broad — on purpose |
| [0011](.context/decisions/0011-verify-before-you-describe.md) | Security descriptions must be verified against code |
| [0012](.context/decisions/0012-protocol-message-registry.md) | Protocol message registry is the single source of truth |
| [0013](.context/decisions/0013-total-dispatch-handle-or-ignore.md) | Every protocol consumer declares handle-or-ignore, total over the registry |
| [0014](.context/decisions/0014-two-sided-conformance-tests.md) | Contract tests must construct both shipping endpoints |

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

## Hub mode (`remi serve` / `remi start`)

Epic #648 phase 1 (#542). The hub is a **session-less supervisor**: it binds
the well-known port (18765 preferred, 20-port probe), runs the shared services
(WebSocket, mDNS, relay, Telegram, device tokens), serves the machine's
session list (`daemonPorts` from `~/.remi/live-sessions/`), and spawns child
`remi --daemon` session daemons on create-session requests. It **never**
spawns Claude, never installs Claude hook config in its cwd, and never
registers itself in live-sessions.

- `remi serve` = foreground hub (the LaunchAgent/systemd entrypoint).
- `remi start` = detached hub launcher; `remi stop`/`status` manage it.
  `remi start` no longer creates a Claude session in the cwd.
- The hub self-writes `~/.remi/daemon.pid`; `remi status`/`stop` fall back to
  `daemon-status.json` (`mode: "hub"`) when the PID file is missing.
- `daemon-status.json` belongs exclusively to the hub. Every session daemon
  (hub-spawned children, which get `REMI_SPAWNED_CHILD=1`, and manually run
  `remi --daemon`) writes a per-port `status-<PORT>.json` instead.
- A session-less daemon answers `hello` with `hello_ack{sessionId: null}`;
  clients then discover children via the session-list `daemonPorts` broadcast
  (live-sessions watcher, all modes).
- `--install` generates a LaunchAgent running `<PATH-resolved remi> serve`
  with `KeepAlive.SuccessfulExit=false` (clean stop stays stopped; crash
  exit(1) restarts).

## Transport Options

| Method | When to use |
|---|---|
| Direct connection | Same Wi-Fi, Tailscale, VPN, SSH tunnel |
| Signaling relay | No direct access. Every protocol message is carried by the Cloudflare Worker |

**There is no WebRTC.** No `RTCPeerConnection` or data channel exists anywhere
in this repo. The worker was built to relay a *handshake*, with WebRTC intended
to carry the session; that second half was never implemented, so the relay
became the data transport by default and is the only remote path there is.
Anything describing a peer-to-peer path, DTLS, or TURN relaying opaque blobs is
describing an intention, not this codebase (#543).

## Question Detection and Notifications

See `.context/notification-and-session-flow.md` for the full flow diagram.

**Question sources** (daemon side):

- `HookEventBridge` — emits questions from `PermissionRequest` hooks; suppresses redundant notifications.
- `OutputProcessor` — PTY-output parsing (fallback when hooks are unavailable).

**Subagent permissions: the PTY is the arbiter** (#756 policy, #807 + #814):

- An `agent_id`-tagged `PermissionRequest` is NEVER evaluated at hook time. `AutoApproveGate`
  parks it (`parkForPTY` → `QuestionPresenceTracker.parkAwaitingPTY`) and answers the hook
  `passthrough` immediately. Claude blocks on that response, so at hook time nothing can know
  whether the prompt will ever render — and most never do (16 hooks → 2 renders in a live
  0.6.22 session).
- If the prompt DOES render, `arbitrateParkedRender` evaluates it then: `approve`/`deny`/`pick`
  are typed into the prompt on screen (never a persisting "always" option), and only an
  `escalate` verdict pushes a card. Every failure direction escalates; nothing is ever
  auto-answered by guess.
- An allowlist-covered subagent command never renders and so is never evaluated; the
  `subagent_alert` informational push (`auto-approve/subagent-alert.ts`) is the visibility
  path for those, deliberately alerting rather than blocking.

**Notification channel — APNS push only** (no local notifications for questions):

- Daemon sends WebSocket `question` (in-app display) AND APNS push (lock screen).
- Signaling server (Cloudflare Worker) relays push payloads to APNS.
- iOS categories `REMI_YN`, `REMI_YNA`, `REMI_MULTI` registered in `AppDelegate.swift`.

**Push classes and who can mute them** (#968):

Every push carries an explicit `kind`. Before that field existed the classes
were told apart by a NEGATIVE test ("no `questionId`, no `category`") which
could not distinguish turn-complete from a subagent alert at all — on the wire
those two are both exactly `{token, title, body}`.

| `kind` | Fires on | Mutable per device |
|---|---|---|
| `question` | permission prompt, escalation, hold-timeout handoff | yes, `pushPrefs.questions` |
| `turn_complete` | `Stop` after a turn ≥ `turn_complete_min_seconds` (#914) | yes, `pushPrefs.turnComplete` |
| `subagent_alert` | a background agent matched `auto_approve.subagent_alert` | no — the pattern list IS the control |
| `dismiss` | quiet `content-available` clearing a resolved card | **no, deliberately** |

- **A client cannot mute APNS on its own.** The path is daemon → Worker → APNS
  and never consults the client, so a client-side switch is decoration. It
  literally was: `settings.notifications` was written by the settings panel and
  read by nothing. Preferences ride up on `register_device_token` (idempotent
  and keyed by token, so a toggle change is just a re-register) and the daemon
  filters its per-token fan-out in `notifications/push-preferences.ts`.
- **Never filter `dismiss`.** A muted device can still hold a card delivered
  before the mute; dropping its dismissal strands that card on the lock screen
  of the device that asked for less noise.
- **A muted fan-out must report `no_channel`, not `pushed`.** `awaitDelivery`
  decides whether a held hook keeps Claude blocked; claiming delivery for a
  fan-out of zero blocks the hook on a card nobody will ever see.
- Malformed preferences fail toward DELIVERING (`sanitizePushPreferences`). A
  wrongly-delivered notification is a nuisance; a wrongly-dropped one is the
  product failing at its only job.
- `notifications.on_turn_complete = false` in `config.toml` stays the
  machine-wide master switch and wins over any per-device preference.

**Constraints from real logs (2026-04-12 analysis, updated #718 2026-07-06):**

- Bash `PermissionRequest` may have `permission_suggestions=undefined` (no suggestions), a legacy plain-string label array (e.g. Edit's `["Yes","Always","No"]`), or — since ~Claude Code 2.0.54 — a STRUCTURED array of typed "permission update entries" (`addRules`, `addDirectories`, `setMode`, `removeRules`, `replaceRules`, `removeDirectories`, each carrying `behavior`/`destination`; ground truth: code.claude.com/docs/en/hooks).
- Notification message is plain text ("Claude needs your permission to use Bash"), no numbered options, and never carries `permission_suggestions` at all.
- Claude Code does NOT always offer a fixed option count. `optionsFromSuggestions` (hook-event-bridge.ts) builds a VARIABLE-count card: [Yes] + one option per USABLE structured suggestion + [No], capped at 4 total. With no usable suggestions of either shape, the daemon falls back to the honest Yes/No 2-set (`optionsAreFallback: true` on the `Question`) instead of fabricating a 3rd option.
- Numbered option text appears only in the terminal UI, not in hook events.
- `HookEventBridge` emits the option set immediately; no parsing or merge timer needed.
- A "Yes, always allow: ..." option answered on a HELD hook resolves it with `{behavior:"allow", updatedPermissions:[<the original permission_suggestions entry>]}` — echoing a received suggestion back is, per the hooks docs, "equivalent to the user selecting that 'always allow' option in the dialog." `QuestionOption.suggestionIndex` carries which original entry to echo.
- Redeploy the signaling server after any `packages/signaling/` change.

### PTY-fallback question patterns

| Pattern | Response |
|---|---|
| `[Y/n]`, `[y/N]` | `y\n` or `n\n` |
| `[Y/n/a]`, `[Y/n/q]` | `a\n` (all) |
| `1)`, `1.` | numbered selection |
| `>`, `Enter:` | free text |

## Core Principles

1. **Zero friction** — pairing is a code, not an account.
2. **Reliable messaging** — WhatsApp-style states (sending → sent → delivered → read).
3. **No data in cloud** — the relay should carry ciphertext it cannot read, so the
   worker is a courier and not a reader. **This is still a goal, not a
   description.** #543 built the encryption; #881 is that it engages only when an
   `authenticator` is present, which `cli.ts` supplies only in permanent-code
   mode — so a default install, and even `--auth` alone, never derives session
   keys. Outbound then REFUSES to send (a breakage, not a leak) while inbound
   still ACCEPTS plaintext (a leak). Name the direction; conflating them is how
   the first draft of this very row got it wrong.
   The principle as previously written ("peer-to-peer when possible; TURN only
   relays encrypted blobs") described a WebRTC design that was never built, which
   is precisely why nobody noticed the worker was receiving plaintext
   `user_input`, answers and device tokens for months. Direct connections (LAN,
   Tailscale, VPN, SSH tunnel) genuinely never touch a server; that part is true
   today. State what ships, not what was intended.
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
