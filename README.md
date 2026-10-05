# Remi

> Your agents need you. Yes or No.

Remi is a cross-platform monitor for Claude Code sessions. Run your AI agents on any machine, walk away, and stay connected from your phone, tablet, or browser. Get notified when Claude needs input. Respond with a tap. Never lose a session.

## The Problem

You start a Claude Code session on your workstation. It's working on a complex task. You need to leave. Your options today: keep the terminal open and hope nothing goes wrong, or kill it and start over later.

## What Remi Does

**1. Session Persistence** - Like tmux for AI agents. Close your terminal, your session survives. Detach with `Ctrl+B d`, reattach from anywhere with `remi attach`.

**2. Multi-Machine Discovery** - Run agents across multiple machines. One command to see everything: `remi ls --network`. **Opt-in since #880:** the daemon binds `127.0.0.1` by default, and mDNS does not advertise on a loopback bind — so discovery finds nothing until you set `daemon.bind` (and read the auth warning that comes with it).

**3. Chat Interface** - Monitor your agents from a clean chat view on your phone. See the conversation without the code noise. Answer questions, approve actions, keep things moving.

**Permissions stay with Claude Code.** Remi does not decide permissions; Claude Code's own settings do (auto mode, `permissions.allow` / `permissions.deny`). Whatever Claude still asks shows in your terminal at once and is pushed to your phone, and whichever answers first wins. A Yes/No permission prompt is answered through Claude's own hook, never by typing into the terminal: Yes, No, or, where Claude offers one, a standing grant for this session (the daemon also accepts a note for Claude with a No; the app does not send one yet). If nobody answers from the phone within `[prompts] hold_seconds` (default 90), the phone is told to answer at the terminal, where the dialog is still showing. A session with no terminal of its own (daemon or hub) waits up to `[prompts] daemon_hold_seconds` (default 3540) and then points you to `remi attach`. A background agent's prompt in a terminal session is answered at the terminal, and the phone gets a notice. Claude's questions (AskUserQuestion) and plan approvals are answered through the hook the same way: every question is answered from the phone (with your own text for a single-choice question, if you like), and an answer that leaves a question out is refused, so the question keeps waiting; a plan is approved with edits auto-accepted or approved manually, or sent back to keep planning (the daemon also accepts a note for Claude with it; the app does not send one yet). Auto mode is offered only in the terminal's dialog. Prompts Claude raises without a permission hook (sandbox network, folder trust) and permission prompts that offer their own list of choices are still typed into Claude's dialog when they reach the phone, only when the option you chose has the same label at the same number on screen; otherwise remi refuses and you answer at the terminal. Question tools other than AskUserQuestion (an MCP tool asking questions, for example) are answered only at the terminal: the phone shows their questions and says so. Not every such prompt reaches the phone: a daemon session's startup folder-trust dialog has to be answered with `remi attach` (#1147). Coming from an older Remi with an `[auto_approve]` section in `~/.remi/config.toml`? Run `remi migrate-permissions` to print your old allow/deny rules as Claude Code `permissions` JSON; it never writes a file, so paste the result into `~/.claude/settings.json` yourself. Review the deny rules: Remi matched a deny entry anywhere in a command, Claude Code matches from the start of each command, so a migrated deny is narrower, and patterns that only appear mid-command (`push --force`) are listed as not carried over instead.

## Quick Start

