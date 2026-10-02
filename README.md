# Remi

> Your agents need you. Yes or No.

Remi is a cross-platform monitor for Claude Code sessions. Run your AI agents on any machine, walk away, and stay connected from your phone, tablet, or browser. Get notified when Claude needs input. Respond with a tap. Never lose a session.

## The Problem

You start a Claude Code session on your workstation. It's working on a complex task. You need to leave. Your options today: keep the terminal open and hope nothing goes wrong, or kill it and start over later.

## What Remi Does

**1. Session Persistence** - Like tmux for AI agents. Close your terminal, your session survives. Detach with `Ctrl+B d`, reattach from anywhere with `remi attach`.

**2. Multi-Machine Discovery** - Run agents across multiple machines. One command to see everything: `remi ls --network`. **Opt-in since #880:** the daemon binds `127.0.0.1` by default, and mDNS does not advertise on a loopback bind — so discovery finds nothing until you set `daemon.bind` (and read the auth warning that comes with it).

**3. Chat Interface** - Monitor your agents from a clean chat view on your phone. See the conversation without the code noise. Answer questions, approve actions, keep things moving.

**Permissions stay with Claude Code.** Remi does not decide permissions; Claude Code's own settings do (auto mode, `permissions.allow` / `permissions.deny`). Whatever Claude still asks shows in your terminal at once and is pushed to your phone, and whichever answers first wins. A Yes/No permission prompt is answered through Claude's own hook, never by typing into the terminal: Yes, No, or, where Claude offers one, a standing grant for this session (the daemon also accepts a note for Claude with a No; the app does not send one yet). If nobody answers from the phone within `[prompts] hold_seconds` (default 90), the phone is told to answer at the terminal, where the dialog is still showing. A session with no terminal of its own (daemon or hub) waits up to `[prompts] daemon_hold_seconds` (default 3540) and then points you to `remi attach`. A background agent's prompt in a terminal session is answered at the terminal, and the phone gets a notice. Claude's questions (AskUserQuestion) and plan approvals are answered through the hook the same way: every question is answered from the phone (with your own text for a single-choice question, if you like), and an answer that leaves a question out is refused, so the question keeps waiting; a plan is approved with edits auto-accepted or approved manually, or sent back to keep planning (the daemon also accepts a note for Claude with it; the app does not send one yet). Auto mode is offered only in the terminal's dialog. Prompts Claude raises without a permission hook (sandbox network, folder trust) are still typed into Claude's dialog when they reach the phone, only when the option you chose has the same label at the same number on screen; otherwise remi refuses and you answer at the terminal. Not every such prompt reaches the phone: a daemon session's startup folder-trust dialog has to be answered with `remi attach` (#1147). Coming from an older Remi with an `[auto_approve]` section in `~/.remi/config.toml`? Run `remi migrate-permissions` to print your old allow/deny rules as Claude Code `permissions` JSON; it never writes a file, so paste the result into `~/.claude/settings.json` yourself. Review the deny rules: Remi matched a deny entry anywhere in a command, Claude Code matches from the start of each command, so a migrated deny is narrower, and patterns that only appear mid-command (`push --force`) are listed as not carried over instead.

## Quick Start

```bash
# Install (the package name is scoped, but the command it provides is just `remi`)
bun install -g @yooz-labs/remi

# npm also has an unrelated package named plain `remi`.
# If an older install step left that one on your machine, remove it:
bun remove -g remi

# Start Claude Code with Remi (session persists if terminal closes)
remi -- claude

# Detach: Ctrl+B d
# List sessions
remi ls

# Reattach
remi attach macbook/remi/main

# See sessions on all machines
remi ls --network

# Attach to a remote session
remi attach --host 192.168.1.5 macbook/remi/main
```

### From Your Phone

1. Open the web app or install the mobile app (iOS/Android)
2. Connect via local network, connection code, or direct address
3. Monitor and respond to all your agent sessions

## Features

