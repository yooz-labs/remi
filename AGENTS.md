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
                           │ WebSocket (direct; remi adds no encryption, ADR 0009)
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
`tests/harness/harness-boundary.test.ts` keeps `harness/types.ts`, `harness/decision.ts`, `cli/current-session.ts`, `cli/session-phases/pty-session-setup.ts` (the PTY spawn, which takes its command, environment and output sink as parameters), `cli/handlers/`, `api/` and `session/` from importing `hooks/`, `auto-approve/`, `transcript/`, `cli/session-phases/`, `cli/claude-binding` or the Claude screen parsers, apart from three documented handler imports (chat-seam debt); fix the import rather than adding to that list.
A second rule lets only `cli.ts` and `harness/` import `harness/index`, `harness/claude` or `harness/claude-session` at runtime, which keeps the launch path from becoming an import cycle.
A third is an allowlist for `harness/codex/` (`CODEX_MAY_IMPORT` in the test): its own files, `node:*`, `@remi/shared`, `harness/types`, `harness/decision`, `cli/session-phases/pty-session-setup.ts` (and no other session phase) and, under `session/`, the session store, binding store, registry, live-sessions registry file, `legacy-writers` and `shell-quote`, plus `api/message-api` (the chat history's bullet structuring) and `notifications/turn-events` (as a type only, which a test pins); and only `cli.ts` may import `harness/codex/`, which is why `harness/index.ts` does not re-export it.
`remi codex` is the Codex adapter (epic #1175, ADR 0033): it launches Codex, finds the session's thread on the shared app-server, reports its status, shows the thread's command approvals as phone cards (see "Codex approvals" below), pushes how each turn ended and serves the thread's chat (see "Codex turn events and chat" below), and typed chat from a client is refused (`PROMPT_WAITING`) (`.context/codex-epic-plan-2026-10.md`).
The wire names the harness (`harness`, `harnessSessionId`, `hello_ack.harnesses`; see "Harness identity and `create_session_request`" below).
`Harness` has no `command`: the PTY spawn takes an optional `launch: {command, childEnv}` and an `outputSink`, and absent `launch` it is the Claude launch; `CodexHarness.preflight` (not a `Harness` member) is what `cli.ts` calls before it boots a Codex launch.
`Harness.transcriptPath` may return `null` (no transcript file), which every reader treats as "no file".
The store reads are harness-aware (#1176): `getMostRecent('claude')` and `resolveStoredSession(..., {harness: 'claude'})` (Claude-only since #1179: nothing resolved a Codex record by remi id or prefix, so that branch is gone) skip or refuse a record of another harness, `findByClaudeSessionId` and `updateClaudeSessionId` are Claude-only, and `--sessions` labels a record `claude:<first 8 of its id>` or, for another harness, `<harness>:<last 8 of its id>` (a Codex thread id is a UUIDv7, whose first eight characters are a timestamp).
`session/legacy-writers.ts` (the older-daemon gate, read before any Codex record is written) and `harness/codex/codex-args.ts` (argument validation) are called by the Codex launch; the gate narrows the older-daemon hazard and does not close it (see its header).

## Repository Structure

```
remi/
├── packages/
│   ├── daemon/          # Bun + TypeScript backend, CLI, PTY, sessions
│   ├── shared/          # Protocol, crypto, identity, types
│   ├── signaling/       # Cloudflare Workers signaling / relay service
│   ├── macos/           # Native Mac app (Swift)
│   └── web/             # React + Vite + Capacitor client
├── tests/
│   ├── e2e/             # Playwright end-to-end tests
│   └── integration/     # Integration scripts and Docker assets
├── scripts/             # Release / publish / install helpers
├── .context/            # Plan, research, ideas, scratch notes
└── .rules/              # Repo-specific standards
```

`packages/daemon` and `packages/shared` are the Apache-2.0 packages (see `LICENSE.md`); they must never import code from the PolyForm Shield packages (`packages/web`, `packages/signaling`, `packages/macos`).
`packages/daemon/tests/license-boundary.test.ts` enforces it.

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
(WebSocket, mDNS, the relay when enabled, Telegram, device tokens), serves the machine's
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
- A `create_session_request` may name a harness and its arguments (#1179, "Harness identity and
  `create_session_request`" below). The hub itself is still session-less and Claude-only: it only
  spawns the child daemon that hosts the Codex or Claude session.
- A `resume_session_request` that reaches the hub is **refused**
  (`resume_session_response{success:false, errorCode:'UNSUPPORTED'}`,
  `cli/handlers/resume-session-events.ts`, #1124), never run: before the guard
  the shared handler called `createNewSession` inside the hub, and when that
  Claude exited the hub exited 0 and the LaunchAgent did not restart it.
  Resuming *through* the hub (spawn a child daemon) is not implemented: a
  `remi --daemon` child reads Claude args only from after a `--` since #1179
  (a hub appends the ones it validated there), which is the first half of it,
  but a resumed session's binding and hooks through a child are unverified and
  the web resume flow cannot follow a session on another port. Tracked as
  #1129. `remi --resume <session>` from a terminal works. A daemon that hosts
  Codex refuses `resume_session_request` the same way (#1179).

## Transport Options

| Method | When to use |
|---|---|
| Direct connection | Same Wi-Fi, Tailscale, VPN, SSH tunnel |
| Signaling relay | Not usable today. Off by default, and nothing remote ships through it (see below) |

**Direct connection now requires setting `daemon.bind` (#880).** The default is
`127.0.0.1`, so a stock daemon accepts only loopback: SSH tunnels still work
untouched, but **LAN direct, Tailscale direct (100.x) and mDNS
discovery all stop** until the user opts in. mDNS does not even advertise on a
loopback bind (`cli.ts` skips the publisher), so the daemon does not fail — it
disappears, which is the confusing half.

Do NOT recommend `tailscale serve` as the workaround. It is a same-host reverse
proxy, so every tailnet peer arrives as `127.0.0.1` and loses its actual
peer address. #873 requires identity or a real local capability even on loopback;
keep the documented direct setup. Recommend an SSH tunnel, or an explicit `bind` plus
`--auth`.

**The relay is off by default, and without an authenticator it accepts nothing (#1193).**
`network.relay` defaults to `false`; `network.relay = true` or `--permanent-code` turns it on, `--permanent-code` wins over `relay = false`, and `--no-relay` wins over both.
Without `--permanent-code`, or with auth explicitly disabled, `cli.ts` prints a notice (how to enable it, what to use today, and how to silence it with `network.relay = false` or `--no-relay`) and creates no adapter, so the daemon holds no connection to the Worker.
`RelayAdapter` fails closed on its own as the second layer: it refuses every peer (`auth_result` with `RELAY_AUTH_REQUIRED`, `onConnect` never fires), drops every inbound `relay` payload before it is parsed (the signaling client has already parsed the outer frame), and acts on `peer-connected` and `peer-disconnected` only for the Worker role `client`.
The role check matters because the Worker gives a socket that never joined the role `pending` and tells the host whenever any socket closes (`connection-room.ts`), and because the Worker can deliver a `relay` frame to the host with no peer ever having joined, so the frame drop is what closes that path.
A `config.toml` that already holds `relay = true` (`remi config init` wrote it before #1193) keeps the setting and now gets the boot notice instead of a relay.
No shipped client can use the relay: the web client has no code that joins a room or does the key exchange, and no native client holds a signaling URL.
The rebuild is planned (`.context/strategy-2026-10.md` section 9, `.context/relay-rebuild-plan-2026-10.md`); nothing remote ships through the relay today.

**Authentication and local first-connect approval (#873).**
`auth.enabled = "auto"` now enables authentication on every bind. Unknown keys
never become trusted automatically: `Authenticator.verifyResponse` verifies a
one-time challenge, canonical Ed25519 public key and derived fingerprint before
storing an unsuccessful `UNKNOWN_KEY` candidate. Candidates hold only the public
key, derived fingerprint and first-seen/expiry timestamps (32 keys, ten minutes,
no retry extension). `remi keys` shows pending and authorized public keys;
compare the client's fingerprint and run `remi authorize <exact-fingerprint>
--label phone` on the daemon machine, then retry with a fresh challenge.
Explicit JSON/file authorization is still available; share only
`remi export-key --public-only` output. Detached signed `/answer` requests use
already authorized keys and never create candidates.
`require_local_auth` has been removed; old values are ignored with a visible
retirement notice. `--no-tofu` is accepted with a retirement notice and changes
no trust behavior. Explicit `--no-auth` or `auth.enabled = false` still disables
auth with a warning. A valid daemon capability over actual TCP loopback is the
other admitted path; bare loopback clients are challenged. Pending/authorized
mutations share an interprocess lock and atomic restricted files; approval
persists the grant before deleting its candidate. Physical signed iPhone and
signed sandboxed macOS acceptance remain unverified owner hardware gates.

**There is no WebRTC.** No `RTCPeerConnection` or data channel exists anywhere
in this repo. The worker was built to relay a *handshake*, with WebRTC intended
to carry the session; that second half was never implemented, so the relay was
left as a data transport that no shipped client can use, and the only remote
paths that work today are direct ones (an SSH tunnel, or an explicit `bind` plus
`--auth`).
Anything describing a peer-to-peer path, DTLS, or TURN relaying opaque blobs is
describing an intention, not this codebase (#543).

## Question Detection and Notifications

See `.context/notification-and-session-flow.md` for the full flow diagram.

**Question sources** (daemon side):

- `HookEventBridge` — emits questions from `PermissionRequest` hooks; suppresses redundant notifications.
- `OutputProcessor` — PTY-output parsing (fallback when hooks are unavailable).

**remi relays permissions; Claude Code decides them** (#1125,
[ADR 0030](.context/decisions/0030-defer-permission-judgment-to-the-harness.md)).
There is no auto-approve evaluator and no rule layer: remi never answers a
permission without a human choice. `AutoApproveGate` (a historical name; it is
the relay) owns every `PermissionRequest` hook response.

**A binary prompt is answered through its held hook while Claude's own dialog
stays visible** (#1126, [ADR 0031](.context/decisions/0031-held-hook-answers-with-native-dialog-visible.md)).
Verified on Claude Code 2.1.287: the dialog renders about 0.1 s after the hook
POST, during the hold. The gate stashes the card, holds the hook, and pushes
the card at once by id (`holdForAnswer` -> `onHeldEscalate` ->
`pushHeldHook`). The first answer wins:

- **Phone:** `answerHeld` maps the card option's MEANING to the hook response,
  never a position on Claude's screen: `Yes` -> `allow`; `No` -> `deny` (an
  optional `message` on the answer reaches Claude as the tool result; the
  protocol carries it, no client sends it yet; Cancel on a held card is a
  No); a standing option -> `allow` + `updatedPermissions`,
  only for `setMode` and an allow `addRules` (labeled "for this session"),
  BOTH echoed with `destination: "session"` so a phone tap never writes a
  settings file; `standingGrantFor` in `hook-event-bridge.ts` is the one
  place that decides, and it stamps the option's `standingGrant` kind.
  The web card reads that kind, never the label's wording (#1155): its hint
  says "This session" for a standing option and "Allow once" only for the
  plain Yes. Telegram does not read it; it keeps every label whole instead:
  a button is cut at 32 characters, so when any label is cut the message
  lists every label in full and numbers the buttons (no buttons when the list
  does not fit in one message).
  `addDirectories` is never offered (its echo did not stop the repeat
  prompt). An answer the card does not offer is refused and the hold stays.
  The lock screen's static "Yes, always" (`REMI_YNA`) is chosen only for an
  `addRules` grant (`selectPushCategory`); a `setMode` card gets no
  actionable category.
- **Terminal Yes:** Claude runs the tool and never closes the held request.
  `PermissionRequest` has no `tool_use_id`, so it is paired on arrival with
  the in-flight `PreToolUse` of the same agent, tool and input (about 10 ms
  earlier); the `PostToolUse`/`PostToolUseFailure` with that id releases the
  hold with an empty response and dismisses the card. It arrives only when
  the tool finishes, so during a long command the card stays up and a phone
  answer is accepted and ignored by Claude. Two identical calls in flight are
  not paired; a name + input match then releases the hold to the terminal
  (card dismissed, prompt kept open, a "handed back to the terminal" notice
  pushed), never closes it. Every release of a live hold that is not an
  answer pushes a notice (`onReleasedToTerminal`).
- **Terminal No / Esc:** Claude closes the held request. `HookServer` hands the
  resolver `req.signal`; its abort (also a session end) dismisses the card
  (an abort at Claude's own hook timeout is handled like the deadline, see
  below). No hook fires for it, so a new
  `UserPromptSubmit` also closes main prompts left open.
- **Deadline:** in wrapper mode at `[prompts] hold_seconds` (default 90, 5
  to 110: under the 2:00 auto-deny of auto-mode fallback prompts, which
  counts during a hold, and the 600 s registered hook timeout) remi releases
  its own hold with an empty response, the dialog stays, the card is
  dismissed and an "answer at the terminal" notice is pushed (#733). A daemon
  or hub session has no terminal of its own, so it holds for
  `[prompts] daemon_hold_seconds` (default 3540, 5 to 3540) and registers
  the hook with a 3600 s timeout (`DAEMON_PERMISSION_REQUEST_HOOK_TIMEOUT`;
  Claude honors it, measured: a 650 s hold answered at 653.6 s ran the
  tool); its notice says `remi attach`, the only way left to answer. An
  abort within 5 s of the registered timeout (`hookTimeoutMs`) is Claude's
  timeout, not a terminal No: released to the terminal with the notice,
  like the deadline (which normally comes first). An auto-mode
  fallback prompt still auto-denies at 2:00 there; Claude fires
  `PermissionDenied` for it (measured), which dismisses the card and pushes
  a `harness_denied` notice. The notice never claims the
  prompt is still waiting (a terminal Yes may already have answered it); it
  is dismissed when the prompt resolves, and a late phone answer does not
  resolve it.

An empty response never decides anything; it is what every non-answer path
sends.

**AskUserQuestion and ExitPlanMode are held the same way** (#1127, ADR 0031
amendment): their dialogs render during the hold, and a phone answer
resolves the hook with a structured `updatedInput` built in
`hooks/structured-answers.ts`, never typed. Verified on Claude Code 2.1.287:

- **AskUserQuestion:** one card for the whole call (each question's text,
  header, options with descriptions, `multiSelect`). The phone sends
  `selections` (option indices per question, or `text` for a single-select
  question); the gate validates them against the tool input and answers
  `{behavior:"allow", updatedInput:{...tool_input, answers}}`, `answers`
  keyed by the raw question text, a multi-select as its labels joined with
  ", ". An answer that leaves a question unanswered, gives a single-select
  question anything but one option or its own text, gives a multi-select
  question no option or text, or names an option that does not exist is
  refused and the hold stays (never completed with a guess); so is every
  answer to an input that does not parse exactly, whose card is marked
  `terminalOnly` (no lock-screen category, no Telegram keyboard, "This
  question can only be answered in the terminal (or Cancel)."). A single option answers
  only a one-question single-select call: the lock screen sends its label,
  Telegram its value, and on any held card a string that is one option's
  value and a DIFFERENT option's label (numeric labels) is ambiguous and
  refused, the hold kept. Cancel denies with "The user dismissed the
  question."
- **ExitPlanMode:** a `plan_approval` card with the plan as `detail` and
  three options by meaning: "Approve, auto-accept edits" / "Approve, approve
  edits manually" (`allow` + the tool input echoed as `updatedInput` + a
  `setMode` `acceptEdits` / `default` with `destination: "session"`) and
  "Keep planning" (`deny` with the phone's message or "Keep planning.";
  Claude revises and asks again). `auto` is not offered (not knowable from
  the payload); the terminal still offers it. Cancel keeps planning. A
  subagent's plan (held in daemon or hub mode) offers "Approve" (`allow` +
  `updatedInput`, no `setMode`: a mode would apply to the whole session)
  and "Keep planning".
- A terminal answer fires `PostToolUse` with the paired `tool_use_id` but a
  different `tool_input` (`{questions, answers}`, or `{}` for a plan), so
  the gate matches a paired id whatever the input. If the request was not
  paired, a finished call of that tool that matches nothing releases the
  one open hold of that tool and agent to the terminal (notice pushed);
  with two or more, nothing is released. Deadlines, abort,
  subagent routing and the chat guard are the binary prompt's.

A **multi-choice string-label permission**, or a question-shaped tool that is
not AskUserQuestion, is still answered `passthrough` and pushed by id at once
(no structured hook answer was verified for either). The permission's answer
is typed behind the #1134 guard. The question-shaped tool's card is
`terminalOnly` (its dialog is Claude's permission prompt, not its questions):
no Telegram buttons, no lock-screen category, and every phone answer is
refused with the terminal wording, never typed. A structured `selections`
answer for a card no hold stands behind is refused, never typed. An open card is also resolved by a matching `PreToolUse`/`PostToolUse`/
`PermissionDenied`, a lead `Stop` or new user prompt (main), `SubagentStop`
(that agent), `SessionEnd`, a transcript rotation, or `remi unstick`; a
dismissal is broadcast only for a card that was actually pushed. `remi
unstick` does not close a LIVE hold: its dialog is on screen, so it is
released to the terminal with a "handed back" notice (suppression kept),
and a second unstick clears it.

**No card answer is typed into the PTY for a hook-backed binary prompt**
(raw input from `remi attach` and the phone's Escape button still reach the
dialog by design: they are a person at the terminal). While a
MAIN-agent hook is held, or a prompt waits in the terminal (`terminalPrompts`:
a hold released at its deadline or early, or a rendered wrapper-mode subagent
dialog) for less than the session's hold length, the tracker treats a PTY
render as that dialog (`setHookPromptProbe` -> `hasOpenHookPrompt`), never as
an orphan, so no typed card is rebuilt from it; for a wrapper-mode subagent
prompt the phone keeps exactly one artifact, its notice. The probe is bounded
on purpose (#1126 lead decision), since everything it counts suppresses a
hook-less prompt's card (sandbox network, trust, an agent-team dialog). Only
what does not render is excluded: a subagent HOLD (daemon mode) never counts,
since its dialog does not render while held, neither in this probe nor in the
tracker's other suppression input, the live-question check
(`hasLiveQuestionOnScreen`, which skips a held subagent card; every other
registered card still counts). A `terminalPrompts` entry stops
counting after the hold length, and a subagent's entry is also cleared by
that agent's next `PreToolUse` (`noteAgentToolCall`), `SubagentStop` or
`SessionEnd`; past that a redraw takes the guarded hook-less path (#1134,
fail closed). `handleAnswer` asks
the gate first (`gateAnswerDeps`): a held card is answered through the hook,
and a binary card whose hold has ended is refused (`closed`: answer at the
terminal), never typed. While a main-agent hold is open its dialog is on
screen, so `onUserInput` refuses chat text with `PROMPT_WAITING` even before
the screen parse sees the menu (#1140; `promptUp`, below). Its message is
`PROMPT_WAITING_HELD_MESSAGE`, which does not claim a dialog is up: after a
terminal Yes the hold lasts until `PostToolUse`, so the refusal also covers
the approved command's run (#1144).

**A typed answer carries the screen's numbering** (#1134). This applies only
where no held hook stands behind the card: hook-less prompts (sandbox network,
trust, agent-team dialogs; not all of them reach the phone, the daemon's
startup folder-trust dialog does not, #1147) and multi-choice cards
(AskUserQuestion and ExitPlanMode are held since #1127). When a hook record merges onto a parsed prompt
(`QuestionPresenceTracker.consumeAndMerge`), the card's options are the
parse's options, labels and values unchanged; the hook contributes id, text,
agent, source and tool metadata (including `allowsFreeText`: a permission
dialog takes a pick, not text), never options. The parse carries no yes/no
flags, so the merge sets `isYes`/`isNo` from labels that start with the exact
word "Yes" or "No". Live, before #1134, `addDirectories` + `setMode`
suggestions built a 4-option card over a 3-option dialog, the phone's "No"
typed `4`, Claude ignored it, and the Enter that follows every typed answer
confirmed "1. Yes".

**Every typed phone answer is checked against the screen first.** Guards
in `handleAnswer` before anything is typed (all refuse like a stale answer:
STALE_ANSWER, card consumed, trace reason in parentheses). A refusal means
"answer at the terminal": Claude's own dialog is still there.
- a prompt must be on screen: the card's own prompt for a `source: 'pty'`
  card (`prompt-not-current`, #920), any prompt for a hook card
  (`no-prompt-on-screen`, #1002).
- an option value must be on the menu the tracker last observed
  (`observedPromptOptions`, wired by `trackerScreenDeps`) (`option-not-on-screen`),
  and that screen option's label must EQUAL the card option's after
  normalization (lowercase, all whitespace and box characters removed), or,
  for a pick with a description (a card built from a tool's `questions`; a
  `terminalOnly` card is refused before this check), equal it with
  the description appended (`option-mismatch`). Nothing looser: it fails
  closed; the accepted cost is false refusals on short, partial-frame or
  reworded labels. A pushed-by-id card keeps the hook's numbering, so this
  refuses its digit wherever the hook's list differs from Claude's.
- free text is refused when the card has options and takes no text and a
  numbered menu is on screen (`free-text-into-menu`), and always on a
  pushed-by-id (`held`-stamped) card that has options and takes no text
  (`free-text-on-held-card`). A structured `selections` answer on a card
  no hold stands behind is refused before anything is typed
  (`selections-not-held`, #1127). Free-form `user_input` (including a Telegram
  text reply) is a separate path with its own guard, next.
- a question is claimed while its answer is applied: a duplicate delivery of
  the same choice (the lock screen sends every tap on two channels) reports
  delivered and types nothing; a different concurrent answer is refused.

**Chat text and Stop's `/exit` are refused while a prompt is up** (#1140,
#1155). `onUserInput` types structured input (web chat, a Telegram text reply
or custom text) followed by Enter, and a Stop (`onKillSessionRequest`) types
`/exit` + Enter; into a Claude dialog the letters are ignored and the Enter
confirms the highlighted option, usually "1. Yes", so a message or a Stop sent
from the phone while a prompt waits would approve it. Both read ONE signal,
`promptUp` (`cli/handlers/prompt-up.ts`, built once in `cli.ts` by
`promptUpDeps` and spread into both handler factories; a source-level test pins
that wiring), which says a prompt is up when any of three sources does:

- `held`: a main-agent hook is held (`hasMainHold`; its dialog renders during
  the hold);
- `terminal`: a hook-backed prompt waits in the terminal (`hasOpenHookPrompt`
  beyond a main hold: a hold released at its deadline or handed back early,
  or a rendered wrapper-mode subagent dialog, each for at most the session's
  hold length);
- `menu`: the tracker observes a numbered selection box
  (`observedPromptOptions`; `isNumberedMenu`: every option value is numeric),
  which covers hook-less prompts.

Before #1155 Stop read only the screen parse and the chat guard only the parse
and a main hold, so a dialog the parse missed (or that a text status had
cleared) got the typed Enter. While a prompt is up the chat guard types nothing
and the sender gets an `error` with code `PROMPT_WAITING`, its message by
source (`PROMPT_WAITING_HELD_MESSAGE`; `PROMPT_WAITING_TERMINAL_MESSAGE`,
"Claude is waiting on a prompt in the terminal. Answer it there, press Esc from
the app, or run remi unstick.", since the card is gone; or
`PROMPT_WAITING_MESSAGE`:
"Claude is waiting on a prompt. Answer it from its card or in the terminal (Esc
dismisses it)."; all in `@remi/shared` with `createPromptWaitingError`), plus a
trace record (`input_refused`, reason `chat-into-held-prompt`,
`chat-into-terminal-prompt` or `chat-into-menu`). Telegram renders it as
"Error: ..."; the web client marks the refused bubble failed from
`details.messageId`. Stop types no `/exit` and force-closes the session
instead.

Deliberately typeable: raw input (`raw: true`, an attach client's keystrokes,
the web client's Escape button and Telegram's `/interrupt`, which is how a menu
gets answered or dismissed; its Escape is written exactly, no Enter); a
subprocess `(y/n)` prompt, or Claude prose ending in "(y/n)", which observes
options "y"/"n" and takes text; a free-text prompt (an empty option list); and
anything when nothing is up. A raw write that fails is answered with
`INPUT_NOT_DELIVERED`, and `/interrupt` then shows that error instead of
"Interrupt sent". The parser returns `allowsFreeText: false` (and
`optionsAreFallback: false`) for a Claude selection box, so a hook-less card is
covered by the `free-text-into-menu` guard above and its Telegram card no
longer says "reply with custom text"; a hook record's own flag still wins when
one merges.

What clears the observation (so what unlocks the chat): a status change with no
agent, that is a main-agent hook event (PreToolUse, PostToolUse, Stop,
`idle_prompt`, ...) or a PTY-parsed non-waiting status, including Claude's
empty input prompt (a bare `❯` as the last non-empty line) read as idle while a
prompt is believed up; and `clearPending`. A status carrying an `agent_id`
(SubagentStart/SubagentStop, a teammate's notification) does NOT clear it: a
background agent's activity says nothing about the main dialog. A subagent's
Pre/PostToolUse never reaches the status pipeline at all.

Limits, stated so nobody has to rediscover them. (1) Esc in the terminal fires
no hook, so the observation outlives the dialog until a clear event above: the
idle-prompt recognition when the redraw matches it (no capture of the redraw
right after an Esc exists, so that exact frame is not claimed), otherwise the
next status or Claude's own `idle_prompt` notification, which it sends only
after the session has sat idle for a while. Until then the chat is refused (the
card and the terminal still answer). (2) `submitInput` writes the text, waits
50 ms, then writes the Enter; the observation is checked once, before the
text, so a menu that renders inside that window still gets the Enter. Chat has
no atomic "no prompt now" check to wait on. (3) A PTY-parsed status is a text
guess and can clear the observation while the menu is still up; for a
hook-backed prompt the gate's half of `promptUp` still refuses then. (4) The
no-tracker branch is effectively dead in production: `cli.ts` builds a tracker
for every session, hook server or not. It exists for a caller that does not
wire `promptUp` (tests, a future entry point) and it fails open (types the
text), the opposite of the answer guards above. (5) A `terminal` entry counts
for the session's hold length from when it is MARKED (the deadline release,
the early hand-back, or the subagent dialog's render), not from the prompt's
start: in wrapper mode up to `hold_seconds` (90 s) after a deadline release,
about twice the hold from the start; in daemon or hub mode up to
`daemon_hold_seconds` (about 59 minutes). A No answered at the terminal fires
no hook, so the entry can outlive its dialog; in that window Stop
force-closes instead of typing `/exit` (kept by lead decision: a forced close
is always safe) and chat is refused. Ways out: an answer a hook sees (the tool
runs, `Stop`, a new prompt; a subagent's next tool call or `SubagentStop`), a
bare Esc sent through remi (web Esc button, Telegram `/interrupt`, an attach
Esc key), which clears the MAIN agent's entries (`noteTerminalEscape`,
#1155), and `remi unstick`. An Esc typed at a wrapper session's own terminal
does not pass through remi and is not seen. The opposite direction: once an
entry ages out, a dialog still on screen whose parse a text status cleared is
no longer guarded (chat would be typed into it, Stop would type `/exit`).

The parser joins a label's wrapped rows (and an AskUserQuestion description
row) onto the option above, at most two rows, never across footer rows
("Esc to cancel · ..."), dropping divider rows; it used to end the option list
at the first such row and drop every later option, "No" included.


**Subagent permissions follow the terminal**
([ADR 0004](.context/decisions/0004-pty-as-arbiter-subagent-questions.md), amended
by ADR 0030 and ADR 0031). A background subagent's dialog does NOT render while
its hook is held (verified live), so the gate takes a required
`hasLocalTerminal` (wrapper mode, fixed at session setup):

- **Wrapper mode (a local terminal):** an `agent_id`-tagged `PermissionRequest`
  is answered `passthrough` so its dialog renders, and parked
  (`passSubagentToTerminal` → `QuestionPresenceTracker.parkAwaitingPTY` with
  `onRender`). When the dialog renders, the phone gets an informational
  "answer at the terminal" notice, never an answerable card; the notice is
  dismissed when the prompt resolves. With no park path the notice is pushed
  at once.
- **Daemon or hub mode (no local terminal):** nobody could answer a rendered
  dialog, so the request is escalated exactly like a main-agent prompt: held,
  with an answerable card. A lead `Stop` spares it; that agent's
  `SubagentStop` releases it. Claude does not fire `PermissionRequest` for a
  call its own allow rules permit (measured on 2.1.287 for background,
  foreground and main calls), so these holds are only for real prompts.

**`subagent_alert` covers what never prompts** (#807, #1155;
`auto-approve/subagent-alert.ts`, patterns in `[notifications]
subagent_alert`). It is for any subagent, foreground or background (any
`agent_id`-tagged call), never the main agent. Because a call the allow rules
permit fires no
`PermissionRequest`, the alert is fed from the tool hooks, in both modes: an
agent-tagged `PreToolUse` whose call matches a pattern is remembered, a
`PermissionRequest` or `PermissionDenied` for that call forgets it, and its
`PostToolUse` or `PostToolUseFailure` delivers the alert (rate-limited,
daemon-wide); `SubagentStop` forgets the agent's unfinished calls. One call
therefore produces at most one phone artifact: a call that prompts gets its
"answer at the terminal" notice (wrapper mode) or its held card (daemon or
hub mode), the actionable one, and never an alert as well; a call that ran
without asking gets the alert. The alert arrives when the call finishes (the
first moment remi knows it ran unasked), so a long command's alert comes at
its end. Before #1155 it was fed from the subagent `PermissionRequest`
passthrough, the one event the allowlisted case never fires.

**Old auto-approve settings.** An old `config.toml` with an `[auto_approve]`
table still loads; the daemon warns once at boot (daemon, `remi serve`,
`remi config`; not again in a hub-spawned session daemon, and `remi start`
reports only removed flags) naming the ignored keys, and `--auto-approve*`
flags are accepted and ignored so old LaunchAgent plists keep starting.
`auto_approve.subagent_alert` is honored as a deprecated fallback when
`[notifications] subagent_alert` is unset, and gets its own "move it" line
instead of being listed as ignored. `remi migrate-permissions` prints the old
`allow`/`deny` lists as a Claude Code `permissions` block for the user to
paste into `~/.claude/settings.json`; it never writes a file. It never emits a
rule broader than the old entry (a bare `Bash` allow, which remi never
applied, is not carried over), and deny entries change meaning: remi matched
them as substrings anywhere in a command, Claude Code matches from the start
of each subcommand, so a migrated deny is narrower and mid-command patterns
(`push --force`) are not carried over. Everything not carried over is listed
on stderr with its reason.

**Notification channel — APNS push only** (no local notifications for questions):

- Daemon sends WebSocket `question` (in-app display) AND APNS push (lock screen).
- Signaling server (Cloudflare Worker) relays push payloads to APNS.
- iOS categories `REMI_YN`, `REMI_YNA`, `REMI_MULTI` registered in `AppDelegate.swift`. Their actions are positional (`OPT_i` sends option i) and the first two have hardcoded titles, so `selectPushCategory` picks by meaning, not count (#1134): `REMI_YN` only for exactly [one-time Yes, No]; `REMI_YNA` only for exactly [one-time Yes, an always-allow rule, No], the middle option marked `standingGrant: 'addRules'` (#1126: only there is its static "Yes, always" title true; a `setMode` or unmarked standing option gets no category; its "Yes, always" button is the only static action that requires an unlocked device). A one-time Yes is an option labeled exactly "Yes"; any other Yes is a standing grant, as is any Yes after the first option and a session-grant action. A card with a standing option in any other layout gets NO category (a plain notification, answered in the app), because `REMI_MULTI`'s buttons do not require an unlocked device. No card with a standing option gets the `dynOptions` hint, `REMI_YNA` included: the extension builds its dynamic buttons without `.authenticationRequired`, so a standing grant behind one could be tapped while locked. A permission card with `detail` gets no category and no `dynOptions` either (`hasUnseenDetail`, #1178: a Codex command cut for the lock screen, or one that runs in another directory): its Yes needs the app, where the whole card is, and its push shows the ask, not the start of the detail. Every other 2-4 option card gets `REMI_MULTI`, except by kind (`pushCategoryFor`, #1127): an AskUserQuestion card gets `REMI_MULTI` (with `dynOptions`) only when it is one single-select question, whose tap (the option's label) answers that option through the held hook, and none otherwise; a plan approval never gets a category (approving a plan is not a lock-screen tap). When the Notification Service Extension does not run, `REMI_MULTI` shows all four static "Option N" buttons whatever the option count; a button with no option behind it sends no answer (`RemiAnswerRelay` finds no `opt_n` and defers to the app), and any answer that does arrive still passes the `handleAnswer` guards (an iOS follow-up will add 2- and 3-button categories).

**Push classes and who can mute them** (#968):

Every push carries an explicit `kind`. Before that field existed the classes
were told apart by a NEGATIVE test ("no `questionId`, no `category`") which
could not distinguish turn-complete from a subagent alert at all — on the wire
those two are both exactly `{token, title, body}`.

| `kind` | Fires on | Mutable per device |
|---|---|---|
| `question` | permission prompt, AskUserQuestion, plan approval; an "answer at the terminal" notice (hold deadline, wrapper-mode subagent dialog; no actions, own collapse key) | yes, `pushPrefs.questions` |
| `turn_complete` | `Stop` after a turn ≥ `turn_complete_min_seconds` (#914); for Codex a `turn/completed` with status `completed` of the same length (#1180) | yes, `pushPrefs.turnComplete` |
| `subagent_alert` | a subagent's (foreground or background) call matching `[notifications] subagent_alert` finished without ever prompting (#1155) | no — the pattern list IS the control |
| `harness_denied` | `PermissionDenied`: Claude Code's auto-mode classifier blocked a call, or auto-denied an unanswered fallback prompt at 2:00 (#1126); informational, never a card; one collapse key per session (`harness-denied-<sessionId>`), so a blocked loop replaces its notice | yes, `pushPrefs.harnessDenied` |
| `turn_failed` | `StopFailure`: a turn ended on an API error (usage or rate limit, authentication, and similar; #1153), or a Codex `turn/completed` with status `failed` (the title says "Codex stopped", #1180); informational, never a card (nothing in Claude waits, so there is nothing to answer); readable reason from `error`, an excerpt of `last_assistant_message` (Codex: its error message); one collapse key per session (`turn-failed-<sessionId>`), so a different failure replaces the previous notice; one alert per failure (`turnFailureKey`: main agent or subagent, and the reason) until the notice is cleared (#1226: at a usage limit every turn fails, a subagent's included, and each one used to alert the phone again) | yes, `pushPrefs.turnFailed`, default on; **not** muted by `notifications.on_turn_complete = false` |
| `dismiss` | quiet `content-available` clearing a resolved card | **no, deliberately** |

- **A client cannot mute APNS on its own.** The path is daemon → Worker → APNS
  and never consults the client, so a client-side switch is decoration. It
  literally was: `settings.notifications` was written by the settings panel and
  read by nothing. Preferences ride up on `register_device_token` (idempotent
  and keyed by token, so a toggle change is just a re-register) and the daemon
  filters its per-token fan-out in `notifications/push-preferences.ts`.
- **Never filter `dismiss`.** A muted device can still hold a card delivered
  before the mute; dropping its dismissal strands that card on the lock screen
  of the device that asked for less noise. The next main-agent tool call or
  `Stop` after a `turn_failed` push sends one (same collapse key, only while a
  `turn_failed` push is outstanding), so a stale "Claude stopped" does not
  outlive the agent working again. A new prompt does not (#1226): at a usage
  limit it fails too, and clearing on it re-alerted the phone on every retry.
- **Push text is plaintext to the Worker and APNS.** `turn_failed` carries up
  to 140 characters of `last_assistant_message` (or a string `error_details`)
  in its body, the same posture as `turn_complete` (the first 200 characters
  of Claude's last message) and a question's text: the daemon POSTs it to the signaling
  Worker's `/push`, which forwards it to APNS, outside the relay data channel
  and its encryption. Tracked by the relay and push privacy work
  (`.context/strategy-2026-10.md` section 9); the relay channel has its own
  state (#543, #881).
- **A muted fan-out reports `no_channel`, not `pushed`.** Claiming delivery
  for a fan-out of zero says a card reached a lock screen it never appears on.
- Malformed preferences fail toward DELIVERING (`sanitizePushPreferences`). A
  wrongly-delivered notification is a nuisance; a wrongly-dropped one is the
  product failing at its only job.
- `notifications.on_turn_complete = false` in `config.toml` stays the
  machine-wide master switch for `turn_complete` and wins over any per-device
  preference for it. It does NOT silence `turn_failed` (#1153): a failed turn
  is the one turn end a user must not miss by default, and only the per-device
  `turnFailed` preference mutes it.

**Constraints from real logs (2026-04-12 analysis, updated #718 2026-07-06):**

- Bash `PermissionRequest` may have `permission_suggestions=undefined` (no suggestions), a legacy plain-string label array (e.g. Edit's `["Yes","Always","No"]`), or — since ~Claude Code 2.0.54 — a STRUCTURED array of typed "permission update entries" (`addRules`, `addDirectories`, `setMode`, `removeRules`, `replaceRules`, `removeDirectories`, each carrying `behavior`/`destination`; ground truth: code.claude.com/docs/en/hooks).
- Notification message is plain text ("Claude needs your permission to use Bash"), no numbered options, and never carries `permission_suggestions` at all.
- Claude Code does NOT always offer a fixed option count. `optionsFromSuggestions` (hook-event-bridge.ts) builds a binary card by MEANING (#1126): [Yes] + one standing option per offerable suggestion (`setMode`, allow `addRules`; never `addDirectories`) + [No], capped at 4 total; with nothing offerable, the honest Yes/No 2-set (`optionsAreFallback: true`). A multi-choice string-label set maps label by label to picks. This is the hook's view, not the screen's (Claude's dialog does not render one option per suggestion, #1134), which is why a held card is answered through the hook and never typed.
- Numbered option text appears only in the terminal UI, not in hook events.
- `HookEventBridge` builds the option set at hook time; a binary card is held and pushed at once, and its answer is the hook response (#1126).
- A standing option is answered by echoing its `permission_suggestions` entry (`QuestionOption.suggestionIndex`) as `{behavior:"allow", updatedPermissions:[...]}` on the held hook. Verified live on Claude Code 2.1.287 (#1126 spike F4) for `setMode` and `addRules`; every echo is sent with `destination: "session"` (lead decision), and an echoed `addDirectories` did not stop the repeat prompt, so it is never offered.
- Redeploy the signaling server after any `packages/signaling/` change.

### Harness identity and `create_session_request` (epic #1175 phase 5, #1179, ADR 0033)

What ships, read against `packages/shared/src/protocol.ts` and `packages/daemon/src`. The black-box tests here use a fake `claude` and `codex` and the stand-in app-server. LV-4 ran live on 2026-10-04 (Codex 0.160.0, Claude Code 2.1.289, a hub from source with an isolated home); ADR 0033's "LV-4 results" section records what it showed, item by item, and what it did not run.

- **Dual-emit.** `hello_ack` (when it carries the binding), `question` and the daemon's own entry in the session list carry `harness` and `harnessSessionId`. For Claude `harnessSessionId` equals `claudeSessionId` (a `hello_ack` keeps null on both); for Codex `claudeSessionId` is omitted and `harnessSessionId` is null on a `hello_ack` until the thread is learned, and left off a `question` or a list entry while null. Nothing depends on it: answers are addressed by `questionId`, and a client's answer still echoes only `claudeSessionId` (the signaling Worker rebuilds answers from a fixed list). One value produces both ids in `createHelloAck` and `createQuestion`, so they cannot differ, and every production question path passes that value (the transport adapters' `sendQuestion`, which did not, had no caller and was removed; `tests/question-identity-sources.test.ts` reads the daemon's source for a call without one). The Claude transcripts a daemon finds on disk (`source: 'transcript'`), a hub's session-less ack (a hub hosts nothing) and the resume acks name no harness; absence reads as Claude. The session-less ack a daemon that is not a hub sends in the brief window before its session exists names its `harness` alone (`hubMode`), so a Codex daemon never reads as Claude by an absent field.
- **`hello_ack.harnesses`** lists the harnesses a daemon can start on EVERY ack it sends: those it has an adapter for (`HarnessRegistry`, built in `cli.ts`) whose command resolves on the PATH the process has now (the command is never run; `Bun.which` ignores a PATH changed after startup, so the PATH is passed). An older hub omits it and ignores `create_session_request.harness`, starting Claude, so the CLI sender (`remi codex --host`, `remi new --host --harness codex`) sends a harness or arguments only to a daemon that lists the harness. Codex is advertised by PATH presence; LV-4 ran on 2026-10-04, partly (ADR 0033, "LV-4 results"), and the owner may still want it gated.
- **`create_session_request.harness` and `.args`** are checked before a port is probed or anything is spawned (`checkHarnessRequest`): a known harness id, an adapter, its command on PATH, `args` against that harness's remote allowlist (`validateClaudeRemoteArgs`; `validateCodexRemoteArgs` from Phase 2), and for Codex the older-daemon gate and, for a `resume <uuid>`, the held-thread check (a thread a live session holds is refused here, before a child is spawned; the client reads only "That Codex thread is already open in a live remi session on the host", with no id and no port, and the hub's log names the holder and its port; the person running `remi codex resume` at the machine reads the full text with an address that can be pasted into a shell, `heldThreadRefusal`). A Claude `--resume <uuid>` has the same check, whether or not the request names the harness: a session a live remi session already holds is refused before the spawn (two active records of one session otherwise), with a generic client text ("That Claude session is already open in a live remi session on the host") and the holder in the log. The older-daemon gate skips a record whose version string is exactly the daemon's own (`ownVersion`): the same build has the same shim, so a PR-stamped build (`bump-version.sh set 0.7.16-p1204.1`, the one recommended for LV-4) can create Codex sessions beside its own sessions, wrappers and hub, while a record with no version, another version that does not parse, or a lower parsable one is still an older remi (the assumption is that a version string identifies a build). The `directory` of EVERY create request is refused when it is not a string, starts with a hyphen (a child would re-parse it as a flag), or holds a control character (any C0 control, DEL or C1 control: NUL, tab, newline, carriage return and escape among them; `directoryRefusal`; no real client sends one), and the one place the hub logs it writes it out escaped, so a bidi override or a zero-width space, which a path may hold, cannot act on the owner's terminal through `remi logs`. A refusal is `create_session_response{success:false, error}` and spawns nothing. What the client reads is short and host-free: the gate says an older remi is running and to update or stop it, a failed spawn says only that the session could not be started; the pids, files, paths and the failure itself go to the hub's log. The child is started with the inherited flags, then `--harness <id>`, then `--` and the arguments, last, so no remote argument can be read as a remi flag. A request naming no harness is the Claude spawn it always was. Claude allows `--resume`/`-r <uuid>` (the UUID comes out lowercase), `--fork-session` only beside a `--resume`, and `--model <name>` (no leading hyphen); `--continue`/`-c` is refused (the launch injects `--session-id`, which Claude very likely rejects beside it: unverified, so closed). A Codex request may carry `-m`, `-s read-only` and `resume <uuid>` (lowercased); a remote request may only TIGHTEN the host's posture, so `-s workspace-write` is refused, and so is `-a` in every spelling and with every value: Codex 0.160.0 rejects `-a untrusted` (exit 2, which killed the child) and accepts `on-request` and `never`, and neither can be shown to tighten an approval policy the host's own configuration may already have set stricter (`REMOTE_APPROVAL_REFUSAL`). LV-4 ran `resume <uuid>` through a hub for Codex (refused while a live session holds the thread; resumed headless once it stopped) and `--resume` for Claude; a Claude session resumed through a hub came back in the permission mode of its earlier life (seen with `acceptEdits`; `bypassPermissions` was not tried).
- **A daemon reads its harness arguments only from after `--`** (`ParsedArgs.explicitArgs`, tokens after the first `--` and nothing else; `passthroughArgs` is the wrapper's, with strays and the `--`). For Claude a stray word is still ignored, so an existing LaunchAgent plist starts as before; `remi codex --daemon` validates the arguments with the local Codex validator and REFUSES a loose word (exit 2, `looseArgs`: it would start Codex without what was asked). `remi codex --host` and `remi new --host` send only what follows `--` and refuse a loose word (exit 2, nothing sent), because the host's own defaults would otherwise apply with no warning; `--resume` with `--host` is refused the same way (remi's own flag, which the parser consumes, so it is not a loose word: it used to start a LOCAL store lookup), with a message that says to put it after `--`; the notice's remedy line is not repeated by the CLI, which attaches itself, and what a daemon sends that the CLI prints is safe to print: its errors and the notice are escaped (a field that is not a string reads as a fixed fallback, never a throw, and `harnesses` counts only as an array), and a success whose session id is not a UUID or whose port is not an integer from 1 to 65535 is refused, since both are printed and the port is attached to.
- **What a headless success does not say.** `create_session_response.success` means the child daemon was spawned and registered. A Codex session the hub starts has no terminal, so Codex may stop at an Update or Trust prompt that remi never answers (remi types nothing into a Codex PTY): the response then carries `notice`, built by the hub from the new session: line one says the condition (it may be waiting at an Update or Trust prompt, or may already have exited: the hub answers once the child has registered, before Codex is launched), line two the way out, `remi attach <host>:<port>/<id8>` for THIS session (a bare `remi attach` takes the newest one) with the hedge that this has not been checked against a real Codex. The messages a Codex session sends itself follow the same rule (`TerminalWords`): a link that cannot be reached, a thread that is never found (which also says it may be an Update or Trust prompt), an answer Codex did not confirm or that could not be sent, and a card only a terminal can answer name `remi attach <host>:<port>/<id8>` when the session was not launched with a terminal (a hub's child, `remi codex --daemon`), and keep the terminal wording for a wrapper session. The web client does not show the notice (no UI change in this phase). Unverified live: that `remi attach` dismisses such a prompt.
- **Still unverified after LV-4** (ADR 0033, "LV-4 results"; the hub path was exercised by a raw `create_session_request`, not by the CLI sender against a real Codex): the headless Update and Trust prompts and `remi attach` as the way out (no modal appeared in any launch, so the notice's advice stays unverified); an approval card for a hub-created session; `remi codex --host` from a second machine; and the web label. Codex stays advertised by PATH presence (H1).
- **Resume.** A `resume_session_request` to a daemon that hosts Codex is refused `UNSUPPORTED`, like the hub's, before any path runs.
- **Live-sessions.** An entry may carry `harness` (absent means Claude, so a Claude entry is byte-identical to before; Codex daemons and wrappers write it). The transcript binder's sibling and port-claim checks and the foreign-session escalator no longer count a daemon that hosts Codex as a Claude sibling (`couldBeClaudeEntry`; an entry naming no harness, Claude, or a harness this build does not know still counts, the file's fail-safe). There is no Codex-side reader of live-sessions entries: the thread tracker's sibling guard reads the store, which is already harness-aware.
- **Web.** A harness other than Claude is named by a small label next to the status pill on the session card and the chat header; a harness this build does not know (a newer daemon's) is named as text, cut to 16 characters with control and bidi characters written out, so it does not look like Claude; a Claude session, or one from an older daemon, renders identical markup. Nothing else changed in the UI.

### Codex approvals (`remi codex`, epic #1175 phase 4, ADR 0033)

**remi relays Codex's approval; Codex decides.**
Like Claude's held prompts (above), a Codex approval reaches the phone as a card, a phone answer decides nothing by itself, and the first answer wins; unlike Claude's there is no hook and no hold: Codex keeps the request pending and its TUI keeps the overlay up.
Read against `harness/codex/` (`approval-cards.ts`, `codex-decisions.ts`, wired in `codex-session.ts`):

- **What becomes a card.** `CodexDecisions` is the session's `DecisionChannel`. A server request of the shared app-server about the session's own thread (the tracked thread, or a descendant of it, `ThreadTracker.role`) becomes a card; `present` is `messageApi.handleQuestion(q, {held: true})`, so `held` is stamped (the push always reaches the lock screen and free text is refused) and the eviction guard pins every live actionable card. A request about any other thread is ignored and never answered. Ids are one daemon-global counter, so a request is keyed `(threadId, requestId)`, and the thread's role is read again at the answer.
- **What is answerable.** Only a plain command approval (`item/commandExecution/requestApproval` with `kind: 'command'`, no `approvalId`, no extra permissions, no network context or policy amendment) of the main thread. Options are built by meaning from the request's own `availableDecisions` (absent means `accept` and `decline`): Yes is `accept`; "Yes, and don't ask again for this command this session" is `acceptForSession`, offered only when listed (`standingGrant: 'session'`, no lock-screen category); No is `cancel` when listed (what the TUI's own No sends), else `decline`. The object-form decisions (`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`) write a persistent policy and are never offered. Codex has never offered `acceptForSession`: none of 7 real command approvals on 0.160.0 listed it (they listed `accept`, an amendment object and `cancel`), so that option is unreachable in practice there and what Codex does with it is unknown (the code stays, labeled unverified). A phone No and the header X (Cancel) send `cancel`, which is Codex's own No: it declines the command, the command does not run and the turn is INTERRUPTED ("Conversation interrupted"), so a phone No ends the turn (verified live, 2026-10-04).
- **What a card shows of the command.** `Allow Codex to run: <command>`, then `In directory: <cwd>` when the command does not run in the session's own directory (compared with `resolve`, which does not follow symlinks: LV-3 (k)), then Codex's stated reason. The real command text is `/bin/zsh -lc '<command>'`, so Codex's shell wrapper counts toward the 120-character cut below. A request whose `cwd` is missing, null, empty or not text is `terminalOnly`: the person could not see where the command runs (all six real frames of the spike carry it). A command over 120 characters is cut the way Claude's hook cards cut one (80 characters, a count of what is hidden, 30), because the dangerous part is as likely at the end, but never inside an escape (a boundary that falls inside one moves to its end), and the whole command is in `detail`. A card with `detail` (a cut command, or another directory) gets no lock-screen category and no dynamic buttons, so Yes needs the app, where the whole card is; its push shows the ask, and Telegram shows the whole command with its buttons only when they fit in one message ("Command truncated", no buttons otherwise). A command whose escaped text is over 20000 characters is `terminalOnly`.
- **Text a server chooses is escaped and bounded.** The characters in the set listed once in ADR 0033's phase 4 amendment (item 3: controls, invisible and bidi characters, the line separators, the Tags block) come out as visible text, `\uXXXX` or, above the Basic Multilingual Plane, `\u{XXXXX}` (`escapeUnsafeText`, never dropped), in every card builder and in the attach client's banner (which also hardens Claude's banner; Claude's hook cards build their own text and are not changed here). Not every invisible character is in it (variation selectors, the combining grapheme joiner and Hangul fillers are shown as they are). Free text is cut at 2000 characters, labels and names at 200, option descriptions at 500, the directory at 500, an elicitation URL's host at 200, a command's reason at 300; a card keeps 8 questions of 12 options and 20 permission names. A cut says what it hid, in one of three forms: "[N characters hidden]" after a cut text, "[N more options hidden]", "[N more questions hidden]" or "[N more hidden]" for dropped items, and Claude's "… [N chars hidden] …" in the middle of a long command.
- **Everything else is a `terminalOnly` card or nothing.** A file change, extra permissions, a user-input question, an MCP elicitation, a command that asks for more than itself, a subagent's request (whether it reaches this connection at all, and is replayed to a connection that resumed only the main thread, is unverified), a request whose fields do not parse: a card that says what Codex asks and has no answer controls; every answer is refused, and Cancel clears the card from the phone and sends nothing (the TUI's overlay stays); the app's X reads "Dismiss (answer in the terminal)" (`cancelDismissesOnly`) and a card with no options shows no input. A method with no card (`item/tool/call`, token refresh, attestation, time, the legacy approvals) is ignored by name and never answered; `AppServerClient` has no way to send an error response.
- **Nothing is typed.** The answer and Cancel handlers type into the PTY only when `answerHeld` says `unknown`; `CodexDecisions` never does, for any id, so a phone answer, Cancel and free text type nothing, and there is no `screen` for a typed answer's guards. The black-box test (`integration/codex-launch-characterization.test.ts`, "approvals") sends every variant through a real websocket and a fake `codex` that counts its stdin, with a raw `q` as the positive control. `hasMainHold` and `hasOpenHookPrompt` say false: nothing reads them for Codex (chat is refused earlier, a Stop force-closes).
- **First answer wins, and an answer Codex does not confirm.** `serverRequest/resolved` for a card remi did not answer (the TUI answered first, or another client) dismisses it on every client (`question_resolved`, reason `cancelled`, as for Claude's terminal answers); a phone answer a moment too late is `STALE_ANSWER` from the answer handler (verified live, 2026-10-04: the terminal answering first sent every phone client `cancelled`, and a late phone Yes got `STALE_ANSWER` from remi; that Codex ignores a late answer was not re-tested, the spike covers it). When both answer at once the phone shows "answered" although Codex ignored the loser, as Claude's does. A delivered answer is a frame written to a socket: 10 s after it with no `serverRequest/resolved`, the person gets "Codex has not confirmed the answer; check the terminal" (a second Yes or a second client's Cancel before `question_resolved` arrives is closed and does not touch that timer). A send that fails is logged by cause and tells the person to try again from the new card or answer in the terminal.
- **No deadline.** Claude's holds are bounded by hook timeouts remi cannot lift. A Codex request waits in the app-server without one, and the card mirrors it, so a card on a lock screen stays answerable for as long as Codex waits; expiring the card would strand a request that is still pending.
- **The link.** When it drops, every card is retired at once (not answerable, still shown); the replay after the re-attach (`ThreadTracker.onAttached`) creates a new card with a new id and dismisses the retired one, and a card the replay did not bring back within 3 s was resolved while the link was down and is dismissed; with no re-attach the retired cards are dismissed after 30 s. A rotation, `remi unstick` and the session ending dismiss every card. A card dismissed by Cancel (`terminalOnly`) or `remi unstick` comes back at the next replay because the request is still pending; a flapping link pushes the card again at each replay; more than 64 requests at once dismiss the oldest live cards (they stay answerable in the terminal). A dropped link does not cancel or decline a pending request (verified live, 2026-10-04, R1: a probe and real remi killed with -9, even remi and the TUI together; the prompt stayed up and the SAME request id was replayed to the next `thread/resume`). Nothing dismisses a live card from a status change: `serverRequest/resolved` is reported for an answer, an Esc in the TUI, `turn/interrupt` and an RPC `cancel` (verified live), so no status-based dismissal is needed (F3 settled).
- **Rotation keeps approval authority.** A `/new` in the TUI, or a plain `codex` window in the same directory opened while the session is idle (it looks the same), re-binds the session, and approvals then come from the new thread. Not closed (same user, same machine); never silent: every rotation sends "remi now follows a new Codex thread; approvals come from it" and logs `rotated from <last 8> to <last 8>` (residual R4, confirmed live 2026-10-04: a plain `codex` window re-bound an idle session and the message reached the phone).
- **Logs and what persists.** No command, cwd, prompt or full thread id: a thread id is shown as its last eight characters (UUIDv7 prefixes collide: two threads created within about 65 s share their first eight; remi's own and Claude's v4 ids keep their first eight), a string request id and a method name are cut and escaped, the question-detected line and the registry's cap-eviction warning log a length for a Codex session (`redactQuestionLogs`). The live-sessions file, the hub census and the menu-bar notifications get a fixed label (`pendingLabel`: "Permission: Codex command" or "Codex asks for approval"), never the text. The card text and `detail` reach connected clients over supported transports (WebSocket and Telegram) because the person must see them; the push carries the cut ask (title 120, body 200 characters) in plaintext to the Worker and APNS like every card; the relay is off by default and no shipped client can join a room; since #1193, no adapter or Worker connection is created without authenticated permanent-code setup, and `sendRaw` refuses until session keys exist, then encrypts before sending. This relay path is separate from push, which remains plaintext as described above. Nothing else persists the text: the replay buffer is memory only, `sessions.json` and the opt-in question trace hold no text. **One exception, the startup line** (`startup-output.ts`, added after LV-4): when a headless Codex (a hub's child or `remi codex --daemon`) exits within 10 seconds of its spawn, before it names a thread, the log gets one line with the first and last 1 KB of what it printed, so a flag error is not opaque. After redaction it holds Codex's own text with every UUID cut to its last eight characters and the session's directory and the home directory shown as `<cwd>` and `~`; it can still hold anything else Codex printed (a config excerpt, a URL, a prompt it echoed), and a path or id cut by the 1 KB limit shows as a fragment. It is escaped, on one line, at most 4096 characters plus a `[cut]` marker when truncated, and never logged for a wrapper session (its terminal already shows the error), for a stop or shutdown remi asked for, or for a session that named its thread. The captured copy is only logged: an attached client reads the same bytes as raw PTY frames, by design.

**Live verification: LV-1, LV-2 and LV-3 were run on 2026-10-04 against the owner's real Codex 0.160.0, by a spike agent. The epic gate holds.**
Verified live (the ids are the plan's LV-3 letters):
(a) a phone Yes (the card's Yes, `accept`) ran the command and the overlay closed, and both phone clients got `question_resolved` reason `answered`;
(b) answering in the TUI first sent `question_resolved` reason `cancelled` to every phone client, and a late phone Yes got `STALE_ANSWER` from remi itself;
(c) a phone No sends `cancel` (it is in the frame's `availableDecisions`): Codex marks the item declined and the turn INTERRUPTED ("Conversation interrupted"), the command does not run, exactly like the TUI's own No, so a phone No ends the turn;
(d) R1: a dropped subscriber (a probe killed with -9, and real remi killed with -9) does NOT cancel or decline a pending approval: the TUI overlay stays up, the same request id is replayed to the next `thread/resume`, and answering it in the TUI produces `serverRequest/resolved`;
(g) an Esc in the TUI on an approval, `turn/interrupt` over RPC and an RPC `cancel` each produce `serverRequest/resolved` and the card is dismissed;
(i) a pending request survives a subscriber drop, even remi and the TUI together, and is replayed with the same id;
(j) a plain `codex` window in the same directory re-binds an idle remi session (R4 residual confirmed), and the rotation message reached the phone client;
(k) Codex reports the REALPATH as `cwd` (the frame, the TUI's directory line and `thread/started`) even when launched from a symlinked path, so a session's own directory shows no "In directory" line and keeps Yes and No;
(e) CORRECTION: remi sends no `thread/unsubscribe` anywhere (dispose only closes the socket); a probe's `thread/unsubscribe` is harmless and a normal exit leaves the thread loaded.
LV-1: the hand-rolled client's handshake works against the real server (`initialize` answered in 2 ms with result keys `userAgent`, `codexHome`, `platformFamily`, `platformOs`; the 101 response carries `x-codex-websocket-max-unfragmented-message-bytes: 16777216` and no extensions; `optOutNotificationMethods` is accepted and effective; `thread/loaded/list` and `server/diagnostics` are answered; R3 is answered), except the keepalive: Codex answers EVERY ping with TWO identical pongs, which made the old client drop the link with "no pong within 10000 ms" about every 70 s and re-create a pending card with a new id each time (fixed: a pong with no ping outstanding is ignored and a ping timer is never armed twice).
LV-2: `thread/started` for the TUI thread arrives within about 0.8 s of the spawn, `cwd` equals the scratch directory's realpath, identity is written to `sessions.json` at that moment before any message; the ephemeral `threadSource: "thread_title"` helper thread (0 environments, no path) appears about 1 s after the first message and is ignored; `thread/resume` fails -32600 "no rollout found for thread id <uuid>" before the first message (the exact text matches the fixture) and succeeds about 1 s after it; no `.claude/settings.local.json` and no change to `~/.claude/settings.json`; `thread/started` carries NO client marker (a plain window and a remi-spawned one are indistinguishable; `source` is "vscode", `originator` is daemon-global); a TUI `/resume` of a thread already loaded in the daemon emits no `thread/started`; words after `--` are read as prompt text (verified only with `help` and `completion bash`; `-- exec x` and `login` were NOT run); and `-i <missing.png> resume <uuid>`: Codex's parser swallowed `resume` and the uuid as image paths and the TUI started a FRESH session and auto-submitted the images (a verified hazard: remi's refusal of `-i` with `resume` is right).

**Still not seen:** (h) a subagent's request (whether it is addressed to a connection that resumed only the main thread, and replayed); (f) what Codex does with `acceptForSession`, which was NOT in `availableDecisions` in any of 7 real command approvals on 0.160.0 (they listed `accept`, an `acceptWithExecpolicyAmendment` object and `cancel`), so the option "Yes, and don't ask again for this command this session" is unreachable in practice there (the code and its unverified label stay); `-- exec x` and `-- login`; a TUI `/resume` of an unloaded thread. (The cold start of the daemon with it stopped, R2, was seen by LV-4 through a hub child: the Codex TUI itself starts the shared daemon, and `daemon stop` leaves its `pid-update-loop` helper running; ADR 0033, "LV-4 results".)

**Facts seen live that shape what remi can do:**
- A `kill -9` of remi also ends the user's Codex TUI: the child gets SIGHUP when remi's PTY master closes (the same wrapper-owns-the-PTY posture as Claude), while the pending approval stays pending on the daemon.
- With Codex's "Approve for me" (approvalPolicy on-request with the default reviewer, status line "Read Only (Approve for me)"), Codex's Guardian approves a command automatically and sends NO `requestApproval` to any client: remi shows nothing and cannot answer, so no card and no push exist for those commands. Guardian frames do exist (`item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, and a `guardianWarning` text); remi does not handle them (this corrects the plan, which said no Guardian frames had been captured).
- `originator` is a daemon-global value set by the first client that initialized: after a `remi` client initialized first, every later TUI-created thread read the originator "remi" (R8).
- Server request ids start at 0 (the first real id was 0), so an id is never tested for truthiness (a test pins it).

### Codex turn events and chat (`remi codex`, epic #1175 phase 6, ADR 0033)

What ships, read against `notifications/turn-events.ts`, `notifications/claude-turn-stop.ts`, `harness/codex/codex-turns.ts`, `harness/codex/codex-chat.ts`, `harness/codex/safe-text.ts` and their wiring in `codex-session.ts` and `cli.ts`.
Automated tests use captured frames plus the labeled stand-in app-server for cases not captured. A bounded live LV-5 check ran on 2026-10-05 against Codex 0.160.0 with GPT-6.1-Sol on one controlled account. It covered two completed turns, three interrupted turns, one failed turn, two item-list responses and one resumed catch-up; it did not run in automated tests.

**Turn events.**
- **One sink for both harnesses.** `createTurnEventSink` (`notifications/turn-events.ts`) holds what `onTurnStop` used to do inline: the `turn_complete` gate (`shouldNotifyTurnComplete`), who wants the push (`tokensWanting`, the per-device preference), the text and the fan-out, plus `turnFailed` and `turnSucceeded` for the `turn_failed` notice. `cli.ts` builds it once and reads the config, the devices, the signaling endpoint, the push secret and the session name when a turn ends. Claude's half is `createClaudeTurnStop` (`notifications/claude-turn-stop.ts`, registered as the second `Stop` listener `onTurnStop`): the #914 session filter first (an early return: a sibling's Stop neither reads nor clears this session's timer mark), then the elapsed time from the timer and the mark's clearing (a re-entry keeps the mark), then `turnCompleted`; it is built from the harness's filter, the turn timer, the primary session id and the sink, and tested with the real timer and sink. Claude's `StopFailure` wiring (`createTurnFailedRoutes` from the hook bridge) is unchanged; the sink calls the same function over the same map for the failure it is handed.
- **The mapping** (`createCodexTurns`, fed every notification of the app-server). Only a `turn/completed` of the session's own thread counts (`ThreadTracker.role` is `main`; a subagent's turns and another window's are ignored), and a turn id already announced is not announced again (the last 64 are remembered; an id over 200 characters is treated as no id and announced each time). `completed`: `turnCompleted` with `elapsedMs = turn.durationMs` and the text of the last `agentMessage` whose `phase` is `final_answer` (a message with no phase is "unknown" and is never taken for it), then `turnSucceeded`. `failed`: `turnFailed` naming Codex, `turn.error.message` as the details and `codexErrorInfo` as the code only when it is a string; it carries no earlier answer. `interrupted`: `turnSucceeded` only (nobody is told a turn was interrupted). Any other status is logged without its value and does nothing.
- **Interrupted is observed in a bounded capture.** A local WebSocket protocol client sent the daemon's phone-No answer and Codex reported `interrupted`; a real TUI Esc and an app-server `turn/interrupt` did the same. An early interrupt attempt returned -32600; a retry after the turn started succeeded. The earlier decline run still answered `decline` (`expA-decline.jsonl:65`) and reported `completed` (`:141`): it does not stand in for these three probes.
- **Same gates as Claude.** `notifications.on_turn_complete`, `turn_complete_min_seconds` (default 60: the real 5.5-second turn of the spike does not push), the per-device `turnComplete` preference, a message to show, and an unknown duration fails toward silence. A turn with no `final_answer` message has nothing to show, so it stays silent, as an empty `last_assistant_message` does for Claude, and logs ONE line without content (with the turn's items view when Codex gave one). LV-5 observed `final_answer` on the sampled model only; it does not establish behavior for other models. A failed turn is never muted by `on_turn_complete`; only the device's `turnFailed` preference mutes it.
- **The notice** is "<session>: Codex stopped" (`buildTurnFailedText` takes an agent name, Claude when absent), then a reason phrase for the string codes with a clear reason (`usageLimitExceeded` reads "Usage limit reached"; the documented Claude codes' phrases are unchanged, and any other code is shown as is), then Codex's own words (140 characters), one collapse key per session like Claude's. A later `completed` or `interrupted` turn, or an `item/completed` of Codex's own work on the main thread (#1226), clears it with the quiet dismissal; a `failed` one does not. A repeated failure alerts once until then, like Claude's.
- **What Codex chose is made safe** (`safe-text.ts`). A failure's details and code are written out with every control, invisible and bidirectional character visible (`escapeUnsafeText`'s set), cut to what the push shows AFTER counting the escapes, so a cut never lands inside one. The final answer in a `turn_complete` push has the same set REMOVED, except the zero-width joiner, so an emoji sequence survives. Tag characters (U+E0020 to U+E007F) are removed, so subdivision-flag emoji lose their tags. An answer made only of removed characters, whitespace or joiners has nothing visible to show: no push and one content-free log line. Escaping reads only a bounded prefix rather than materializing the whole frame. Chat PROSE is deliberately NOT escaped (it is shown as written, and escaping breaks an emoji at its joiner), and Claude's `last_assistant_message` in its `turn_complete` push has the same exposure today; neither is changed for Claude here.
- **Turns remi did not see.** A turn that ended while remi was not attached (before the first attach, or while the link was down) pushes nothing, and a stale "Codex stopped" stays until the next completed or interrupted turn.
- **Plaintext and logs.** The push carries the final answer (200 characters) or the failure text in plaintext to the Worker and APNS, like Claude's `turn_complete` and `turn_failed`. Nothing a turn says reaches a log line, and neither does a thread id.
- **Not done.** A `harness_denied` equivalent (Guardian frames). A `turn/started` deliberately does not clear a stale failure notice, as a new prompt does not for Claude (#1226): a turn's start is not evidence it will get further than the last one.

**Chat.**
- **The seam.** `HarnessSession.chat` (`HarnessChat.readHistory(emit): Promise<number>`) is set by Codex only. The transcript handler asks `chatFor(remiSessionId)` first, before any file lookup, streams what the chat emits to the requesting connection, then sends `transcript_load_complete` with the count, or `LOAD_FAILED` when the read fails (what was sent before the failure stays sent). A send to the requester that is refused (its connection is gone) ends the read at once, with no error sent to a dead connection. Claude's sessions have no chat and take the transcript-file path as before.
- **History** is `thread/items/list {threadId, sortDirection: 'asc', limit: 100, cursor}` pages, oldest first, following `nextCursor` until it is null; each page is emitted as it arrives, through a MessageAPI of its own, so the session's message stream is untouched. It is bounded: a cursor that comes back (any earlier one, not only the last) ends the read, and so do 1000 pages (both logged); a 60-second deadline is checked after each non-final page, so the request in flight can exceed it by up to its 15-second timeout. A waiting read does not inherit the running read's failure. One explicit read of a session runs at a time with one waiting (two phones that connect together are both served), and a third is refused with a clear error. A thread with nothing written yet ("no rollout found" on the first page, what `thread/resume` says before the first message) is an empty history; every other failure is a `LOAD_FAILED` whose text carries the code and none of the server's words. A session that has not learned its thread has no history and asks nothing.
- **The mapping.** `userMessage` is a user message (its text parts joined by a newline); `agentMessage` is an assistant message (commentary and final answer alike); a finished `commandExecution` is an assistant tool entry named `shell` (input `{command}`, the result, each cut to 500 code points, whole characters and then written out safely as above, an error for `failed`, `declined` or a non-zero exit); one still `inProgress` is skipped (its completion arrives live, and a client keeps the first copy of an entry it sees); `reasoning`, plans, file changes, tool calls, hook prompts, blank and image-only messages and any item type remi does not know are skipped. The entry id is the item id, so a history read, a catch-up and a live frame of one item carry the same `entryUuid`.
- **Live.** Each `item/completed` of the main thread goes to every client through the launch context's `sendAndRecord`, structured by the session's own MessageAPI (as Claude's binder does, so the structured agent output goes out too), once per item (the last 1024 delivered ids are remembered; ids over 200 characters are rejected). A failed live send retains its built message for retry so structured output is not duplicated. A subagent's items and another window's are not this chat.
- **Catch-up at each attach.** Items completed before attach are not announced live, so catch-up reads one complete page (requested `limit: 100`, at most 100 raw returned entries, a 3-second request timeout). An oversized page or a continuing cursor is skipped, logged without content, and left to an explicit history read. Catch-up sends only `transcript_content`, through its own MessageAPI: the web renders its included structure, so there is no extra structured output in replay or Telegram. The live hold starts before `thread/resume` is sent, including items in its response's socket chunk; a failed attach releases it in arrival order unless a read is still running. Live items follow the history; overflow at the 257th item flushes the held queue in order and abandons collected history. A rotation drops the old thread's collected history and filters held items by current role; a follow-up read handles the new thread. Another attach can keep the hold across follow-up reads, with no overall hold deadline; each request has its 3-second timeout and overflow bounds the queue. Failure does not break attach, reconnect does not resend delivered items, and disposal builds or sends neither transcript nor structured output.
- **Typed chat stays refused** (`acceptsTypedChat: false`, `PROMPT_WAITING`): Phase 6 gives Codex a chat to read, not one to type into.
- **Limits.** History exists only for a live session (an exited session has no daemon to ask). Subagent chat is not served. The web client shows a `shell` entry as a plain "shell" chip (it summarizes only `Bash`).

**LV-5 live evidence and remaining limits** (the redacted 20-frame source selection is [`lv5.jsonl`](packages/daemon/tests/fixtures/codex-app-server/lv5.jsonl); its index labels reasoning-item strings redacted):
(a) Two real `thread/items/list` requests used `sortDirection: "asc"` and `limit: 100`; both responses had `data` entries with `turnId`, `item`, `startedAtMs`, and `completedAtMs`, plus `nextCursor` and `backwardsCursor`. The first response had the controlled first prompt and its final answer; the second had six rows. A separate ascending `limit: 1` check on the same owned thread followed the returned cursor from a `userMessage` page to an `agentMessage` page and ended with `nextCursor: null`; those request/results are private receipts and are not in `lv5.jsonl`. Larger histories were not checked.
(b) Before the first user message, `thread/items/list` returned -32601 and `thread/resume` returned -32600; after the first write, both worked. The early `thread/items/list` response is method-specific, not a general claim that the app-server lacks the method.
(c) The two captured list pages from this controlled GPT-6.1-Sol account contained no injected environment or instruction message. This does not establish a model-wide rule.
(d) The local WebSocket phone-No path, TUI Esc and `turn/interrupt` each produced `status: "interrupted"` with durations 24638, 15572 and 12091 ms. An early interrupt attempt returned -32600 and the retry after turn start succeeded. A bad-model probe produced `status: "failed"` after 243 ms, with `codexErrorInfo: "other"`, the captured message, and null `additionalDetails`/`misalignment`.
(e) The observer received one `turn/completed` for each of five subscribed turns (one long completed, three interrupted, one failed). The first minimal completed turn preceded observer subscription. Only the sampled model/account was checked; neither models generally nor turns without `final_answer` were tested.
(f) The long turn's `durationMs` and observer wall time were both 66965 ms; it ran shell `sleep 61`, not a CPU workload.
(g) The captured long-turn command's `item/completed` id appears exactly once in the second captured `thread/items/list` page.
(h) Initial-attach event ordering was not measured. On a later successful resume, catch-up delivered ten `transcript_content` entries, including the first prompt exactly once, and no `structured_agent_output`. The phone-No path used a local WebSocket protocol client, not a physical iPhone; no APNS delivery or device matrix was tested.

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

## Core Principles

1. **Zero friction** — pairing is a code, not an account.
2. **Reliable messaging** — WhatsApp-style states (sending → sent → delivered → read).
3. **No data in cloud** — the relay should carry ciphertext it cannot read, so the
   worker is a courier and not a reader. **This is still a goal, not a
   description.** #543 built the encryption daemon-side only; #881 is that it
   engages only when an `authenticator` is present, which `cli.ts` supplies only
   in permanent-code mode (so a default install, and even `--auth` alone, never
   derives session keys), and that no client implements the other half. Since
   #1193 the relay is off by default and a daemon without an authenticator
   refuses in BOTH directions: outbound refuses to send, inbound refuses every
   peer and frame. Before #1193 outbound REFUSED (a breakage, not a leak) while
   inbound still ACCEPTED plaintext (a leak). Name the direction; conflating them
   is how the first draft of this very row got it wrong.
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