```bash
# Install (the package name is scoped, but the command it provides is just `remi`)
bun install -g @yooz-labs/remi

# npm also has an unrelated package named plain `remi`.
# If an older install step left that one on your machine, remove it:
bun remove -g remi

# Start Claude Code with Remi (session persists if terminal closes)
remi -- claude

# Start Codex with Remi (status and command approvals, see below)
remi codex

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

### Codex (status and command approvals; checked live against Codex 0.160.0 on 2026-10-04, except subagents)

`remi codex` runs `codex --no-alt-screen` the way `remi` runs Claude Code, and shows the session, what it is doing (working, waiting on an approval, idle) and the commands it asks to run on your phone.
A command approval is a card with the command, the directory it runs in when that is not the session's, and Yes and No (Codex's own No), and "Yes, and don't ask again for this command this session" if Codex ever offers it.
Codex shows the command as `/bin/zsh -lc '<command>'`, so the shell wrapper counts toward the cut below.
A command longer than 120 characters is shown with its middle cut, the way Claude's cards show it, and the whole command is in the card's detail; a card with a detail (a cut command, or one that runs in another directory) has no lock-screen buttons, so Yes needs the app.
A command for which Codex does not say where it runs gets a card with no answer buttons, so answer it in the terminal.
The phone's answer goes to Codex's app-server, never into the terminal, and Codex decides what it means: remi relays the question, it does not judge the command.
The phone's No is Codex's own No: Codex declines the command, does not run it and ends the turn ("Conversation interrupted").
The first answer wins: answer in the terminal and the card clears on your phone, and a card answered a moment too late is refused.
A card has no deadline: it stays answerable for as long as Codex keeps the request waiting, and if Codex has not confirmed an answer after 10 seconds you are told to check the terminal.
Every other kind of request (a file change, extra permissions, a question for you, an MCP prompt, a command that asks for more than itself, anything a subagent asks) shows up as a notice with no answer buttons, so answer it in the terminal; its button reads "Dismiss (answer in the terminal)" and only clears the card from your phone.
With Codex's "Approve for me" mode (the status line reads "Read Only (Approve for me)"), Codex's own reviewer approves a command automatically and sends no approval request to any client, so remi shows nothing and cannot answer for it.
Text Codex chooses (a command, a reason, a question) is shown with control, invisible and bidirectional characters made visible (`\uXXXX`, or `\u{XXXXX}` for the Tags block; the list is in ADR 0033, phase 4 amendment) and long values cut with a note of how much is hidden.
Turn notifications do not reach the phone yet.
A message typed in the app to a Codex session is refused (the app shows it as failed, "type in the terminal") instead of being typed into Codex, because remi cannot see what Codex has on screen.
The command is in the card and in the push notification (the ask, up to 120 characters in the title and 200 in the body), which goes through the signaling Worker and Apple's push service in plaintext, as every card does; a command can contain a secret.
The relay and the Worker carry the whole card, so a command up to 20000 characters, in plaintext until the relay's end-to-end encryption engages by default (#881).
The card's command and directory are kept in memory only: the live-sessions file, the hub's session list and the menu-bar app show a fixed label ("Permission: Codex command"), and the remi log carries lengths, never the command, the directory, or a thread id beyond its last eight characters (a thread id is a UUIDv7, whose first eight characters are a timestamp that two threads created within about a minute share).
The one exception is a headless Codex (a hub's child) that dies within ten seconds of starting, before it names a thread: its first and last kilobyte of output is logged once, with every UUID cut to its last eight characters and the working directory and your home directory shown as `<cwd>` and `~`, so a flag error is not opaque; anything else Codex printed, such as a config excerpt or a URL, can still appear in it.
Whenever remi starts following a new Codex thread (a `/new` in the terminal, or another `codex` window in the same directory), the session says so, and approvals then come from the new thread.
A `kill -9` of remi also ends your Codex window (Codex gets a hangup when remi's terminal closes, as Claude does), while a pending approval stays pending in Codex's app-server.

Starting Codex on another machine: `remi codex --host <ip>` (or `remi new --host <ip> --harness codex`) asks that machine's remi to start it, and only if that remi lists `codex` among the harnesses it can start (an older remi does not, and then nothing is started).
The words after `--` there are not a prompt: the remote remi accepts only `-m/--model <name>`, `-s read-only` and `resume <thread id>`, and refuses the request otherwise.
A remote request may only tighten the host's settings, never loosen them, so `-s workspace-write` is refused there (widening needs a person at the terminal, where `remi codex` allows it), and so is `-a` with any value: Codex 0.160.0 accepts only `on-request` and `never`, and neither can be shown to tighten an approval policy the host's own configuration may already have set stricter, so set that on the host.
A session started this way has no terminal, so Codex may wait at an Update or Trust prompt that nothing answers: the CLI says so when it starts one, and attaches you to the new session, which is where you answer such a prompt (NOT RUN against a real Codex: no modal appeared in the live run, so that advice is unverified).
The live run (2026-10-04, Codex 0.160.0) started a Codex session through a hub from a raw `create_session_request` and reached its prompt headless; no live run used the CLI sender (`remi codex --host`, `remi new --host --harness codex`) against a real Codex, so that path is covered by the fake-agent tests only.
The notice the hub sends has a second line for a client that does not attach: it names `remi attach <host>:<port>/<id>` for exactly that session, since a bare `remi attach` takes the newest one (the web app does not show the notice yet).

**Checked live** (against the real Codex 0.160.0, on 2026-10-04, by a spike agent):
(a) a phone Yes ran the command and Codex's prompt closed, and both phone clients were told the card was answered;
(b) answering in the terminal first told every phone client the card was canceled, and a late phone Yes was refused by remi itself (that Codex ignores a late answer was not re-tested; the spike covers it);
(c) the phone's No sends `cancel`, which Codex lists among the decisions it offers: the item is declined, the turn is interrupted and the command does not run, exactly as for the terminal's No;
(d) a dropped connection does not cancel or decline a pending approval: after a `kill -9` of a probe and of remi itself, Codex's prompt stayed up and the same request was sent again to the next connection, and answering it in the terminal produced the resolved notice;
(g) an Esc in the terminal on an approval, `turn/interrupt` and an RPC `cancel` each make Codex report the request resolved, and the card is dismissed;
(i) a pending request survives a dropped connection, even remi and the terminal together, and is sent again with the same id;
(j) a plain `codex` window in the same directory re-binds an idle remi session, and the phone was told;
(k) Codex reports the real path as a command's directory, even when it was started from a symlinked path, so a session's own directory shows no "In directory" line and keeps Yes and No;
(e) remi sends no `thread/unsubscribe` anywhere (it only closes its socket at exit), so a normal exit leaves the thread loaded; a `thread/unsubscribe` sent by a probe was harmless;
the handshake of remi's own client works against the real server (`initialize` answered in 2 ms, the 101 response carries `x-codex-websocket-max-unfragmented-message-bytes: 16777216`, `optOutNotificationMethods` is accepted and effective, `thread/loaded/list` and `server/diagnostics` are answered), and `thread/started` for the terminal's thread arrives within a second of the start.
The first live run found that Codex answers every WebSocket ping with two pongs, which dropped remi's link about every 70 seconds; that is fixed and tested.

**Not yet seen:**
NOT RUN in the live run of a hub-created Codex session: an approval card on that session (the host's posture never asked), `remi codex --host` from a second machine, the web label, and the Update and Trust modals through `remi attach`;
(h) whether a subagent's request is addressed to a connection that resumed only the main thread, and replayed;
(f) what Codex does with "Yes, and don't ask again for this command this session": none of 7 real command approvals on 0.160.0 listed `acceptForSession` (they offered accept, one amendment object and cancel), so the option does not appear in practice;
`remi codex -- exec x` and `-- login`, and a `/resume` in the terminal of a thread the daemon has not loaded.
A plain window and a remi-spawned one are indistinguishable in `thread/started`, and `originator` is one value for the whole daemon, set by whichever client initialized first: after remi initialized first, later threads made in the terminal read the originator "remi".

- **Arguments.**
  `-m/--model`, `-a/--ask-for-approval`, `-s/--sandbox`, `--add-dir`, `-i/--image` (not together with `resume`: Codex's own parser then takes `resume` and the id as image paths and starts a fresh session, which was seen live) and `--yolo` pass through; every other Codex flag and every Codex subcommand but `resume` is refused, so run `codex` directly for those.
  Everything after `--` is the first prompt, as text, never a flag (checked live with the words `help` and `completion bash`; `exec` and `login` after `--` were not run).
  Remi's own flags (`-h`, `--help`, `-v`, `--version`, `--dir`, `--port`, `--resume` and the rest) are remi's wherever they stand before `--`, so a Codex flag with the same name cannot be passed through remi.
- **Resume.**
  `remi codex resume <thread id>` takes the whole thread id, which `remi --sessions` prints under each exited Codex session.
- **The Codex app-server.**
  Codex's TUI starts and shares one app-server for all your Codex windows.
  Remi never starts, stops or upgrades it, and it ignores the threads of your other Codex windows, except that it cannot tell windows apart that share one directory (see "Which thread is yours").
  If remi cannot reach it for 30 seconds, it says so once in the remi log (and sends a system message that some clients, the web app today, do not show), and the session goes on in the terminal.
  Remi connects only to a control directory that only you can use (mode 700, owned by you), and checks that just before it connects, not along the whole path above it, so a directory someone else can swap in between the check and the connection is not covered.
- **Which thread is yours.**
  Remi picks its session's Codex thread by directory and start time, and a new thread says nothing about which window it is for.
  So with two or more Codex windows in one directory: two started together bind neither; a `/new` in one of two remi sessions there is followed by neither (each says so once); a remi session that has no thread yet and is under a minute old keeps another one in that directory from binding a new thread (the message says to restart one of them); and a plain `codex` window opened there while a remi session is idle looks the same as `/new` and takes the binding over (seen live; the remi log says "rotated" and the session tells you).
  Switching threads with `/resume` inside Codex is not followed.
  One directory per Codex window avoids all of it.
- **An older remi erases Codex session ids.**
  Codex thread ids are kept in `sessions.json`, and a remi older than 0.7.16-dev.7 that writes that file afterwards drops them.
  `remi codex` refuses to start while such a remi is running (`remi stop --all` stops it), and says so again when it starts, because it cannot stop an old binary that starts later.

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
- **Notifications** - Push alerts when Claude needs your input, and when a turn ends on an error such as a usage or rate limit. The text of a push (a prompt, the end of a turn, a failure's reason with a short excerpt of Claude's last message) goes through the signaling Worker and Apple's push service in plaintext; the relay encryption below does not cover it
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
bun test              # Run all tests (an exported REMI_HOME is ignored)
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

PRs welcome for the Apache-2.0 parts (`packages/daemon`, `packages/shared`, and everything outside the package directories).
Sign your commits with `Signed-off-by: Your Name <you@example.com>` (DCO style); see [`CONTRIBUTING.md`](CONTRIBUTING.md).
The PolyForm Shield packages (`packages/web`, `packages/signaling`, `packages/macos`) are published to be inspected, so we do not accept outside changes to them without a prior written agreement; talk to us first.
Security issues: see [`SECURITY.md`](SECURITY.md).

---

*Part of the [Yooz ecosystem](https://github.com/yooz-labs). Sovereign Intelligence. Built for the skeptical.*
