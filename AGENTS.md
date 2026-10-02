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
| "auto = based on bind address" (`AuthConfig.enabled`) | `'auto'` resolves to `false` on every bind, `0.0.0.0` included | #880; `'auto'` is STILL unfixed — the LAN exposure was closed by defaulting `bind` to loopback instead |
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
- A `resume_session_request` that reaches the hub is **refused**
  (`resume_session_response{success:false, errorCode:'UNSUPPORTED'}`,
  `cli/handlers/resume-session-events.ts`, #1124), never run: before the guard
  the shared handler called `createNewSession` inside the hub, and when that
  Claude exited the hub exited 0 and the LaunchAgent did not restart it.
  Resuming *through* the hub (spawn a child daemon) is not implemented: a
  `remi --daemon` child silently drops Claude args (`cli.ts` passes no
  `claudeArgs` to `createNewSession` in daemon mode) and the web resume flow
  cannot follow a session on another port. Tracked as #1129. `remi --resume
  <session>` from a terminal works.

## Transport Options

| Method | When to use |
|---|---|
| Direct connection | Same Wi-Fi, Tailscale, VPN, SSH tunnel |
| Signaling relay | No direct access. Every protocol message is carried by the Cloudflare Worker |

**Direct connection now requires setting `daemon.bind` (#880).** The default is
`127.0.0.1`, so a stock daemon accepts only loopback: SSH tunnels and the relay
still work untouched, but **LAN direct, Tailscale direct (100.x) and mDNS
discovery all stop** until the user opts in. mDNS does not even advertise on a
loopback bind (`cli.ts` skips the publisher), so the daemon does not fail — it
disappears, which is the confusing half.

Do NOT recommend `tailscale serve` as the workaround. It is a same-host reverse
proxy, so every tailnet peer arrives as `127.0.0.1` and inherits the loopback
auth exemption (`peer-helpers.ts`, #869) — it reinstates the hole behind a
safer-looking front. Recommend an SSH tunnel, or an explicit `bind` plus
`--auth`.

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
sends. A **multi-choice or design prompt** (`AskUserQuestion`, `ExitPlanMode`,
a multi-choice string-label permission) is still answered `passthrough` and
pushed by id at once, and its answer is typed (Phase 4, #1127, moves it to the
hook). An open card is also resolved by a matching `PreToolUse`/`PostToolUse`/
`PermissionDenied`, a lead `Stop` or new user prompt (main), `SubagentStop`
(that agent), `SessionEnd`, a transcript rotation, or `remi unstick`; a
dismissal is broadcast only for a card that was actually pushed. `remi
unstick` does not close a LIVE hold: its dialog is on screen, so it is
released to the terminal with a "handed back" notice (suppression kept),
and a second unstick clears it.

**No card answer is typed into the PTY for a hook-backed binary prompt**
(raw input from `remi attach` and the phone's Escape button still reach the
dialog by design: they are a person at the terminal). While a
MAIN-agent hook is held, or a main prompt waits in the terminal
(`terminalPrompts`: released at its deadline or early) for less than the
session's hold length, the tracker treats a PTY render as that dialog
(`setHookPromptProbe` -> `hasOpenHookPrompt`), never as an orphan, so no typed
card is rebuilt from it. The probe is bounded on purpose (#1126 lead
decision), since everything it counts suppresses a hook-less prompt's card
(sandbox network, trust, an agent-team dialog): subagent holds never count
(their dialog does not render while held), subagent `terminalPrompts` entries
never count (they are cleared by that agent's next `PreToolUse`,
`noteAgentToolCall`, or `SubagentStop`), and a main entry stops counting after
the hold length, after which a redraw takes the guarded hook-less path (#1134,
fail closed). So a redraw of a rendered wrapper-mode subagent dialog can
become a guarded typed card. `handleAnswer` asks
the gate first (`gateAnswerDeps`): a held card is answered through the hook,
and a binary card whose hold has ended is refused (`closed`: answer at the
terminal), never typed. While a main-agent hold is open its dialog is on
screen, so `onUserInput` refuses chat text with `PROMPT_WAITING`
(`isMainPromptHeld`) even before the screen parse sees the menu (#1140). Its
message is `PROMPT_WAITING_HELD_MESSAGE`, which does not claim a dialog is
up: after a terminal Yes the hold lasts until `PostToolUse`, so the refusal
also covers the approved command's run (#1144).

**A typed answer carries the screen's numbering** (#1134). This applies only
where no held hook stands behind the card: hook-less prompts (sandbox network,
trust, agent-team dialogs; not all of them reach the phone, the daemon's
startup folder-trust dialog does not, #1147) and, until #1127,
AskUserQuestion / ExitPlanMode /
multi-choice cards. When a hook record merges onto a parsed prompt
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
  for an AskUserQuestion pick, equal it with the description appended
  (`option-mismatch`). Nothing looser: it fails closed; the accepted cost is
  false refusals on short, partial-frame or reworded labels. A pushed-by-id
  card keeps the hook's numbering, so this refuses its digit wherever the
  hook's list differs from Claude's (ExitPlanMode's list is hardcoded, Claude
  builds its own).
- free text is refused when the card has options and takes no text and a
  numbered menu is on screen (`free-text-into-menu`), and always on a
  pushed-by-id (`held`-stamped) card that has options and takes no text
  (`free-text-on-held-card`). Free-form `user_input` (including a Telegram
  text reply) is a separate path with its own guard, next.
- a question is claimed while its answer is applied: a duplicate delivery of
  the same choice (the lock screen sends every tap on two channels) reports
  delivered and types nothing; a different concurrent answer is refused.

**Chat text is refused while a numbered prompt menu is on screen** (#1140).
`onUserInput` types structured input (web chat, a Telegram text reply or custom
text) followed by Enter, and Claude's numbered menu ignores the letters while
the Enter confirms the highlighted option, usually "1. Yes", so a message sent
from the phone while a prompt waits would approve it. When the session's
tracker observes a numbered selection box (`observedPromptOptions`, wired by
`trackerScreenDeps`, the same signal the guards above read; `isNumberedMenu`:
every option value is numeric) nothing is typed and the sender gets an `error`
with code `PROMPT_WAITING` ("Claude is waiting on a prompt. Answer it from its
card or in the terminal (Esc dismisses it)."; `PROMPT_WAITING_ERROR_CODE` and
`createPromptWaitingError` in `@remi/shared`), plus a trace record
(`input_refused`, reason `chat-into-menu`). Telegram renders it as "Error:
..."; the web client marks the refused bubble failed from `details.messageId`.
A Stop (`onKillSessionRequest`) reads the same view and, with a numbered menu
up, types no `/exit` and force-closes the session instead.

Deliberately typeable: raw input (`raw: true`, an attach client's keystrokes,
the web client's Escape button and Telegram's `/interrupt`, which is how a menu
gets answered or dismissed; its Escape is written exactly, no Enter); a
subprocess `(y/n)` prompt, or Claude prose ending in "(y/n)", which observes
options "y"/"n" and takes text; a free-text prompt (an empty option list); and
anything when nothing is observed. A raw write that fails is answered with
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
guess and can clear the observation while the menu is still up. (4) The
no-tracker branch is effectively dead in production: `cli.ts` builds a tracker
for every session, hook server or not. It exists for a caller that does not
wire `observedPromptOptions` (tests, a future entry point) and it fails open
(types the text), the opposite of the answer guards above.

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
  at once. The `subagent_alert` informational push
  (`auto-approve/subagent-alert.ts`, patterns in `[notifications]
  subagent_alert`) still fires from the gate's `onSubagentPassthrough` cue.
- **Daemon or hub mode (no local terminal):** nobody could answer a rendered
  dialog, so the request is escalated exactly like a main-agent prompt: held,
  with an answerable card. A lead `Stop` spares it; that agent's
  `SubagentStop` releases it. Claude does not fire `PermissionRequest` for a
  call its own allow rules permit (measured on 2.1.287 for background,
  foreground and main calls), so these holds are only for real prompts.

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
- iOS categories `REMI_YN`, `REMI_YNA`, `REMI_MULTI` registered in `AppDelegate.swift`. Their actions are positional (`OPT_i` sends option i) and the first two have hardcoded titles, so `selectPushCategory` picks by meaning, not count (#1134): `REMI_YN` only for exactly [one-time Yes, No]; `REMI_YNA` only for exactly [one-time Yes, an always-allow rule, No], the middle option marked `standingGrant: 'addRules'` (#1126: only there is its static "Yes, always" title true; a `setMode` or unmarked standing option gets no category; its "Yes, always" button is the only static action that requires an unlocked device). A one-time Yes is an option labeled exactly "Yes"; any other Yes is a standing grant, as is any Yes after the first option and a session-grant action. A card with a standing option in any other layout gets NO category (a plain notification, answered in the app), because `REMI_MULTI`'s buttons do not require an unlocked device. No card with a standing option gets the `dynOptions` hint, `REMI_YNA` included: the extension builds its dynamic buttons without `.authenticationRequired`, so a standing grant behind one could be tapped while locked. Every other 2-4 option card gets `REMI_MULTI`. When the Notification Service Extension does not run, `REMI_MULTI` shows all four static "Option N" buttons whatever the option count; a button with no option behind it sends no answer (`RemiAnswerRelay` finds no `opt_n` and defers to the app), and any answer that does arrive still passes the `handleAnswer` guards (an iOS follow-up will add 2- and 3-button categories).

**Push classes and who can mute them** (#968):

Every push carries an explicit `kind`. Before that field existed the classes
were told apart by a NEGATIVE test ("no `questionId`, no `category`") which
could not distinguish turn-complete from a subagent alert at all — on the wire
those two are both exactly `{token, title, body}`.

| `kind` | Fires on | Mutable per device |
|---|---|---|
| `question` | permission prompt, AskUserQuestion, plan approval; an "answer at the terminal" notice (hold deadline, wrapper-mode subagent dialog; no actions, own collapse key) | yes, `pushPrefs.questions` |
| `turn_complete` | `Stop` after a turn ≥ `turn_complete_min_seconds` (#914) | yes, `pushPrefs.turnComplete` |
| `subagent_alert` | a background agent matched `[notifications] subagent_alert` | no — the pattern list IS the control |
| `harness_denied` | `PermissionDenied`: Claude Code's auto-mode classifier blocked a call, or auto-denied an unanswered fallback prompt at 2:00 (#1126); informational, never a card; one collapse key per session (`harness-denied-<sessionId>`), so a blocked loop replaces its notice | yes, `pushPrefs.harnessDenied` |
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
- **A muted fan-out reports `no_channel`, not `pushed`.** Claiming delivery
  for a fan-out of zero says a card reached a lock screen it never appears on.
- Malformed preferences fail toward DELIVERING (`sanitizePushPreferences`). A
  wrongly-delivered notification is a nuisance; a wrongly-dropped one is the
  product failing at its only job.
- `notifications.on_turn_complete = false` in `config.toml` stays the
  machine-wide master switch and wins over any per-device preference.

**Constraints from real logs (2026-04-12 analysis, updated #718 2026-07-06):**

- Bash `PermissionRequest` may have `permission_suggestions=undefined` (no suggestions), a legacy plain-string label array (e.g. Edit's `["Yes","Always","No"]`), or — since ~Claude Code 2.0.54 — a STRUCTURED array of typed "permission update entries" (`addRules`, `addDirectories`, `setMode`, `removeRules`, `replaceRules`, `removeDirectories`, each carrying `behavior`/`destination`; ground truth: code.claude.com/docs/en/hooks).
- Notification message is plain text ("Claude needs your permission to use Bash"), no numbered options, and never carries `permission_suggestions` at all.
- Claude Code does NOT always offer a fixed option count. `optionsFromSuggestions` (hook-event-bridge.ts) builds a binary card by MEANING (#1126): [Yes] + one standing option per offerable suggestion (`setMode`, allow `addRules`; never `addDirectories`) + [No], capped at 4 total; with nothing offerable, the honest Yes/No 2-set (`optionsAreFallback: true`). A multi-choice string-label set maps label by label to picks. This is the hook's view, not the screen's (Claude's dialog does not render one option per suggestion, #1134), which is why a held card is answered through the hook and never typed.
- Numbered option text appears only in the terminal UI, not in hook events.
- `HookEventBridge` builds the option set at hook time; a binary card is held and pushed at once, and its answer is the hook response (#1126).
- A standing option is answered by echoing its `permission_suggestions` entry (`QuestionOption.suggestionIndex`) as `{behavior:"allow", updatedPermissions:[...]}` on the held hook. Verified live on Claude Code 2.1.287 (#1126 spike F4) for `setMode` and `addRules`; every echo is sent with `destination: "session"` (lead decision), and an echoed `addDirectories` did not stop the repeat prompt, so it is never offered.
- Redeploy the signaling server after any `packages/signaling/` change.

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
