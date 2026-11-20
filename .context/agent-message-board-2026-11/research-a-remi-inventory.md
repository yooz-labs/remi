# Research A: what Remi has today for an agent message board (#1801)

Date: 2026-11-17.
Read-only inventory of Remi at `origin/develop` `1f822f99` (0.9.1-dev.1).
Every path is relative to `packages/` unless it starts with `docs/` or `.context/`.
"Called" says whether something in production calls the code (grep for callers), per ADR 0011.
Nothing was run: no daemon, no hub, no test.
Anything marked UNVERIFIED rests on reading comments or code only, or on a vendor behavior this report did not check.
Harness-side mechanisms (Claude Code, Codex, OpenCode) and prior art are other agents' work and are not covered.

## 1. The session model

**One daemon hosts one session.**
`daemon/src/harness/types.ts:8` says so, and the harness is a per-daemon singleton.
A session daemon is a `remi --daemon` process with a WebSocket port, a hook port and one PTY.
The hub (`remi serve`) hosts no session, never spawns an agent, and spawns child daemons on `create_session_request` (`docs/agent-reference/hub-mode.md`, "Hub mode"; `daemon/src/cli/handlers/create-session-events.ts:276`, `startSession`; `daemon/src/cli/daemon-manager.ts:598`, `spawnRemiDaemon`).
Called by `onCreateSessionRequest` and by `resume_session_request` (hub-mode.md, #1129).

**Ids.**
Three identifiers exist per session:
- The remi session id (UUID), assigned by the daemon, key of `~/.remi/live-sessions/<id>.json` (`daemon/src/session/session-registry-file.ts:37`, `LiveSessionEntry`) and of `~/.remi/sessions.json` (`daemon/src/session/session-store.ts:29`, `StoredSession.remiSessionId`).
- The harness's own id: `claudeSessionId` for Claude, pre-assigned with `--session-id` at launch (`daemon/src/cli/claude-binding.ts:109`); a Codex thread id, learned after launch.
- `harness` and `harnessSessionId` on the wire (ADR 0032, 0033), dual-emitted on `hello_ack`, `question` and the session list.
For Claude `harnessSessionId` is derived from `claudeSessionId` and never stored; absence of `harness` means Claude (`shared/src/harness.ts`, `daemon/src/session/session-store.ts:44-60`).
For Codex `harnessSessionId` is null until the thread is found (`docs/agent-reference/harnesses-and-codex.md`, "Dual-emit").

**Harness vocabulary.**
`HARNESS_IDS = ['claude','codex','opencode']` (`shared/src/harness.ts:18`).
`opencode` is named and has no adapter, so no daemon offers it in `hello_ack.harnesses` (same file, comment above line 18; `daemon/src/harness/registry.ts`).
The OpenCode recipe (HTTP server, SSE, `OPENCODE_SERVER_PASSWORD`) is deferred in `.context/strategy-2026-10.md` section 7.
There is no `remi opencode` subcommand: the subcommand list is `daemon/src/cli/arg-parser.ts:13`.

**Naming and addressing a session today.**
`remi attach <name>`, `remi attach host:port/name` and `remi kill` resolve by name prefix, port or id (`daemon/src/cli/cmd-attach.ts`, header).
The name is `hostname:dirname/branch` with `:2`, `:3` suffixes for duplicates (`daemon/src/session/session-name.ts:20`).
A session list entry carries `sessionId`, `name`, `projectPath`, `status`, `harness`, `harnessSessionId`, `canAttach` (`shared/src/types.ts:544`, `DiscoverableSession`).
Nothing lets one session address another: there is no CLI verb, protocol message or env variable for it (grep of `SUBCOMMAND_LIST`, `shared/src/protocol.ts` message map, `pty/child-env.ts`).

**How sessions start.**
- `remi claude` / `remi new` (local, no `--host`): the process becomes a wrapper around the harness in the caller's terminal (`daemon/src/cli.ts`, falls through to the wrapper after the `--host` block at `cli.ts:964-1030`).
- `remi codex [prompt]`: same, running `codex --no-alt-screen`; a first prompt is allowed locally and is passed after an inserted `--` (`daemon/src/harness/codex/codex-args.ts:200-302`).
- `remi new|codex --host <h>`: opens a temporary WebSocket, sends `create_session_request`, then attaches the caller's terminal to the child (`daemon/src/cli/remote-new-client.ts`, header; `cli.ts:971-1000`).
It ends in `runAttachClient`, so it is a terminal-attached flow, not a "spawn and return the id" call (header lines 1-9 of that file; the return path through `result.exitCode` at `cli.ts:1000`).
- Raw `create_session_request` to a hub or session daemon (`shared/src/protocol.ts:1217`): fields are `directory`, `harness`, `args`, `workspace`; the response is `sessionId`, `port`, `notice`, `workspace` (`:1246`).
**There is no initial-prompt field.**
Remote `args` are an allowlist: Claude takes only `--resume <uuid>`, `--fork-session`, `--model <name>` (`daemon/src/harness/claude-args.ts:45-95`); Codex takes `-m`, `-s read-only`, `resume <uuid>` and refuses a prompt (`codex-args.ts:276`, "takes no prompt").
So an agent that creates a session through the wire cannot hand it a task; the first message would have to arrive after the child registers.
- `codex exec` is refused by Remi's own launch: `remi codex` runs the interactive TUI only and rejects a first positional that is a Codex subcommand (`codex-args.ts:295`).
A Codex thread started by `codex exec` on the shared app-server is not a remi session; a request about any thread other than the session's own is ignored and never answered (harnesses-and-codex.md, "What becomes a card", `ThreadTracker.role` at `daemon/src/harness/codex/thread-tracker.ts:242`).
So today a recursive `codex exec` from Claude is invisible to Remi.

**Parent/child relations that exist.**
1. Hub to child daemon: only a process relation.
The child gets `REMI_SPAWNED_CHILD=1` (`daemon-manager.ts:627`), which selects the status file name (`cli.ts:89-96`) and silences a duplicate notice (`daemon/src/cli/auto-approve-removal.ts:120`).
Neither `LiveSessionEntry` nor `StoredSession` has a parent, creator or requester field (read in full: `session-registry-file.ts:37-130`, `session-store.ts:29-61`; grep for `parentSession|spawnedBy|forkedFrom|originSession` over `daemon/src`, `shared/src` finds only the two below).
2. Claude subagent view: a UI-only link, `isSubagent` / `parentSessionId` on the web session type (`web/src/types/index.ts:215-217`, set in `web/src/App.tsx:829-849`); `SubagentStart/Stop` hooks feed it.
3. Same-project siblings: hooks are project-scoped, so every `claude` in one directory fires at every daemon watching it; `ForeignSessionEscalator` (`daemon/src/hooks/foreign-session-escalator.ts:125`) and the transcript binder disambiguate.
Its header names a past wrong-session injection ("the evil twin of #538") as the reason an answer must never be routed to another session's PTY.
4. Workspaces (ADR 0036): `SessionWorkspace{repository, directory, worktree}` (`shared/src/protocol.ts:1207`) groups sessions by repository, only on request.
No ADR or doc defines a spawn relation between agents; `grep -rniE "inter-agent|between sessions|session-to-session|message board"` over `daemon/src`, `docs`, `.context/plan.md`, `AGENTS.md`, `.context/decisions` returns nothing relevant.

**What an agent process knows about Remi.**
A Claude child gets `REMI_PORT=<its daemon's WebSocket port>` and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` (`daemon/src/cli/session-phases/pty-session-setup.ts:209`); a Codex child gets no remi variable (`pty-session-setup.ts:121-135`, `PtyLaunch.childEnv`).
Neither gets its remi session id.
Remi's own secrets are stripped from the child's environment (`daemon/src/pty/child-env.ts:22`: `REMI_PASSPHRASE`, `REMI_PUSH_SECRET`, `TELEGRAM_BOT_TOKEN`).
Consequence, read from code and not run: `remi new --host` defaults its port from `REMI_PORT` (`cli.ts:985`), so inside a Claude child it would aim at that session's daemon and not at the hub; UNVERIFIED whether a session daemon honors the request.

## 2. How text reaches a running session today

| Harness | Path | Evidence | Safe while a prompt is up? |
|---|---|---|---|
| Claude | `user_input` (typed line plus a separate Enter) through `PTYSession.submitInput`, serialized on one write chain | `daemon/src/cli/handlers/input-events.ts:1338` (`onUserInput`), `:1513`; `daemon/src/pty/pty-session.ts:347` | No: refused with `PROMPT_WAITING` by the chat guard |
| Claude | raw input (`raw: true`: attach keystrokes, Esc button, `/interrupt`) written as-is, no Enter | `input-events.ts:1391` | Unguarded by design (a person at the terminal) |
| Claude | card answers: held hook response, or a typed digit behind screen guards | ADR 0031; `input-events.ts` `handleAnswer` | The answer path, not a chat path |
| Codex | structured `turn/start` or `turn/steer` over the shared app-server, never the PTY | `daemon/src/harness/codex/codex-text-writer.ts:189`; `codex-session.ts:706` | Refused `prompt_up` while a main-thread request is pending (`codex-text-writer.ts:142,161,184`) |
| Codex | typed chat: refused always (`acceptsTypedChat: false`) | `codex-session.ts:715`; `input-events.ts:1349,1425` | n/a |
| OpenCode | none (no adapter) | `shared/src/harness.ts` | n/a |

**The chat guard.**
`promptUp` (`daemon/src/cli/handlers/prompt-up.ts:79`) returns `held`, `terminal` or `menu` from the permission gate and the screen tracker, and the same signal gates Stop.
`onUserInput` refuses before and again inside the serialized write (`input-events.ts:1458`, and the guard closure at `:1513`), so a prompt that appears during the text-to-Enter delay still refuses.
Refusal codes a sender sees: `PROMPT_WAITING` (three messages), `SESSION_NOT_FOUND`, `STALE_BINDING`, `INPUT_NOT_DELIVERED` (with `inputMayBePartial`), per `input-events.ts:1338-1560`.
Known holes recorded by the code itself: a `terminal` entry can age out while a dialog remains; the no-tracker fallback fails open (`prompt-up.ts` header; AGENTS.md "Question Detection").
A connection must be attached to the session to type (`getSessionForConnection`, `input-events.ts:1349`); a `query`-mode connection cannot.
`onUserInput` does not read the agent's working or idle status: text sent mid-turn goes to the TUI as typed.
UNVERIFIED how Claude Code's TUI queues text typed during a turn; nothing in this repo establishes it.

**Structured chat for Codex (#1207, ADR 0043, `docs/codex-remote-chat.md`).**
Strict codec `chat_submit_request` / `chat_submit_result` in `shared/src/structured-chat.ts`; text at most 16 KiB (`:10`), nonblank, NUL-free.
Refusal codes: `malformed unavailable binding_changed prompt_up busy conflict sequence unsupported` (`:15`); uncertain codes `delivery_unknown receipt_expired conflict`; accepted carries `turn/start` or `turn/steer` and a turn id.
Per-connection sequence numbers, 32 receipts per pair, and "an uncertain result is never automatically replayed" (`daemon/src/harness/submission-sequence.ts:54`; doc "Signed direct delivery").
**Authority is a signed device, not the CLI capability.**
`StructuredChatService.direct()` requires `connectionClientPublicKey` and fingerprint, or a hub-proved relay snapshot (`daemon/src/cli/handlers/structured-chat-events.ts:83-91`); `connection.ts:294` says that key is "absent for capability-only and virtual relay connections".
The capability `structured_chat` is added to `hello_ack` only per attached signed connection (`cli.ts:1218`, `isAvailable` at `structured-chat-events.ts:197`).
It is Codex only (`structured-chat-events.ts:119`, `identity?.harness !== 'codex'`).
So a local agent or the CLI cannot use this path today, and Claude has no structured equivalent: its only text path is the PTY.
Native clients have only the capability name constant (`native/RemiKit/Sources/RemiKit/Protocol/ProtocolSupport.swift:22`); no native sender (grep of `native/` finds only that file).

**What a message into a session looks like afterward (provenance gap).**
A line typed through `user_input` becomes a plain `user` transcript entry with no `isMeta`, and Remi renders it as the person's own chat bubble.
Claude Code's own cross-session messages arrive as `isMeta: true` entries wrapped `Another Claude session sent a message: <agent-message from="...">`, and Remi deliberately drops them from the chat view (`daemon/src/transcript/transcript-message-bridge.ts:170`, `user-entry-provenance.ts:95` `NON_HUMAN_WRAPPER_PREFIXES`; `transcript/types.ts:55-75`).
So (a) a board message typed into Claude is indistinguishable from the person's own text in Remi's UI, and (b) Claude's native agent messages are invisible in Remi today.
The `MessageSender` type has no peer value: `'agent' | 'user' | 'system'` (`shared/src/types.ts:23`).

## 3. Wire and auth

**Protocol version and capabilities (ADR 0035).**
`PROTOCOL_VERSION = 1` (`shared/src/protocol-version.ts:16`); additive changes keep it, a new request field an old daemon would ignore needs a capability (`protocol-version.ts:35-46`: `workspaces`, `image_staging`, `image_insertion`, `structured_chat`, `browser_links`, `file_download`, `notifications`).
The daemon's base list is `['workspaces']` (`daemon/src/cli/capabilities.ts:18`); per-connection ones are added in `cli.ts:1218`.
Clients decide with `hubSupport(ack, needs)`, never by `daemonVersion`.
Message types live in one registry (`ProtocolMessageMap`, ADR 0012), pinned by golden fixtures; a board message type would be a registry entry plus a capability.

**The decision object (ADR 0038).**
A "needs you" moment is `Question` with `answerPath` (`structured`, `keystroke`, `none`), `question_resolved.resolvedBy` (`phone lockscreen terminal harness timeout`) and an open `kind`; every dismissal goes through `createQuestionResolver` (`daemon/src/cli/question-resolution.ts`).
The board could reuse the card vocabulary for "agent X asks you whether agent Y may be told Z"; it does not need a new decision shape.

**Device auth and pairing.**
Auth is on for every bind (`auth.enabled="auto"`, #873): an Ed25519 challenge, unknown keys become pending candidates, and the owner runs `remi authorize <fingerprint>` at the machine; `remi pair` shows a QR with terminal fingerprint approval (ADR 0037; `docs/agent-reference/transport-auth-pairing.md`).
Grants are re-read per authentication and at the ping tick (#1305).

**The local capability token (#869).**
`~/.remi/capability.key`, mode 0600, sent as `x-remi-capability` on the WebSocket upgrade (`daemon/src/auth/capability-token.ts:38`); the CLI attaches it only for a canonical local target (`daemon/src/cli/capability-client.ts:23`).
Its own header says it is "not a boundary": any process running as the same user can read it.
A Remi-launched agent runs as that user and its environment is scrubbed of env secrets only, not of this file.
So today any same-user agent could already open a capability connection and type into or create any local session, with no board, no attribution and no consent.
This is read from the code; UNVERIFIED by any attempt, and a Codex sandbox may block the read (not checked).
A board that mediates agent messaging gives that capability an audit point; it also means the board must not assume agents lack a back door.

**Hook server.**
Claude hooks POST to `/hooks` on a loopback port, no token, Origin refused (`daemon/src/hooks/hook-server.ts:252-266`).
Hook config is written into the project's shared `.claude/settings.local.json` before spawn (`daemon/src/hooks/hook-config-manager.ts` header).
Registered events are only `PreToolUse PostToolUse Notification Stop PermissionRequest PostToolUseFailure SubagentStart SubagentStop StopFailure SessionEnd PermissionDenied Elicitation ElicitationResult UserPromptSubmit` (`daemon/src/hooks/hook-types.ts:724`); `TeammateIdle`, `TaskCreated` and `TaskCompleted` are typed but deliberately unregistered (each registration is a synchronous roundtrip that gates Claude, #203).
The hook channel is agent-to-daemon event delivery only; an agent cannot send an arbitrary payload through it.

**The relay (docs/relay-daemon-v2.md).**
Hub-owned, off by default, encrypted semantic frames; raw PTY frames are refused (`daemon/src/remote/hub-relay.ts:1485`).
The Worker sees routing metadata; legacy plaintext push is still ON by default until the R7 gate, with prompt excerpts in plaintext (AGENTS.md "Cloud privacy", "Push is APNS only").
Board message bodies must not ride the legacy push; the sealed path (R5) exists and is unverified on signed devices.
The hub can already hold WebSocket connections to children and forward `chat_submit_request` to them (`daemon/src/remote/child-proxy.ts:409`), a precedent for a hub-side component that talks to many session daemons.

## 4. Persistence and history

| Store | What | Evidence | Reusable for a board? |
|---|---|---|---|
| `~/.remi/live-sessions/<id>.json` | One file per live daemon: pid, ports, project, name, harness, version, `pendingQuestions` mirror | `session-registry-file.ts:37` | Yes as the directory of addressable peers; the hub already reads `pendingQuestions` off disk (`daemon/src/cli/hub-question-census.ts:19`, `hub_status` at `shared/src/protocol.ts:1583`) |
| `~/.remi/sessions.json` | Stored sessions, version 1, atomic tmp+rename under an interprocess lock | `session-store.ts:29,391` | Pattern only; the file must stay readable by an older daemon (ADR 0032), so a board needs its own file |
| Claude transcript `.jsonl` | Chat history, read by the transcript handler; user entries carry `isMeta` | `daemon/src/transcript/`, ADR 0001 | Source of truth for Claude chat; a board message echoed there is the only trace of it in Claude history |
| Codex history | Read from the app-server (`thread/turns/list`), no file; `transcriptPath` is null | `harness/types.ts` (`HarnessChat`), `docs/codex-remote-chat.md` | Same for Codex |
| `MessageAPI.messages` | In-memory map per session; bullet engine, replay buffers; nothing persisted | `daemon/src/api/message-api.ts:114` | No, memory only and per session |
| Question trace | Opt-in, lengths only, no text | `daemon/src/session/question-trace.ts`; harnesses-and-codex.md "Logs and what persists" | Pattern for metadata-only audit |
| Storage helpers | `writeRestrictedJson` (0600, fsync, atomic), `withInterprocessFileLock`, `local-daemon-endpoints.ts` | `daemon/src/storage/restricted-json.ts:6`, `interprocess-file-lock.ts` | Yes: a durable board log can be built on these without a new database |
| Notifications | `PushKind`: `question turn_complete subagent_alert harness_denied turn_failed dismiss` | `daemon/src/notifications/push-client.ts:93`; `turn-events.ts:76` | A board kind would be a new `PushKind` plus a per-device preference |

There is no message store, inbox, outbox or delivery ledger.
The closest delivery-receipt design is `SubmissionSequence` (sequence per connection and session, bounded receipts, uncertain never replayed), which a board could mirror for peer messages.

## 5. The apps

**Terminology collision.**
"Board" in the native apps already means the freeform canvas of session tiles on Mac and the multi-column session cards on iPad and iPhone Duo (`native/RemiKit/Sources/RemiUI/RemiBoard.swift`, `BoardTile.swift`; `native/Mac/MacCommandCenter.swift`; `native/iPhone/PhoneBoardScreen.swift`; `native/handoff/ipad-board.md`).
Each tile has a composer that sends to its session (`RemiBoardTileSendState.swift:29`, `canSend`).
"Inbox" means cards that need the person (`native/RemiKit/Sources/RemiUI/InboxPresentation.swift`, `native/iPhone/InboxScreen.swift`, `native/Mac/MacInboxColumn.swift`): its states are first run, waiting cards, quiet.
A message board between agents needs a different name in the UI and in the wire (suggest "channel" or "thread", not "board") to avoid confusion with the existing Board.

**Web (`web/src`).**
Session list and cards (`components/session/SessionList.tsx`, `SessionCard.tsx`), chat (`components/chat/ChatView.tsx`, `InputArea.tsx`, `MessageList.tsx`), question cards (`QuestionCard.tsx`), a harness label for non-Claude sessions, and a subagent view (`isSubagent`, `parentSessionId`).
Chat refusals are rendered by `lib/prompt-waiting.ts` and `lib/input-refusal.ts`; structured Codex chat has a web caller in `lib/structured-chat.ts` and `hooks/useConnectionManager.ts`.
Nothing renders a message from one session to another.

**Native.**
Mac app (command center, inbox column, jump palette, machine sidebar) and iPhone app (inbox, board, drawer, session screens), sandboxed, never running git or spawning an agent (ADR 0036, `native/AGENTS.md`).
It consumes `session_update` and `remi_status`, the session list and questions; no native code for structured chat, workspaces beyond what ADR 0036 lists, or any peer message.
The native tree is PolyForm Shield (`packages/native/LICENSE.md`); the daemon and shared packages are Apache-2.0.
Telegram is a further human surface (`daemon/src/adapters/telegram-adapter.ts`).

## 6. Invariants a board must not break

1. **ADR 0030, remi relays and the harness decides.**
Remi judges no permission and never answers one without a human choice (`.context/decisions/0030-...md`, Decision).
A board must not let agent A answer or approve agent B's card; a message into B is chat text, not an answer.
2. **ADR 0031, held-hook answers.**
A held prompt is answered through its hook, never by typing, and "no card answer is typed into the PTY for a hook-backed binary prompt".
Peer text must never be typed while `promptUp` is non-null; a typed Enter confirms the highlighted option.
3. **ADR 0049 D10 (no credentials).**
Remi never reads, copies, stores, prints or relays a credential or token (`.context/decisions/0049-account-switching.md:354`); the ADR's status is "accepted as the direction" with phases 5, 5B and 6 not approved, so D10 is direction, not shipped code.
Board payloads must not carry tokens; the capability file and the relay secrets stay out of any message.
4. **Harness seam (ADR 0032).**
`tests/harness/harness-boundary.test.ts` forbids `harness/types.ts`, `harness/decision.ts`, `cli/handlers/`, `api/`, `session/`, `cli/current-session.ts` and the PTY spawn from importing `hooks/`, `auto-approve/`, `transcript/`, `cli/session-phases/` (except `pty-session-setup.ts`), Claude screen parsers or `harness/claude*`; only `cli.ts` and `harness/` may import `harness/index|claude|claude-session` at runtime; only `cli.ts` may import `harness/codex/` (an allowlist `CODEX_MAY_IMPORT`).
A board module under a neutral directory therefore reaches harnesses only through `HarnessSession` members (`pty`, `decisions`, `acceptsTypedChat`, `chat`, `structuredChat`), the way `cli/handlers/structured-chat-events.ts` does; new delivery paths belong on the seam, not in handlers.
5. **License boundary.**
`daemon/tests/license-boundary.test.ts` fails if `packages/daemon/src` or `packages/shared/src` imports `web`, `signaling`, `macos` or `native`.
Board types and logic go in `shared`/`daemon` (Apache-2.0); UI goes in `web`/`native`.
6. **Verify before you describe (ADR 0011).**
No board doc may say messages are "secure", "private" or "delivered" beyond what a caller trace shows; acceptance is not completion (the #1207 doc's own rule).
7. **Same-machine, no cloud model.**
Remi runs no local or cloud model (AGENTS.md "No local model"); a board that summarizes or routes with a model is out of bounds.
The board must route by explicit addressing and rules, not by an LLM.
8. **Never answer a prompt for a wrong session.**
The #538 "evil twin" lesson (`foreign-session-escalator.ts` header): an answer routed through the wrong daemon injects into the wrong PTY.
Peer addressing must be by remi session id plus harness binding, checked at the write (as `STALE_BINDING` and `binding_changed` already do), never by name or cwd.
9. **Redeploy the Worker after any `packages/signaling/` change** and no agent deploys (AGENTS.md); a board over the relay needs an owner step.

## 7. Existing signals that could announce or carry a message

| Signal | Where | Use for a board | Called today |
|---|---|---|---|
| `Stop` hook with `last_assistant_message` | `hook-types.ts:122,285,334`, `hook-event-bridge.ts`, `notifications/claude-turn-stop.ts` | A turn end is when a peer message can be delivered safely, and the last message is a candidate "reply" | Yes: turn-complete push |
| Codex `turn/completed` | `harness/codex/codex-turns.ts`, `TurnEventSink` (`turn-events.ts:76`) | Same for Codex | Yes |
| `UserPromptSubmit` | registered, `hook-types.ts:738` | Confirms a delivered line reached Claude (what was submitted) | Yes: turn timer anchor |
| `SessionEnd`, `SubagentStart/Stop` | registered | Peer gone; subagent attribution | Yes |
| `Notification`, `PermissionRequest`, `Elicitation` | registered | Tells the board the target is blocked on a prompt (do not type) | Yes |
| `question tracker` / `promptUp` | `cli/handlers/prompt-up.ts:79`, `daemon/src/api/question-presence-tracker.ts` | The "is it safe to type now" gate | Yes |
| `session_update`, `remi_status`, `hub_status` | `shared/src/protocol.ts:832,822,1583` | Fan-out of board state to apps | Yes |
| Live-sessions directory | `session-registry-file.ts` | Peer discovery on one machine | Yes |
| `TeammateIdle`, `TaskCreated`, `TaskCompleted` hooks | typed, not registered | Claude agent-team signals | No |
| `<agent-message from=...>` entries | transcript, filtered out | Claude's native cross-session messages | Dropped on purpose (#936) |

Whether anything lets one session address another: no.
The only same-user, no-attribution route is the capability-token WebSocket described in section 3, which is a back door, not a feature.

## 8. Summary table

| Capability | Exists? | Evidence | What the board would add |
|---|---|---|---|
| Stable id per live session, harness-aware | yes | `LiveSessionEntry`, `harness`/`harnessSessionId` (`session-registry-file.ts:37`, ADR 0032) | A board address that pairs remi id and harness binding, checked at write |
| Directory of live peers on a machine | yes | `~/.remi/live-sessions/`; `hub_status` census | Peer list scoped to a project or room |
| Cross-machine peer directory | partial | hub per machine; relay `child discovery` aggregated per hub (`docs/agent-reference/transport-auth-pairing.md`) | Decide: single-machine v1, or federate |
| Parent/child (spawn) relation between sessions | no | no field in registry or store; subagent link is web-only (`web/src/types/index.ts:215`) | A `spawnedBy` record on create and in the list |
| Create a session remotely, headless | yes | `create_session_request` (`shared/src/protocol.ts:1217`) | A requester id and a link back |
| Create with an initial task | no | allowlists (`claude-args.ts:45`, `codex-args.ts:276`) | First message queued until the child is ready |
| Replace `codex exec` recursion with an attached session | no | `codex-args.ts:295`; exec threads ignored (`thread-tracker.ts:242`) | Launch verb for agents that returns a session id and a channel |
| Text to a running Claude | partial | PTY typing through `onUserInput` (`input-events.ts:1338`); no peer origin | A delivery path with attribution and queueing |
| Text to a running Codex | partial | structured chat only for signed devices (`structured-chat-events.ts:83`); typed chat refused | A hub-side sender for peer messages, with its own authority rule |
| Text to OpenCode | no | no adapter (`shared/src/harness.ts`) | Blocked on the OpenCode adapter |
| Safe-to-type signal | yes (Claude), partial (Codex) | `promptUpFor` (`prompt-up.ts:79`); Codex writer `prompt_up`/`busy` | Queue messages while blocked; deliver at turn end |
| Delivery receipts and uncertainty | partial | `SubmissionSequence` (Codex only, signed device) | Receipts for peer messages; same no-replay rule |
| Idle/turn-end events | yes | Stop hook, `turn/completed`, `TurnEventSink` | Trigger for delivery and for "reply ready" |
| Message store, history, replay | no | `MessageAPI` is in-memory per session (`message-api.ts:114`) | Durable log built on `writeRestrictedJson` and the lock helper |
| Provenance of a message in chat | no | no peer sender (`shared/src/types.ts:23`); injected text shows as the person's (`transcript-message-bridge.ts:170`) | A peer sender, a labeled envelope, bridge support |
| Claude native `<agent-message>` visibility | no | filtered by design (`user-entry-provenance.ts:95`) | Decide whether to show them in the board |
| Human sees and steers the conversation | partial | apps show sessions, chat, cards; no agent-to-agent view (section 5) | Channel view, mute, pause, edit, approve-before-send |
| Human approval of agent-initiated messages | no | cards exist for harness prompts only (ADR 0038) | Reuse the decision object for "agent X wants to message Y" |
| Wire versioning for a new feature | yes | ADR 0035, `PROTOCOL_CAPABILITIES` | New capability, message types in the registry, fixtures |
| Auth for peer messaging | partial | device identity or the same-user capability token (`capability-token.ts`) | An agent-to-hub credential-free route (no token handed to agents, ADR 0049 D10 spirit) or a hub-internal path |
| Relay carrying board traffic | partial | semantic frames only, no raw PTY (`hub-relay.ts:1485`) | Add message types; keep bodies out of legacy plaintext push |
| Push for a board event | partial | `PushKind` closed list (`push-client.ts:93`); sealed path unverified on devices | New kind plus per-device preference |
| Agent learns its own remi session id | no | env has `REMI_PORT` for Claude only (`pty-session-setup.ts:209`); none for Codex | Provide identity to the agent without a secret (for example a session id variable) |
| Agent tool surface to send a message | no | the daemon hosts no MCP server (grep for `modelcontextprotocol|McpServer|mcp-server|.mcp.json` over `daemon/src`, `shared/src` and package.json finds only MCP elicitation handling and Codex's own `mcp-server` subcommand name); no `remi send` verb (`arg-parser.ts:13`) | A CLI verb or a tool the agent can call |
| Boundary tests that apply | yes | `harness-boundary.test.ts`, `license-boundary.test.ts`, `pty-child-env-secrets.test.ts` | New code must satisfy all three |

## 9. Not verified

- No daemon, hub or CLI command was run; every behavior is from reading source and docs at `1f822f99`.
- Whether Claude Code's TUI queues text typed during a turn, and how it shows it.
- Whether a Codex sandbox or Claude Code setting blocks an agent from reading `~/.remi/capability.key`, and so whether the same-user back door is reachable from a real agent.
- Whether `remi new --host localhost` from inside a Claude child (default port from `REMI_PORT`) is accepted by a session daemon, and how it behaves without a TTY.
- That a hub-created Codex session ever reaches a state that accepts structured chat without a person at the terminal (the headless Update and Trust prompts are unverified, harnesses-and-codex.md).
- Native app behavior: the Swift tree was read by file name and a few headers only, not traced for a send path.
- Web rendering of a labeled peer message: no UI exists to check.
- The `.context/agent-message-board-2026-11/` directory held no other files when this report was written, so the other agents' reports were not read.