- **Session persistence** - Survives terminal close (SIGHUP), detach/reattach like tmux
- **Human-readable session names** - `hostname/project/branch` instead of UUIDs
- **Inline Claude rendering** - remi sets `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` for the Claude it runs, because its status bar and prompt detection need the inline renderer. This overrides Claude's `tui` setting and `CLAUDE_CODE_NO_FLICKER`. To opt out, start remi with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0` set (the status bar is then unverified against fullscreen). An in-session `/tui` switch can still move Claude to the alternate screen (#1135)
- **LAN discovery** - mDNS/Bonjour finds Remi daemons on your network, once you widen `daemon.bind`. Not on by default (#880): a stock daemon is loopback-only and does not advertise
- **Multiple connection methods** - Direct WebSocket, relay via Cloudflare, SSH tunnel, Tailscale
- **Chat view** - Clean conversation interface without terminal noise
- **Live updates** - Agent messages stream in real-time as work progresses
- **Cross-platform** - iOS, Android, Web, macOS, Windows, Linux
- **macOS menu-bar app** - a status "r" tracking live connections plus the full web UI in a native window; see [docs/MACOS_APP.md](docs/MACOS_APP.md)
- **Notifications** - Push alerts when Claude needs your input
- **Encrypted relay, when authenticated** - with an authenticated permanent code (`--auth --permanent-code`, or `[auth] enabled = true` plus `--permanent-code`), relay traffic is end-to-end encrypted (P-256 ECDH signed by each side's Ed25519 identity, AES-256-GCM) and the Cloudflare Worker cannot read it. The default rotating-code mode never derives session keys, where the daemon **refuses to send** rather than downgrade, and **accepts unencrypted inbound messages** — so the relay does not currently work end to end without auth, and what a client did send arrived in the clear (#881). Even when encrypted, the Worker still sees the room code and who talks to whom and when: this hides content, not metadata
- **No cloud dependency** - direct connections never touch a server at all. On a stock install only the SSH tunnel works out of the box: LAN and Tailscale direct need `daemon.bind` widened first (#880). Do **not** use `tailscale serve` for this — it is a same-host reverse proxy, so every tailnet peer arrives as `127.0.0.1` and inherits the loopback auth exemption (#869). The relay is the other exception, and see the caveat above

## Connection Methods

```
Phone/Browser ──► Direct WebSocket (same network, Tailscale, VPN — needs daemon.bind widened)
                ──► SSH Tunnel (ssh -L 28765:localhost:28765 server)
                ──► Relay (connection code, works from anywhere)
```

## Architecture

```
┌─────────────────────┐                      ┌─────────────────────┐
│   Your Phone        │                      │   Your Dev Machine  │
│   (Remi App)        │◄════════════════════►│   (Remi Daemon)     │
│                     │   WebSocket / Relay   │   mDNS: _remi._tcp │
│   Chat View         │   (end-to-end enc.)  ├─────────────────────┤
│   Session List      │                      │   PTY Manager       │
│   Notifications     │                      │   Session Registry  │
└─────────────────────┘                      │   Transcript Parser │
                                             └──────────┬──────────┘
                                                        │ PTY
                                             ┌──────────▼──────────┐
                                             │   Claude Code CLI   │
                                             └─────────────────────┘
```

## Tech Stack

- **Backend:** Bun + TypeScript, native PTY support
- **Frontend:** React + Vite + Capacitor (iOS/Android/Web)
- **Transport:** WebSocket (direct) or Cloudflare Workers relay
- **Discovery:** mDNS/Bonjour (`_remi._tcp`), off unless `daemon.bind` is non-loopback
- **Protocol:** Structured messages with delivery states and deduplication

## Development

```bash
bun install           # Install deps + set up pre-commit hooks
bun run dev           # Web dev server
bun run daemon        # Start Remi daemon
bun test              # Run tests (854 tests)
bun run lint          # Biome check
bun run typecheck     # TypeScript check
```

### Environment variables

| Variable | Effect |
|---|---|
| `REMI_HOME` | Absolute path of remi's state directory (config, sessions, live sessions, logs, status files, device tokens, keys, statusline script). Defaults to `~/.remi`. Use a scratch directory to run remi from source without touching your real state. A relative path is refused. Under an override remi writes its statusline script there but does not register it in `~/.claude/settings.json`, and `remi --install` / `--uninstall` refuse to run (the service always uses `~/.remi`). |

## Roadmap

See `.context/plan.md` for the detailed development roadmap.

## License

Remi is open core, and the license is set per directory.
[`LICENSE.md`](LICENSE.md) maps each package directory to its license and states the license for everything outside them; each package directory carries its own license file.

- **Daemon, CLI and shared protocol** (`packages/daemon`, `packages/shared`): [**Apache License 2.0**](packages/daemon/LICENSE).
  Use, modify and redistribute them, commercially or not, under the terms of that license.
- **Mobile and web client, hosted relay and native Mac app** (`packages/web`, `packages/signaling`, `packages/macos`): [**PolyForm Shield 1.0.0**](packages/web/LICENSE.md).
  You can read, fork, modify and use them for any purpose **except** building a competing product, so you cannot offer a re-skinned commercial fork of the app or the relay.
  For the strategic rationale, see [`yooz-engine/LICENSING.md`](https://github.com/yooz-labs/yooz-engine/blob/main/LICENSING.md).
- **Everything else** (scripts, docs, CI configuration): Apache-2.0 unless a file says otherwise.

The `@yooz-labs/remi` npm package is a small Node launcher; the platform packages it installs hold the compiled `remi` binary, which bundles daemon and shared code plus third-party dependencies.
The npm packages are Apache-2.0, and the bundled dependencies keep their own licenses (their notices are not shipped yet, see [`LICENSE.md`](LICENSE.md)).

For commercial-use or dual-license inquiries about the PolyForm Shield parts: **dev@yooz.info**.

## Contributing

PRs welcome. Sign your commits with `Signed-off-by: Your Name <you@example.com>` (DCO style); see [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: see [`SECURITY.md`](SECURITY.md).

---

*Part of the [Yooz ecosystem](https://github.com/yooz-labs). Sovereign Intelligence. Built for the skeptical.*
