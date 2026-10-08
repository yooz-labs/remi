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

# Start Codex with Remi (status, command approvals, turn notifications and chat, see below)
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
2. Connect by direct address: through an SSH tunnel, or over your LAN or Tailscale once you widen `daemon.bind` (a connection code does not connect anything today, see [Connection Methods](#connection-methods))
3. Monitor and respond to all your agent sessions

### Codex (status, command approvals, turn notifications and chat; approvals checked live against Codex 0.160.0 on 2026-10-04, except subagents; bounded turn and chat checks on 2026-10-05)

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
When a turn ends, your phone is told the way it is for Claude: a turn that ran at least `turn_complete_min_seconds` (60 by default) pushes "turn complete" with the first 200 characters of Codex's final answer (`notifications.on_turn_complete` and the per-device switch mute it), and a turn that failed pushes "Codex stopped" with the reason and Codex's own words, which only the per-device switch mutes.
A turn stopped with the phone's No, TUI Esc, or `turn/interrupt` reported `interrupted` in the bounded live check below; the production mapper/sink test confirms that these statuses produce neither a done nor a failure push.
Turns that Codex's subagents run are not announced.
The app can load a Codex session's history (what you and Codex said, and the shell commands Codex ran, as a "shell" entry) and shows new messages as they finish; when remi attaches to the session's thread, and again after a reconnect, it also reads what the thread already holds, so the prompt that started a turn is in the chat (a thread with more than 100 returned items, or another page, is left to the history load); a session that has not started its thread has no history yet, and an exited session's history is not loaded.
Control and bidirectional characters in what Codex says about a failure, and in a command and its output, are shown as visible escapes, and are removed from the answer in the push (an emoji sequence keeps its joiner); chat text is shown as Codex wrote it.
The final answer in the push goes through the signaling Worker and Apple's push service in plaintext, like the cards.
A message typed in the app to a Codex session is refused (the app shows it as failed, "type in the terminal") instead of being typed into Codex, because remi cannot see what Codex has on screen.
The command is in the card and in the push notification (the ask, up to 120 characters in the title and 200 in the body), which goes through the signaling Worker and Apple's push service in plaintext, as every card does; a command can contain a secret.
The relay is off by default, and no shipped client can join a relay room. Since #1193, the daemon creates no relay adapter or Worker connection without an authenticated permanent-code setup; an adapter refuses outbound messages until session keys exist and encrypts them before sending. The push is separate: its cut ask above still travels in plaintext to the Worker and APNS.
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

**Bounded Phase 6 check** (2026-10-05; Codex 0.160.0, GPT-6.1-Sol, one controlled account): two controlled turns completed; the long turn's `durationMs` and observer wall time were both 66,965 ms (it ran `sleep 61`, not a CPU workload). Three turns stopped through phone No (a local WebSocket protocol client exercising the daemon answer path), TUI Esc, and `turn/interrupt` each reported `interrupted`; an early interrupt attempt returned -32600 and the retry after the turn started succeeded. A bad-model turn reported `failed` after 243 ms, with `codexErrorInfo: "other"` and the captured error details. The observer received one completion event for each of these five turns. Its first minimal completed turn happened before the observer subscribed, so it is not included in that count.

The captured `thread/items/list` requests used `sortDirection: "asc"` and `limit: 100`; their responses had `{data: [{turnId, item, startedAtMs, completedAtMs}], nextCursor, backwardsCursor}`. The first page held the controlled first prompt and its `final_answer`, with no injected environment or instruction message. A second captured page held six rows; its command row had the same item id as the live `item/completed` frame. Reasoning-item strings are redacted in the public fixture and marked in its index. This is one current-model/account sample, not a model matrix. Before the first message, `thread/items/list` returned -32601 and `thread/resume` returned -32600; after the first write, both requests worked. On a later successful resume, catch-up delivered ten `transcript_content` entries including the first prompt exactly once and no `structured_agent_output`; this confirms that resumed catch-up case, not event ordering before an initial attach. No physical iPhone or APNS delivery was tested. The redacted frames are in [the LV-5 fixture](packages/daemon/tests/fixtures/codex-app-server/lv5.jsonl); the full evidence limits are in [ADR 0033](.context/decisions/0033-codex-adapter-app-server.md).

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
- **Direct connection methods** - Direct WebSocket over an SSH tunnel, or over your LAN or Tailscale once `daemon.bind` is widened. A Cloudflare relay exists in the code but is off by default and nothing remote ships through it today
- **Chat view** - Clean conversation interface without terminal noise
- **Live updates** - Agent messages stream in real-time as work progresses
- **Cross-platform** - iOS, Android, Web, macOS, Windows, Linux
- **macOS menu-bar app** - a status "r" tracking live connections plus the full web UI in a native window; see [docs/MACOS_APP.md](docs/MACOS_APP.md)
- **Notifications** - Push alerts when Claude needs your input, and when a turn ends on an error such as a usage or rate limit. The text of a push (a prompt, the first 200 characters of a turn's last message, a failure's reason with a short excerpt of Claude's last message) goes through the signaling Worker and Apple's push service in plaintext; the relay encryption below does not cover it
- **Relay (off by default, no shipped client)** - the relay is being rebuilt, and no client in this repo can join a room or complete its key exchange. With `network.relay = true` the daemon prints a notice and starts no relay unless it also has an authenticator: `--auth --permanent-code` (or `[auth] enabled = true` plus `--permanent-code`), which turns the relay on by itself, even over `relay = false`. Without an authenticator no adapter exists, so the daemon holds no connection to the Worker, and an adapter built anyway refuses every peer and drops every inbound message (#1193). With an authenticator the daemon side runs an authenticated key exchange (P-256 ECDH signed by each side's Ed25519 identity) and seals the messages after it with AES-256-GCM, so the Worker cannot read them; the handshake messages and a few error replies that name a message type are not sealed, and the Worker still sees the room code and who talks to whom and when. **First connect requires local approval (#873):** a valid unknown identity remains rejected until the daemon machine authorizes its exact pending fingerprint. Knowing a room code never adds a key. `--no-tofu` is accepted only as a retired flag. No client implements the other half of the key exchange yet (#881)
- **Authentication on by default (#873)** - `auth.enabled = "auto"` requires an authorized Ed25519 identity on every bind, including loopback. CLI clients may instead present the local capability token over a real loopback TCP connection. Compare the fingerprint shown on your client with `remi keys` on the daemon machine, then run `remi authorize <exact-fingerprint> --label phone` there and retry the connection. Or run `remi pair` on that machine: it shows a QR code for the app to scan, then asks you there to approve the phone by typing the first four characters of its fingerprint, which you compare with the app (#1275); the code works once and approves nothing by itself. No released app scans it yet (#1283). Candidates expire after ten minutes, with at most 32 waiting, four of those slots kept for pairing claims; retries do not extend expiry. Explicit public-key imports still work; share only `remi export-key --public-only` output. To authorize a device before it connects, or on machines that are rebuilt, see [docs/PROVISIONING.md](docs/PROVISIONING.md). `--no-auth` or `[auth] enabled = false` disables this protection and prints a visible warning. Old `daemon.require_local_auth` settings are ignored with a retirement notice. Signed HTTP answers require an already authorized identity and cannot request approval. Small-order Ed25519 public keys are refused before trust or authentication. Malformed `auth.enabled` values fail before a listener opens. Storage failures return the generic `AUTH_STORE_ERROR` code; private diagnostics stay on the daemon machine. Physical signed iPhone and sandboxed macOS acceptance remains unverified by the automated tests.
- **No cloud dependency** - direct connections never touch a server at all. On a stock install only the SSH tunnel works out of the box: LAN and Tailscale direct need `daemon.bind` widened first (#880). Do **not** use `tailscale serve` for this: it is a same-host reverse proxy, so the actual remote peer address is lost. Authentication remains required; use the documented SSH or direct-bind setup. The relay is off by default and nothing remote ships through it today

## Connection Methods

```
Phone/Browser ──► Direct WebSocket (same network, Tailscale, VPN — needs daemon.bind widened)
                ──► SSH Tunnel (ssh -L 28765:localhost:28765 server)
                ──► Relay (planned: off by default, nothing remote ships through it today)
```

The relay is being rebuilt; until that ships, remote access is an SSH tunnel, or a direct connection over LAN or Tailscale with `daemon.bind` widened and `--auth`.
The connection code that `remi code` prints belongs to the relay, so it connects nothing today.

## Architecture

```
┌─────────────────────┐                      ┌─────────────────────┐
│   Your Phone        │                      │   Your Dev Machine  │
│   (Remi App)        │◄════════════════════►│   (Remi Daemon)     │
│                     │   WebSocket (direct)  │   mDNS: _remi._tcp │
│   Chat View         │   (no relay today)   ├─────────────────────┤
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
- **Transport:** WebSocket (direct). A Cloudflare Workers relay exists but is off by default and nothing remote ships through it today
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
- **Mobile and web client, hosted relay, and the Mac and iPhone apps** (`packages/web`, `packages/signaling`, `packages/macos`, `packages/native`): [**PolyForm Shield 1.0.0**](packages/web/LICENSE.md).
  You can read, fork, modify and use them for any purpose **except** building a competing product, so you cannot offer a re-skinned commercial fork of the app or the relay.
  For the strategic rationale, see [`yooz-engine/LICENSING.md`](https://github.com/yooz-labs/yooz-engine/blob/main/LICENSING.md).
- **Everything else** (scripts, docs, CI configuration): Apache-2.0 unless a file says otherwise.

The `@yooz-labs/remi` npm package is a small Node launcher; the platform packages it installs hold the compiled `remi` binary, which bundles daemon and shared code plus third-party dependencies.
The npm packages are Apache-2.0, and the bundled dependencies keep their own licenses; their notices ship as `THIRD_PARTY_NOTICES`, except the embedded Bun runtime's (see [`LICENSE.md`](LICENSE.md)).

For commercial-use or dual-license inquiries about the PolyForm Shield parts: **dev@yooz.info**.

## Contributing

PRs welcome for the Apache-2.0 parts (`packages/daemon`, `packages/shared`, and everything outside the package directories).
Sign your commits with `Signed-off-by: Your Name <you@example.com>` (DCO style); see [`CONTRIBUTING.md`](CONTRIBUTING.md).
The PolyForm Shield packages (`packages/web`, `packages/signaling`, `packages/macos`, `packages/native`) are published to be inspected, so we do not accept outside changes to them without a prior written agreement; talk to us first.
Security issues: see [`SECURITY.md`](SECURITY.md).

---

*Part of the [Yooz ecosystem](https://github.com/yooz-labs). Sovereign Intelligence. Built for the skeptical.*
