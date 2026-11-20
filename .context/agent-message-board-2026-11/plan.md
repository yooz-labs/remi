# Plan: agent conversations through Remi (#1801)

Planner: Claude Fable, 2026-11-17, stage 3 of 3 (research, specification, plan).
Status: proposed; nothing here is approved, and no implementation starts before the owner approves this plan.
Base: `origin/develop` at `24051133` (0.9.1-dev.2); the spec was written against `1f822f99`, one version bump earlier.
Inputs: `spec.md` and `research-a-remi-inventory.md`, `research-b-harness-mechanisms.md`, `research-c-prior-art-and-security.md` beside this file; Architecture Decision Records (ADRs) 0011, 0013, 0030, 0031, 0032, 0033, 0035, 0036, 0038, 0043, 0049 (D10); `docs/agent-reference/`; the profiles epic pack as the model of shape.
This is a plan, not yet a manager-loop pack; section 14 says how it becomes one.

## Summary

**What this plan decides.**

1. The spec's shape (hub-owned store and policy, session daemons deliver, per-harness adapters behind the seam) is kept, with twelve changes argued in section 2.
   The largest: human approvals and every loosening control need a signed device, never the local capability key; cards are raised by a session daemon, not by the hub; internal hub-to-session frames stay out of the public message registry; a body that looks like a credential is refused, not held; an agent-spawned Codex child starts read-only unless the person chooses otherwise on the card.
2. Experiments come first, in four batches by what they need: nothing real (class N), a harness launch with no model turn (class L), Claude model turns (class M, at most 45 short turns), Codex model turns (class M, at most 25).
   The owner approves each batch; no experiment touches a real session, the real hub, or ports 18765 to 18769.
3. Phases: P0 experiments and ADR 0052; P1 store, hub-to-session link and read-only visibility; P2 Claude to Claude (endpoint and tools, then policy and cards, then socket delivery, then web controls); P3 Codex; P4 interactive spawn; P5 OpenCode (parked behind an adapter epic); a native-app lane (N1, N2) that the spec omitted from its phases; P6 parked.
4. On the owner's question (sockets or typing): the working position holds, and section 3 names the four experiment results that would reverse it for Claude.
   For Codex the question is already closed by a standing invariant: Remi types nothing into a Codex terminal.

**Least sure about** (detail in section 15).

1. Whether Bun can report the peer process of a Unix socket connection (experiment X1); without it, sender attribution cannot stop one session's agent from speaking as another.
2. Whether Claude's inbox socket is usable from Remi at all on the owner's account (E1, E2): the path flag is known only from `strings`, and the feature sits behind a remote flag.
3. Whether a Claude receiver in bypass mode can be served through the socket in hub mode (E4); the vendor's own hold dialog may have no terminal to show on.
4. The calendar: the profiles epic owns the same launch path and protocol files until at least its second checkpoint.

## 1. What I checked against code (2026-11-17, `24051133`), and what I did not

| # | Claim the design rests on | How I checked | Result |
|---|---|---|---|
| V1 | The hub already holds links to children (`remote/child-proxy.ts:409`) | `grep` for constructors of `ChildProxy` | Only `remote/hub-relay.ts:815` builds one: a relay-only precedent, over a loopback WebSocket, not a general hub-to-session link |
| V2 | A Unix socket with peer-process checks | `grep` for `Bun.listen`, `unix:`, `LOCAL_PEERPID`, `SO_PEERCRED`, `getsockopt` in `packages/daemon/src` | None exists; `bun:ffi` is used in two files (`cli/log-rotation.ts`, `tunnel/recovery-native.ts`), so a foreign-function route has precedent, the socket does not |
| V3 | The hub raises cards | `cli/hub-question-census.ts`, `docs/agent-reference/hub-mode.md` | The hub owns no card: it reads `pendingQuestions` from `live-sessions` files; clients reach each child by a direct connection; the question registry, resolver and push dispatcher (`sessionNotifiers`, `cli.ts:1293`) are per session daemon |
| V4 | Card kinds are open | `shared/src/types.ts:231`, `:368` | `Question.kind` is a closed union of three values in TypeScript and `QuestionSource` a closed union of four; ADR 0038 item 7 says "an open set, with no new kinds" |
| V5 | `promptUpFor` sources | `cli/handlers/prompt-up.ts:79-87` | As the spec cites: `held`, `terminal`, `menu` |
| V6 | Remi can add launch flags for Claude | `cli/claude-binding.ts:109,113`, `grep` for `--mcp-config`, `--settings`, `--messaging` | Remi adds only `--session-id` today; the three flags the spec needs are new launch surface |
| V7 | A `Stop` hook can be answered with a block | `grep` for `block` in `hooks/` | No path returns one today; `stop_hook_active` is read (`hook-event-bridge.ts:505`) |
| V8 | Posture is visible for Claude | `hooks/hook-types.ts:29` | `permission_mode: string` is on every hook input, so the Claude half of E14 is a test, not an open question |
| V9 | Native cross-session entries are dropped from chat | `transcript/user-entry-provenance.ts:95-102` | Confirmed, with the wrapper prefix the spec quotes |
| V10 | D10 | `.context/decisions/0049-account-switching.md:354` | Confirmed; it also forbids storing or forwarding an email, workspace name or account identifier, which the spec does not mention |
| V11 | Test helpers and gates named below exist | `ls` | `tests/helpers/fake-agent-clis.ts`, `fake-app-server.ts`, `tests/integration/hub-test-utils.ts`, `launch-characterization.test.ts`, `codex-launch-characterization.test.ts`, the three boundary tests, the fixture generator |
| V12 | Other work in the same files | The profiles epic board on `origin/chore/profiles-epic-plan` | P1A and P1C in review, P1B to do: the launch path, `cli.ts`, `protocol.ts`, `protocol-version.ts` and `capabilities.ts` are shared until its CP2 |
| V13 | Several Claude Code builds are installed | `ls ~/.local/share/claude/versions` | 2.1.321, 322, 323, 325, 326: a `strings` comparison of the socket wire across builds needs no launch (X5) |

Not checked by me, taken from the spec's log: `codex-text-writer.ts` branches, `structured-chat-events.ts` authority, `codex-args.ts` allowlist, `create-session-events.ts` `startSession`, `thread-tracker.ts`, every vendor page, and all native Swift code.

## 2. Spec challenges

Ordered by weight.
"Change" is what this plan does instead; each becomes text in ADR 0052 or an owner question (section 12).

| # | The spec says | Objection | Change |
|---|---|---|---|
| C1 | Approvals "travel on Remi's control plane" (P6); T7: the board "neither fixes nor widens" the same-user capability key | It widens it. Research A section 3: any same-user process, a Remi-launched agent included, can read `~/.remi/capability.key` and open a capability connection. Today that lets an agent type into a session. With the board, the same key would let a prompt-injected agent answer its own `peer_link`, `peer_message`, `peer_spawn` and `peer_budget` cards and send `peer_control_request`, which removes every human gate the threat model counts on. The main actor (an injected agent with a shell) gets the cheapest route, not a malicious process. | Answers to peer cards, and every loosening control (allow, deliver, start, resume, extend, unmute, board on, interject), are accepted only from a connection with a signed device key (`connectionClientPublicKey`, the rule `structured-chat-events.ts:83-91` already applies) or a hub-proved relay snapshot. Tightening (stop all, pause, mute, deny, drop, withdraw, close) is accepted from any authenticated connection, Telegram and the local command line included. `remi peer on` and `[peer] enabled` from a terminal stay possible and are stated as cooperative-grade. X2 measures the back door first; a test pins the refusal. New question Q22. |
| C2 | The hub raises cards of kind `peer_*` | Cannot be built as described (V3): the hub has no question registry, resolver, push dispatcher or answer handler, and clients read cards from session daemons. | The receiving session's daemon raises `peer_link`, `peer_message`, `peer_budget` and `peer_tripped` cards on the hub's instruction; the spawner's daemon raises `peer_spawn`. The hub keeps the policy state. The card must bypass `QuestionPresenceTracker` (one pending card per agent key, and `Stop` sweeps) and go to the session registry under its own agent key (`peer:<cid8>`), the way Codex cards do. X3 characterizes coexistence with a held permission card, a `Stop` sweep and a new prompt before P2B is carded. |
| C3 | Internal frames (`peer_forward`, `peer_deliver`, ...) are entries in `ProtocolMessageMap`, "refused on any other connection" | Putting a frame that names a sender on the public registry makes one missed guard a full impersonation path for a capability holder, and ADR 0013 then forces every consumer (web, attach client, relay adapter, native decoder) to carry entries for frames it must never see. | The hub-to-session link and the agent-side endpoint use their own versioned line codec (`v: 1`), outside the registry, on Unix sockets only. Only client-facing `peer_*` messages enter the registry. A session daemon advertises the link in its `live-sessions` entry (`peer: {v, socket}`), which the hub already reads, instead of a `peer_delivery` capability on an ack the hub never receives (V1). ADR 0013 then needs no amendment. |
| C4 | A body matching a credential prefix is held for the person (Q21) | A person tapping Deliver makes Remi relay what Remi itself flagged as a credential, which is D10's "relay a credential or token" by Remi's own description; and the body is already on disk. A prefix list is also the denylist pattern the project retired (ADR 0030; the owner's "fail closed over denylist" lesson). | Refuse the send (`refused: looks_like_credential`), store only size and hash, never the body, and describe it as a courtesy check that catches obvious mistakes. Or drop it from v1. Recommendation: refuse. Q21 restated. |
| C5 | A spawned child gets "the host's default posture" | The owner's Codex default is full access (ADR 0043). A prompting Claude session, which must ask before a risky command, could then ask Remi to start a full-access Codex with a task the agent wrote: a confused deputy by spawn, with one card (showing 300 of up to 8,192 characters) as the only control. | An agent-spawned Codex child starts with `-s read-only` by default (the one tightening the remote allowlist has); the card states the child's posture in words and offers "Start read-only" and "Start with this machine's default", the second only in the app with the full task visible. Claude has no allowlisted tightening, so a Claude child always shows its posture line. New question Q23. |
| C6 | Placement `same_repository` means the spawner's main worktree | Story S2 (an independent review) needs the reviewer to see the spawner's worktree and its uncommitted changes; the main worktree is the wrong directory. `new_worktree` also creates worktrees nothing ever deletes (ADR 0036), with an agent choosing when. | Placement `spawner_directory` (default, the spawner's own directory) in P4; `new_worktree` is deferred to a later step with a count limit, behind its own question (Q24). |
| C7 | One store "written only by the hub" with atomic JSON, plus a delivery ledger the session daemon writes before a hand | Two contradictions: the ledger is a second writer, and rewriting a conversation file per message (up to 1,000 messages of 8 KiB) is a rewrite of megabytes per send. | The hub is the only writer of `~/.remi/peer/`; conversations are append-only JSON lines with a small index, compacted at close. The session daemon keeps no queue and no ledger of its own: it hands only on a fresh `deliver` instruction and reports back; the hub records `handing` before it instructs. Hub down means nothing is handed. X4 measures the write cost. |
| C8 | `handed` is non-terminal with no deadline | A bypass-mode Claude receiver holds a socket message in its own dialog for five minutes and then drops it; in hub mode nobody sees that dialog. The message would read "Sent to Claude, not yet confirmed" forever, which ADR 0011 forbids in spirit. | `handed` or `typed` without `seen` for 10 minutes becomes `unconfirmed` (terminal, "No confirmation that it arrived"), and the sender gets the one failure notice. |
| C9 | One message in flight per recipient across conversations; a held message blocks later ones; the person's interjections join the same order | A held message waiting for a sleeping person blocks every other conversation to that session, and blocks the person's own interjection behind an agent's message. | Order is first in, first out (FIFO) per conversation; a held message blocks only its conversation; at most one hand in flight per recipient; a person-origin message goes ahead of queued agent messages. |
| C10 | `allow_unattended` as a link grant | With the owner's default it is "let another agent drive a full-access Codex without asking", the three-way combination research C section 3.2 warns about, as a standing switch. Without it, every message to Codex needs a tap (the spec's own K5). Both ends are bad. | The unattended grant is bounded: it covers at most the conversation budget (20 messages) and 60 minutes, then falls back to per-message holds; it is never offered on the lock screen and never for a spawned child's first task. Q25. |
| C11 | Peer items in chat via a new `MessageSender` value | A new enum value is not additive for a strict decoder (the native apps decode enums), and `hello` carries no client version to adapt to (ADR 0035, consequences). | Keep `sender` as it is and add an optional `peer` object on the chat item (sender session, harness, conversation, message id, origin). An older client shows a system line; a newer one draws the peer bubble. The N1 card checks the Swift decoder before anything ships. |
| C12 | "No change to `structured_chat` (ADR 0043)" | The wire is unchanged, but a new authority may start a turn on a Codex thread without a signed device, which is the heart of ADR 0043's authority rule. | ADR 0043 gets an amendment note, written with ADR 0052: board authority exists, uses only the idle branch, never steers, and is reachable only through the hub's instruction on the link. |
| C13 | P1 (observe native Claude traffic) is the first slice | It builds store, wire and screens on the least certain source: the messaging gate may be off for the owner (E1), and a peer message may be indistinguishable from a subagent report (E17). If either fails, P1 ships an empty screen. | P1 is kept as the first slice but its observation step (P1C) is conditional on E1 and E17; the store, link, read frames, command-line reads and web view land regardless and are what P2 needs. If observation is impossible, native traffic is stated as not shown. |
| C14 | The hub-observed Codex reply returns to the sender | It forwards model output the Codex agent did not choose to send, wakes the sender, and can start a loop with no tool call on the Codex side. | A `reply_observed` counts as an agent message for the budget, rate, breaker, wake budget and the credential check; the envelope line tells Codex so (the spec has that); a test pins the counting. |
| C15 | A body line equal to an envelope marker is refused | A body can still carry a fake person header ("[From the person via Remi ...]") or a fake Remi notice. | A body line that starts with `[Remi ` or `[From the person` is refused `malformed`; the person header carries the same `remi-msg` marker, so the app draws a person bubble only from the record. |
| C16 | `seen` by "the marker in the receiver's transcript" | The marker also appears if the receiver reads a file or tool output that quotes it. | Evidence is a match in a user-role entry, a `UserPromptSubmit` prompt, a Codex user item, or an inbox read; never tool output or assistant text. |
| C17 | Native surfaces are described (section 7) but in no phase | The Mac and iPhone apps are the owner's main surface, and they share one Xcode lock and one simulator with the profiles epic's app slices. | A native lane, N1 (read-only Switchboard, generic peer cards) and N2 (controls), outlined, starting no earlier than P2D and never beside a profiles app slice. |
| C18 | Spawn has no profile | The profiles epic adds `create_session_request.profile`; D10 forbids choosing a profile the person did not configure. | A spawned child runs under the spawner's profile; the card names it; no agent chooses a profile. Q26. Blocked on profiles P2B landing. |
| C19 | Holding by posture is "supervision", ADR 0030 untouched | ADR 0030 says Remi judges nothing. A posture-based hold and a size or rate refusal are Remi deciding about its own carriage, which is new; the ADR should say so instead of leaving it to look like a permission judge returning. | ADR 0052 states the line: Remi decides whether Remi carries a message, by fixed rules on metadata (who, how many, posture class), never on what an agent may do and never by reading the body for meaning. ADR 0030 gets a one-paragraph cross-reference. |
| C20 | The Claude socket is first choice, typing last | Agreed, with a gap: for a bypass-mode receiver in hub mode the socket may be unusable (C8), and pull with a nudge cannot wake an idle session. | The fallback order for Claude is decided by E4, E11 and E13 together (section 3), and E13 runs unconditionally. |

## 3. The owner's question: harness sockets, or type like a person with a prefix

The owner asked whether Remi should use the harness sockets or type into the session as a person would, with the sending session named in front so the app draws another bubble and the receiver knows it is not the human, "however it works best".

**What typing has going for it.**
It works on any terminal harness, needs no undocumented flag, shows in the receiver's own terminal, and lands in the transcript as an ordinary entry.
The socket depends on a flag known only from `strings` and a remotely controlled gate (spec 2.2).

**Why it is still the fallback, not the default.**

| Point | Structured channel | Typed text |
|---|---|---|
| What the receiving model is told | Claude frames a socket message as from another session, not the person, and enforces it: it cannot approve, change settings or run commands (vendor page, spec 2.2) | The text arrives as the person's turn, with the person's authority; a label in the text is a request to the model, not a rule |
| A prompt on screen | Cannot answer one (Claude); refused while one is pending (Codex writer) | A typed Enter confirms the highlighted option; the chat guard has two recorded holes (AGENTS.md, "Limits") |
| Confirmation | A turn id (Codex); a queue the harness owns (Claude) | None; "typed but not submitted" is a documented failure in the one project that ships typing (research C 2.3) |
| Mid-turn | Defined by the harness | Unknown for Claude's terminal (E13) |
| The receiver's own inbound rules | Kept: a bypass-mode Claude holds the message | Bypassed: Remi would be typing around the vendor's hold |
| Codex | `turn/start`, already built and guarded | Forbidden by a standing invariant (ADR 0033): nothing is typed into a Codex terminal |

**The bubble.**
The owner's goal (a different bubble, and the receiver knowing it is not the human) does not depend on the transport.
Both paths carry the same envelope, and the app draws a peer bubble only when the transcript entry's `remi-msg:<id12>` matches a message Remi's own record says it handed or typed to that session, with the same body hash.
A text prefix alone is never trusted: anyone who can put text in the session (the person, a pasted file, another tool) can write a prefix, and an unmatched envelope-looking entry is drawn as ordinary text.
So a typed fallback, where it is used, still gets the right bubble on current clients; an older client shows the envelope as the person's text, which is why the fallback needs the owner's explicit switch.

**Should the experiments change the position?**
For Codex, no experiment can: the invariant decides.
For Claude, yes, any one of these results moves typing (idle only, prompt guard, envelope) ahead of the socket, and E13 then becomes a gate instead of a footnote:

| Result | Meaning | Then |
|---|---|---|
| E1 fails: the socket is not bound where Remi says, or the gate is off for the owner and no discovery path works | No structured inbound exists | Pull plus nudge is the default; typing is the only way to wake an idle session, so the owner chooses between "no wake" and "typed wake" (Q15 reopened) |
| E2 fails: a line from a non-Claude process is dropped, held for every receiver, or shown without a usable sender | The socket exists but is not Remi's to use | Same as above |
| E3 shows a socket message can interact with an open dialog | The structured channel is not safer than typing on the point that matters most | Socket only when no prompt is up (already the rule); no relaxation ever |
| X5 or a new release changes the wire between two builds without notice | The channel is too unstable to be a default | Typed or pull default, socket behind a switch |

And these results keep typing off for good: E13 shows text typed mid-turn is queued unpredictably or the multi-line envelope is split into several submissions; or E4 shows a bypass-mode receiver's hold would be bypassed with no other control in place.
The plan therefore runs E13 in the first Claude batch whatever E1 says, so the owner's question is answered with evidence either way.

## 4. Experiment program (runs before any phase past P0)

### 4.1 Rules for every experiment

- Location: `/Volumes/S1/yooz/remi/artifacts/message-board-2026-11/exp/<id>/`, with a scratch repository (`git init`, one text file) per experiment that needs a project; nothing under the main checkout, nothing under `/private/tmp/claude-501`.
- Remi runs from source in this worktree, under `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-mb-exp/ REMI_HOME=<exp dir>/remi-home`, with an explicit port from 18801 to 18839 for a test hub and its children (never the default probe, which starts at 18765); before a start, `lsof -nP -iTCP:<port> -sTCP:LISTEN` must print nothing.
- No experiment attaches to, lists, messages or reads a real session; a batch that launches real Claude Code runs only after the owner confirms no other Claude session of theirs is live, because a real session with messaging on can list and address the test session (and the reverse).
- No credential is read, copied or printed; a harness uses the owner's existing default login as it is (no sign-in, no profile change); `~/.remi/capability.key` is read only inside a scratch `REMI_HOME`, except the E12 permission probe, which records only whether the read was allowed.
- Recorded per experiment: commands, versions, pass or fail per criterion, and structure only (keys, lengths, wrapper prefixes); never a message body from a real transcript.
- Output: one note per batch in this directory (`experiments-<batch>.md`), reviewed with the docs lens; each result is marked run, not inferred.

**Approval classes.**
N: no real harness process (Bun scripts, the fake agent command lines, `strings`).
L: a real harness is launched under the owner's login with no model turn.
M: real model turns, counted, on the smallest model the account offers, named in the approval.
The owner approves batch by batch; class N needs only the plan's approval.

### 4.2 The experiments

"Runs": W a worker agent; M the manager or lead; O the owner.

| ID | Setup | Real model use | Pass and fail | Decides | Runs |
|---|---|---|---|---|---|
| X1 | A 30-line Bun script: listen on a Unix socket, connect from a child process, try to read the peer process id (Bun socket fields, `node:net` handle, `bun:ffi` `getsockopt` with `LOCAL_PEERPID`) on macOS; the same on Linux in the continuous-integration container | N | Pass: the listener prints the child's process id by a route that works in the compiled binary. Fail: no route without writing the listener in foreign code | Whether attribution can be `harness_env_ancestry` or only `harness_env` (C1, T6); whether Q7 can be answered as recommended | W |
| X2 | Test hub and a fake `claude` session; from a plain process holding only the scratch capability key, send `user_input`, an `answer` to a held permission card, and `create_session_request` | N | Records which are accepted today. This is a characterization, not a pass or fail | The baseline for the device-key rule (C1); whether to file the existing exposure as its own issue (I-9) | W |
| X3 | Test session daemon with a fake `claude`: register a non-harness card in the session registry while a permission hold stands, then a `Stop`, a new prompt, a `SessionEnd`; read the web composite key and the `pendingQuestions` census | N | Pass: a route exists where the extra card survives a sweep, does not displace or get displaced by the permission card, does not set `promptUp`, and resolves once through `createQuestionResolver` | Where peer cards are registered (C2); whether a new `QuestionSource` is needed | W |
| X4 | Bun script: 1,000 appends of 8 KiB to a JSON-lines file with `fsync`, against 1,000 atomic rewrites with `writeRestrictedJson` | N | Pass: append path under 5 ms median per message on S1 and the internal disk | Store format (C7) | W |
| X5 | `strings` over the five installed Claude Code builds for the socket wire, flag and gate text | N | Records differences between builds | Stability of the channel (K1); input to section 3 | W |
| E1 | Test hub; one Remi-hosted Claude session in a scratch repository, launched with `--messaging-socket-path <exp dir>/run/a.sock`; read `/status` from the session screen; fallback run with a `SessionStart` command hook that writes the exported socket path to a file | L | Pass: the socket file exists at the given path and `/status` shows it. Partial: only the hook route works. Fail: no socket (gate off) | Whether a structured Claude inbound exists; section 3 | W, after owner go |
| E2 | Two processes: the E1 session (prompting mode) and a script that writes one JSON line with the envelope to its socket, idle and then mid-turn | M: 3 turns ("reply with the word received and the sender you see") | Pass: delivered both times; the transcript entry contains the marker; the sender text the model reports is recorded. Fail: dropped, held, or no marker in any user-role entry | The wire, `seen` evidence, the envelope wording | W, after owner go |
| E3 | As E2, with a held permission dialog open (a tool call the fake policy holds) | M: 2 turns | Pass: the message is not consumed by the dialog and arrives after it. Fail: any interaction with the dialog | Rule 3 of spec 5.2; section 3 | W |
| E4 | As E2, receiver launched in bypass mode in the scratch repository only, in hub mode with no terminal attached and then with `remi attach` | M: 2 turns | Records: what the screen tracker makes of the vendor's hold dialog (it must not become a typed card), what happens at five minutes, what Remi can observe | `held_by_harness`, `unconfirmed` (C8), the bypass-receiver path (C20) | W |
| E5 | A Claude session's `SendMessage` to a `uds:` address of a listener the script owns | M: 2 turns | Records the wire, if any | P6 only | W, optional |
| E6 | E1's session launched with `--mcp-config` naming a stub stdio server that logs its environment variable names and calls | M: 3 turns | Pass: no approval dialog at start, the tool is callable, the call prompts like any tool, the server sees the session's environment. Fail: a dialog nobody can answer in hub mode | Outbound for Claude (Q19) | W |
| E7 | A Remi-hosted Codex session in a scratch repository with `-c mcp_servers.<name>...` on the launch | M: 3 turns | Records: loaded or not, where the server runs, whether a call carries the thread id | Whether Codex gets an initiating tool (Q16) | W |
| E8 | A second app-server client: read the generated schema; `thread/resume` on a scratch thread with `dynamicTools` | L | Pass: the tool is registered on a thread the client did not start | Same as E7 | W |
| E9 | Remi's client sends `turn/start` with the envelope on an idle scratch thread while the terminal is attached | M: 3 turns | Pass: the terminal shows it, the turn runs, a user item contains the marker and the client message id | Codex delivery and `seen` | W |
| E10 | `thread/queue/add` on the same thread during a turn | M: 2 turns | Records visibility and auto-start | Optional second Codex path | W |
| E11 | E1's session; Remi's hook server answers one `Stop` with a block and a body-free reason | M: 3 turns | Pass: exactly one continuation, no second block (`stop_hook_active`), the turn-complete push fires once, a held prompt is unaffected | The nudge (spec 5.2 rule 6) | W |
| E12 | From a sandboxed Claude shell command and a Codex `workspace-write` command in the scratch sessions: connect to a Unix socket under the scratch `run/`; test whether `~/.remi/capability.key` is readable (result only) | M: 2 Claude turns, 1 Codex turn | Records reachability per sandbox | The command-line fallback; C1's real reach | W |
| E13 | E1's session: type the full multi-line envelope through the guarded input path when idle, then mid-turn | M: 3 turns | Pass: one submission, one user entry with the marker, `UserPromptSubmit` carries it; mid-turn behavior recorded | Section 3; Q15 | W |
| E14 | Read `permission_mode` on the hook events of E2 and E4; read a scratch Codex thread's approval policy and sandbox from the app-server | M: 0 extra Claude turns, 1 Codex turn | Pass: posture known for both; an unknown value is recorded as such | Holds for no-prompt receivers (T2) | W |
| E15 | A real `opencode serve` | M | Parked with P5 | P5 | later |
| E16 | In the scratch Codex session the owner types one shell command (`env` names only) in the terminal, or E7's stub logs variable names | L or M: 1 turn | Pass: `CODEX_THREAD_ID` is present | Codex outbound attribution | O or W |
| E17 | Preferred: with the owner's approval, a script scans existing transcripts for the wrapper prefix and prints only key names, the `from` attribute's shape and counts, never text. Live variant: two scratch Claude sessions, one `SendMessage` | N with approval, or M: 2 turns | Pass: a rule separates a cross-session message from a subagent report | P1C goes or is dropped (C13) | W, after owner go |

### 4.3 Batches, cost and order

| Batch | Experiments | Class | Cost and account | Approval | Time |
|---|---|---|---|---|---|
| B0 | X1 to X5, E17 (scan variant) | N | None; E17's scan reads the owner's transcripts for structure only | With the plan; E17 scan named separately | 1 day |
| B1 | E1, E8, E16 | L | Launches under the owner's default Claude Code and Codex logins on this Mac; no model turn; the launch itself contacts the vendor | Owner go | 0.5 day |
| B2 | E2, E3, E4, E6, E11, E12 (Claude), E13, E14 (Claude) | M | At most 45 turns in total (21 planned, the rest for reruns), each a one-line reply, on the smallest Claude model; the owner's subscription login; counted against its usage window, no key billing | Owner go, with the model named | 1.5 days |
| B3 | E7, E9, E10, E12 (Codex), E14 (Codex) | M | At most 25 turns (11 planned), smallest Codex model; the owner's default Codex login | Owner go | 1 day |
| B4 | E5, E15 | M | Optional or parked | Later | - |

B0 results can end the program early: if X1 fails and the owner does not accept `harness_env` attribution, P2 stops until a design exists.
B2 runs only if E1 passed or partly passed; E13 and E11 run in B2 either way.

## 5. Phases

Standard gates on every code step ("G-std"), run by the worker and again after merge: `bunx biome check .`; `bun run typecheck`; `bun run typecheck:web`; `bun run typecheck:web-tests`; `bun run typecheck:signaling`; `bun scripts/third-party-notices.ts --check`; `typos`; the step's named tests under the canonical environment of section 4.1; `bun test packages/daemon/tests/harness/harness-boundary.test.ts packages/daemon/tests/license-boundary.test.ts packages/daemon/tests/pty-child-env-secrets.test.ts`; the hosted full suite green on the pull request's final head.
One more on every step from P1A on ("G-off"): with `[peer] enabled = false`, the recorded launch arguments of the fake `claude` and fake `codex` are identical to those on `develop`, no socket exists under the scratch `run/`, and `hello_ack.capabilities` lacks `peer_messages`.

Tiers: lead (Opus, cards, ADR, checkpoints), worker-hard (authority, delivery, policy), worker (web, docs, class N experiments).
Review lenses: `contract` (wire, fixtures, capability), `verification` (tests prove the gate, no mock replaces logic), `maintainability`, `security` (authority, attribution, injection, the capability key), `privacy` (a body, title, name or id reaching a log, push, Telegram or relay frame).

### 5.1 Overview

| Step | Goal | Tier | Depends | Timebox |
|---|---|---|---|---|
| P0A | Experiment batches B0 to B3 and their notes | worker | owner go per batch | 4 days |
| P0B | ADR 0052 draft, amendments, issues filed | lead | B0; revised after B2, B3 | 2 days |
| CP0 | Owner approves the ADR, answers the questions of section 12 marked CP0 | owner | P0A, P0B | - |
| P1A | Shared types, hub store, hub-to-session link, `live-sessions` field | worker-hard | CP0; profiles P1B merged | 2.5 days |
| P1B | `peer_messages` capability, read frames, `remi peer ls`, `show`, `log` | worker-hard | P1A; profiles P2B merged | 2 days |
| P1C | Observation of native Claude messages (conditional) | worker-hard | P1B; E1 and E17 pass | 1.5 days |
| P1D | Web Switchboard and conversation view, read-only; peer items in chat | worker | P1B | 2 days |
| CP1 | Owner looks at the read-only view; lead completes the P2 cards | owner, lead | P1D | - |
| P2A | Agent endpoint, tool server, `remi peer send`; sends are stored and wait | worker-hard | CP1 | 2.5 days |
| P2B | Policy: links, holds, budgets, breaker, mute, pause, kill switch, cards, device-key rule | worker-hard | P2A | 3 days |
| P2C | Claude delivery through the socket; hand record; `seen`; `unconfirmed` | worker-hard | P2B | 3 days |
| P2D | Web cards and controls, interject | worker | P2B | 2 days |
| P2E | `Stop` nudge and inbox reminder (only if E11 passes) | worker | P2C | 1 day |
| OG-P2 | Owner: two real Claude sessions, one conversation, one stop | owner | P2C, P2D | - |
| CP2 | Owner go for Codex; lead completes the P3 cards | owner, lead | OG-P2 | - |
| P3A | Codex delivery through the writer's idle branch under board authority | worker-hard | CP2 | 2 days |
| P3B | Hub-observed reply, counted as an agent message | worker-hard | P3A | 1.5 days |
| P3C | Codex initiating tool (only if E7, E8 or E16 gives a thread-attributed path) | worker-hard | P3B | 2 days |
| OG-P3 | Owner: a Claude session and a Codex session converse | owner | P3B | - |
| CP3 | Owner go for spawn; lead completes the P4 cards | owner, lead | OG-P3 | - |
| P4A | `remi_spawn`, hub spawn path, lineage, limits, card | worker-hard | CP3; profiles P2B | 3 days |
| P4B | Task delivery at readiness, web spawn card, `peer.spawnedBy` | worker | P4A | 1.5 days |
| OG-P4 | Owner: a real spawn of each harness | owner | P4B | - |
| N1 | Native: read-only Switchboard, generic peer cards, peer bubbles | worker-hard | P2D; no profiles app slice running | 2.5 days |
| N2 | Native: controls, interject, stop all | worker-hard | N1 | 2.5 days |
| DOCS | One guide page per phase in `yooz-docs`, draft until release | worker | each phase | 0.5 day each |
| P5 | OpenCode | parked | an OpenCode adapter epic; E15 | - |
| P6 | Groups, cross-machine, native-board bridges, `SendMessage` to Remi | parked | own ADRs; Relay R7 | - |

Order: the spec's (observe, Claude, Codex, spawn, then OpenCode) is kept.
The brief listed OpenCode before spawn; I keep spawn first because it is the second half of the owner's idea and needs only P2 and P3, while OpenCode has no adapter and is not installed.

### 5.2 Per-phase detail

**P0, experiments and decision record.**
Scope: this directory only (notes, the ADR draft); no product code.
Gate: one note per batch with every criterion of section 4.2 marked run and pass, partial or fail; `typos` clean; ADR 0052 draft covers every row of section 7.1.
Owner checkpoint: CP0.
Collisions: none.

**P1, store, link and read-only visibility.**

| Field | Content |
|---|---|
| Goal | The person can see conversations and their messages; nothing is delivered, typed or handed by any path |
| Scope | `packages/shared/src/peer.ts` (types, codecs, limits); `packages/daemon/src/peer/` (store, hub service, link server and client, both Apache-2.0, importing only `harness/types.ts` and `session/`); `session-registry-file.ts` (`peer` field); `cli/capabilities.ts`, `shared/src/protocol-version.ts`, `protocol.ts` (read frames); `cli/arg-parser.ts` (`peer` subcommand); `packages/web/src/components/peer/`; P1C only: an observation callback from `transcript/` passed in by `cli.ts`, never an import from `peer/` |
| Protocol | Capability `peer_messages` (hub only, "see agent conversations"; the text is widened to "and steer" in P2B); client messages `peer_conversations_request` and `_response`, `peer_history_request` and `_response`, `peer_event`; each with a golden fixture; a `hello_ack` fixture with and without the capability. No `PROTOCOL_VERSION` change. Web `App.tsx`, the attach client and the relay adapter each declare the new keys (ADR 0013) |
| Gate (literal) | `bun test packages/shared/tests/peer.test.ts packages/daemon/tests/peer packages/daemon/tests/integration/peer-read.test.ts` passes; in the integration test a real test hub and two session daemons with fake `claude` show: a conversation written through the link appears in `peer_history_response` within 2 s; a `peer_history_request` to a session daemon, and any link line sent over the WebSocket, are refused; a write counter on both fake terminals reads zero; `grep` of every log file and every recorded push payload for the test bodies finds nothing; store directory mode is 0700 and files 0600; G-std; G-off. P1C adds: recorded transcript fixtures (shapes from E17) yield one harness-native item per cross-session message and none per subagent report. P1D adds: `bun test packages/web` and a Playwright run (`bun run test:e2e`) showing the conversation with sender, recipient, time, state chip and the "harness-native: not routed through Remi" label |
| Tests | Real hub and session daemons from `hub-test-utils.ts`; fake agent command lines; real files in a scratch `REMI_HOME`; no mock of the store, the link or the policy |
| Lenses | P1A, P1B, P1C: contract, verification, maintainability, security, privacy. P1D: contract, verification, maintainability |
| Collisions | `protocol.ts`, `protocol-version.ts`, `capabilities.ts` and the fixture generator with profiles P2B, P2C: strictly after each merges, fixtures regenerated. `cli.ts` with every profiles daemon step: one at a time. `harness-boundary.test.ts` gains a `peer/` rule in P1A |
| Owner | CP1: looks at the web view on a test hub; answers Q5 finally if E17 changed it |
| Docs | A guide page "Agent conversations: what you can see", draft |

**P2, Claude to Claude through Remi.**

| Field | Content |
|---|---|
| Goal | An agent sends with a Remi tool; the person approves the pair once; Remi delivers through Claude's socket under budgets; the person can stop everything |
| Scope | P2A: `packages/daemon/src/peer/agent-endpoint.ts`, `remi peer-mcp` and `remi peer send`, `peers`, `inbox`, `status` (one client library), launch flags in `harness/claude-session.ts` and `cli/claude-binding.ts` only when the board is on, `REMI_PEER_SOCKET` in the child environment (not secret-named). P2B: `peer/policy.ts` (links, budgets, rates, breaker, wake budget, mute, pause, kill switch file `~/.remi/peer/off`), card raising in the session daemon through a neutral `PeerCards` interface, `peer_control_request` and `_result`, the device-key rule in the answer and control handlers. P2C: `HarnessSession.peer` on `harness/types.ts`, the socket writer in `harness/claude*`, hand records, marker matching through a callback, the `peer` object on chat items. P2D: web cards, controls, interject (`peer_interject_request`). P2E: the nudge |
| Protocol | `peer_control_request` and `_result`, `peer_interject_request` and `_result`; card kinds `peer_link`, `peer_message`, `peer_budget`, `peer_tripped` on `question` (the TypeScript union widened, ADR 0038 amended); optional `peer` object on chat items and on session-list entries (`addressable`); capability text updated; fixtures for each, and one `peer_event` per delivery state including `unconfirmed` |
| Gate (literal) | `bun test packages/daemon/tests/peer packages/daemon/tests/integration/peer-claude.test.ts` passes, and in it, against a fake `claude` that serves a real Unix socket and records every line and every terminal byte: (1) A's tool call `remi_send` to B raises one `peer_link` card on B's daemon; (2) an `answer` to that card from a capability-only connection is refused and the link stays unset; from a signed test device it is accepted; (3) after Allow, B's socket receives exactly one line whose content is the envelope, within 5 s of B being idle, and the state reaches `seen` only when the fixture transcript gains a user entry with the marker; (4) with a held permission hook on B, zero lines are written until the hold ends; (5) the 21st agent message is refused `budget` and a `peer_budget` card appears; the 11th message inside 2 minutes trips the breaker; an identical body inside 10 minutes is refused `duplicate`; (6) after stop all, a send is refused `board_off` and zero lines are written, measured within 1 s; with the hub process killed, zero lines are written; (7) a kill of the session daemon between the hand record and the write yields `uncertain` and no second line after restart; (8) a hand with no marker for 10 minutes (clock injected) becomes `unconfirmed`; (9) a body with a line starting `[Remi ` is refused; a body matching the credential check is refused and absent from the store; (10) terminal byte counter zero throughout; (11) no body in any log, push payload or Telegram text; G-std; G-off |
| Tests | Real daemons and hub; the fake `claude` gains a socket server and hook client (it replaces the vendor program, not Remi's logic); a signed test device from the existing structured-chat tests; injected clock for timers only |
| Lenses | All five on P2A, P2B, P2C; contract, verification, maintainability on P2D, P2E |
| Collisions | The Claude launch path with profiles P1B (must merge first) and P2A; `question` fixtures with any decision-object work; `packages/web/src/components/chat/` with profiles P2D |
| Owner | CP1 before; OG-P2 after: on a test hub in a scratch repository with two real Claude sessions (model use approved as class M, at most 20 turns), one conversation reaches `seen` in both directions, one budget card, one stop all; CP2 |
| Docs | Guide "Agent conversations: sending, approving, limits", with the exact wording of section 6.2 of the spec for what Remi says about a sender |

**P3, Codex.**

| Field | Content |
|---|---|
| Goal | A Claude session and a Codex session converse; Codex answers through the turn Remi started |
| Scope | `harness/codex/` (`peer` member using `CodexTextWriter`'s idle branch under a board authority; no steer, no override fields); `peer/` reply observation through `codex-turns`; posture from the app-server for holds; P3C only if an experiment allows |
| Protocol | Message kind `reply_observed`, attribution `hub_observed`; no new client message |
| Gate (literal) | `bun test packages/daemon/tests/peer packages/daemon/tests/integration/peer-codex.test.ts packages/daemon/tests/harness/codex` passes, and against `fake-app-server.ts`: delivery waits while the thread is active or has a pending request, then exactly one `turn/start` carries the envelope and no `approvalPolicy`, `sandboxPolicy`, `model` or `cwd` field; zero `turn/steer`; `seen` on a user item with the marker; the turn's final answer reaches the sender as `reply_observed` and increments the conversation counter and the wake counter; a full-access thread's message is `held` until the person delivers; bytes written to the fake `codex` terminal read zero; every existing `structured_chat` test passes unchanged; G-std; G-off |
| Lenses | All five |
| Collisions | `harness/codex/` with any Codex track work (#1192, #1187); `CODEX_MAY_IMPORT` gains nothing |
| Owner | OG-P3 (class M, at most 15 Claude and 15 Codex turns on a test hub); CP3 |
| Docs | Guide section "Codex sessions" |

**P4, interactive spawn.**

| Field | Content |
|---|---|
| Goal | An agent asks Remi for an interactive peer instead of a one-shot call; the person starts it from the app |
| Scope | `remi_spawn` in the tool server and endpoint; `peer/spawn.ts` on the hub (limits, lineage in the store, never `sessions.json`); `startSession` called with allowlisted arguments only; `peer_spawn` card on the spawner's daemon; `peer.spawnedBy` on the child's session-list entry; web card |
| Protocol | Card kind `peer_spawn`; optional `peer.spawnedBy`; no change to `create_session_request` |
| Gate (literal) | `bun test packages/daemon/tests/peer packages/daemon/tests/integration/peer-spawn.test.ts` passes, and in it: the tool returns `pending_approval` at once; the card carries harness, directory, profile, posture line, model and the first 300 characters with the hidden count; an answer from a capability-only connection starts nothing; on "Start read-only" the fake `codex` argv contains `-s read-only` and none of `--dangerously`, `-c`, a prompt or a settings flag; the task arrives as message 1 only after the thread is bound and idle; the fourth live child of one root is refused `spawn_limit`, a depth-3 request is refused, a second request inside a minute is refused; Deny and a 30-minute expiry (clock injected) start nothing and send one notice; G-std; G-off |
| Lenses | All five |
| Collisions | `create-session-events.ts` and the hub create path with profiles P2B (must merge first; the child takes the spawner's profile) |
| Owner | CP3 before (Q10, Q11, Q23, Q24, Q26); OG-P4 after |
| Docs | Guide section "Starting a peer session" |

**N1 and N2, native apps (outline).**
Scope: `packages/native/RemiKit` (decoding, `hubSupport` for `peer_messages`), Mac column, iPhone and iPad screen, cards.
Gate, completed at CP2 by the lead: `FixtureConformanceTests` decode every new fixture; a peer card of unknown kind renders as a generic card; a simulator run on a fixture hub above 18790 with the owner's announced consent.
Collisions: the Xcode lock and the one simulator; never beside a profiles app slice.

### 5.3 The two new local links (what the P1A and P2A cards will fix)

Neither exists today (V1, V2), so they are the plan's largest new surface and are specified before anything else.

| Property | Hub-to-session link (P1A) | Agent endpoint (P2A) |
|---|---|---|
| Who listens | The session daemon, on `~/.remi/run/peer-<sessionId>.sock` (directory 0700, socket 0600), only when the board is on | The same daemon, on a second socket, `agent-<sessionId>.sock`, path given to the harness as `REMI_PEER_SOCKET` |
| Who connects | The hub, after reading `peer: {v, socket}` from the session's `live-sessions` entry | The tool server (`remi peer-mcp`) or `remi peer`, started by the harness |
| Caller check | The connecting process id equals the hub's recorded process id (if X1 passes; otherwise the link is stated as same-user only) | The caller descends from the session's harness process (if X1 passes); for Codex also the thread id |
| Codec | JSON lines, `v: 1`; `deliver`, `delivery_update`, `observed`, `raise_card`, `card_answer`, `forward_send`, `forward_spawn`, `posture` | JSON lines, `v: 1`; `peers`, `send`, `inbox`, `status`, `spawn` |
| Never | Reachable over the WebSocket or the relay; named in `ProtocolMessageMap` | Able to name a sender, answer a card, or send a control |
| Failure | A closed link after a `deliver` was sent and before its update is `uncertain` | A refused connection returns a one-line remedy to the agent |
| Fixtures | One per line type, under `packages/shared/tests/fixtures/peer-link/` | One per operation and refusal code |

Flow of one message, as the gates measure it: tool call, endpoint stamps the sender, `forward_send` to the hub, the hub stores it (`accepted`), applies policy (`held`, `queued` or `refused`), has the recipient's daemon raise a card if a person is needed, records `handing`, sends `deliver`, the daemon checks binding and `promptUp` and writes once, reports `handed`, later reports the marker (`seen`); the hub pushes `peer_event` to the apps at each change.

### 5.4 Checkpoints and owner gates

| ID | Trigger | The lead produces | The owner does |
|---|---|---|---|
| CP0 | B0 and B1 notes and the ADR draft exist | Dispositions of the pack review; ADR 0052 revised to the results; the P1 cards | Approves the plan and ADR; answers the CP0 questions; approves B2 |
| B2, B3 go | The previous batch's note | The next batch card | Names the model; confirms no other session of theirs is live |
| CP1 | P1D merged | The P2 cards, with section 3 settled from B2 | Looks at the read-only view; answers Q4, Q8, Q14, Q25 |
| OG-P2 | P2C and P2D merged | The procedure, on a test hub in a scratch repository | Runs or watches two real Claude sessions converse, taps one budget card, presses stop all; records the result |
| CP2 | OG-P2 recorded | The P3 and N1 cards | Go for Codex; answers Q13, Q16 |
| OG-P3 | P3B merged | The procedure | A Claude and a Codex session converse, one held message delivered, one bounded unattended grant expires |
| CP3 | OG-P3 recorded | The P4 and N2 cards | Go for spawn; answers Q10, Q11, Q23, Q24, Q26 |
| OG-P4 | P4B merged | The procedure | One real spawn of each harness, one Deny |

No step after a checkpoint is dispatched before the owner's go is recorded; silence is never an answer.

## 6. Test approach (all phases)

- No mock replaces Remi's logic: the store, policy, link, endpoint, envelope, card raising and adapters run as shipped, inside real hub and session-daemon processes.
- What is replaced is the vendor program only: the fake `claude` (extended with a socket server, hook client and transcript writer) and `fake-app-server.ts`; their behavior is taken from the experiment notes, and each fake behavior cites the experiment that observed it.
- Counters are the proof for negative claims: terminal bytes written, socket lines written, `turn/start` and `turn/steer` calls.
- Time is injected for deadlines only (expiry, `unconfirmed`, rate windows).
- Every live claim (a real harness received a message) is an owner gate or an approved class M run, recorded as run by whom; never inferred from a fake.

## 7. Decision records and issues

### 7.1 ADR 0052, "Agent conversations through Remi" (outline)

| Section | Content |
|---|---|
| Context | The owner's idea (#1801); what each harness offers; the three research reports; the experiment results with their run status |
| D1 Placement | Hub store and policy, session daemons deliver, hub required; append-only store, single writer; no session-side queue |
| D2 Carriage, not judgment | Remi decides only whether Remi carries a message, by fixed metadata rules; ADR 0030 and 0031 stand (C19) |
| D3 Transports | Per harness, in order; what is never done (typing into Codex, `turn/steer` for agents, `crossSessionInbound`, overrides); the typed fallback's status after E13 |
| D4 Envelope and provenance | Remi-written envelope; marker; bubbles from the record, never from text; refused body lines |
| D5 Attribution | What X1 allows; the words Remi may and may not use (spec 6.2) |
| D6 Human authority | Device key for approvals and loosening; anything may tighten; what a same-user process can still do, stated |
| D7 Policy | Links, bounded unattended grant, budgets, rates, breaker, wake budget, kill switch, defaults |
| D8 Delivery states | The table with `unconfirmed`; at most once into a harness; what "delivered" may claim |
| D9 Cards | Raised by session daemons; kinds; in-app only |
| D10 Spawn | Card, posture default, placement, profile, limits, lineage |
| D11 Wire | Capability, client messages, the separate link codec, older clients and daemons |
| D12 Data | Retention, no bodies in logs, push, Telegram; the credential refusal; D10 of ADR 0049 |
| Not decided | Groups, cross-machine, bridges, OpenCode |
| Evidence | The verification tables of the spec and of this plan; every unrun claim marked |

### 7.2 Amendments

| ADR | Amendment | When |
|---|---|---|
| 0038 | New kinds `peer_link`, `peer_message`, `peer_spawn`, `peer_budget`, `peer_tripped` (item 7 said "no new kinds"); `answerPath: structured` also covers an answer Remi's own policy takes as data; `resolvedBy` for these cards is `phone` or `timeout` only; a peer card never has a lock-screen category | With ADR 0052, before P2B |
| 0035 | None to the decision; the registry gains `peer_messages`; a note that an internal link is advertised in `live-sessions`, not as a capability | P1B |
| 0013 | None, because internal frames stay out of the registry (C3); ADR 0052 D11 records why | - |
| 0043 | Board authority on the Codex writer's idle branch (C12) | Before P3A |
| 0032 | The optional `HarnessSession.peer` member; the `peer/` rule in the boundary test | P1A, P2C |
| 0030 | One paragraph pointing to ADR 0052 D2 | With ADR 0052 |
| 0036 | Only if Q24 allows agent-requested worktrees | P4 or later |

### 7.3 Issues to file after approval (titles and one-paragraph bodies; "Part of #1801" in each)

| # | Title | Body sketch |
|---|---|---|
| I-1 | Message board: experiment program before any build | The batches of section 4, the safety rules, the approval classes, the note each batch produces, and that no phase past P0 starts before its experiments are recorded as run |
| I-2 | ADR 0052: agent conversations through Remi | The outline of 7.1, the amendments of 7.2, the owner questions it settles, and that it is accepted before P2 |
| I-3 | Board phase 1: store, hub-to-session link and read-only view | P1A to P1D with the literal gate, the conditional observation step, the capability and fixtures |
| I-4 | Board phase 2: Claude sessions message each other through Remi | P2A to P2E with the gate, the device-key rule, the kill switch, and OG-P2 |
| I-5 | Board phase 3: Codex joins conversations | P3A to P3C with the gate, the writer's idle branch, the observed reply, and OG-P3 |
| I-6 | Board phase 4: an agent asks for an interactive peer session | P4A, P4B with the gate, posture default, placement, limits |
| I-7 | Board in the native apps | N1, N2 as outlines, the decoder check for the `peer` chat object |
| I-8 | Board documentation in yooz-docs | One guide, grown per phase, draft until the release that ships the phase |
| I-9 | A capability-only connection can answer cards (filed only if X2 shows it) | What X2 ran and saw, which messages were accepted, that it predates the board, and the question of whether card answers in general should require a device key; separate from the board so it is not lost |
| I-10 | OpenCode in conversations (parked) | Blocked on the adapter; E15 |

## 8. Threat model to test matrix

Each control is proved by an automated test in the named step, an experiment, or an owner gate; a control with no row here is not claimed.

| Control (spec section 6) | Attack it answers (research C) | Proof | Where |
|---|---|---|---|
| Provenance envelope written by Remi; sender never read from the body | Self-claimed identity (claude-peers `from_id`), Prompt Infection tagging | Test: the sender in the stored message and the envelope equals the endpoint's session whatever the tool input says; a body with marker or `[Remi ` lines is refused. Live: E2 records what the model reports as the sender | P2A, P2C; E2 |
| Attribution by socket and process ancestry | One session's agent speaking as another | Test: a connection from a process outside the session's harness tree is refused (only if X1 passes; otherwise the residual is written into the guide and ADR) | P2A; X1 |
| Human link approval per pair | Injection spreading without a human | Test: no line is written before an Allow; Deny refuses later sends | P2B gate items 1, 3 |
| Approvals need a device key | An injected agent approving its own link through the capability key | Test: gate item 2 for cards and for each loosening control; X2 baseline; E12 real reach | P2B; X2, E12 |
| Hold for a receiver that will not ask anyone | Confused deputy | Test: a bypass-mode fake `claude` (`permission_mode`) and a full-access fake thread get `held` per message; unknown posture counts as no-prompt; the bounded unattended grant expires at 20 messages or 60 minutes | P2B, P3A; E14, E4 |
| Nothing handed while a prompt is up | A message answering or confirming a prompt | Test: gate item 4 (Claude), pending-request case (Codex); E3 live | P2C, P3A; E3 |
| A peer message cannot answer a card | Approval by message | Test: the peer path has no import of, and no call into, the answer handler or decision channel (boundary test rule) | P1A, P2C |
| Budgets, pair rate, duplicate drop, wake budget | Loops and cost | Test: gate item 5; `reply_observed` counted | P2B, P3B |
| Circuit breaker | Fast loops | Test: 11th message in 2 minutes trips; card raised; nothing more handed | P2B |
| Kill switch | Any runaway | Test: gate item 6, including hub death; owner gate presses it on a real conversation | P2B; OG-P2 |
| Spawn limits and card | Fan-out, posture escalation | Test: P4 gate (limits, argv, read-only default, capability-only answer refused) | P4A |
| No secrets: bodies never in logs, push, Telegram | Exfiltration through Remi's own channels | Test: `grep` of logs and recorded payloads for planted bodies in every integration test | P1 to P4 |
| Credential-looking body refused, not stored | Obvious mistakes; D10 | Test: gate item 9; the guide says it is not protection | P2B |
| Redaction of names and titles | Injection through a branch name (T12) | Test: a session named with control, bidirectional and bracket characters appears escaped and cut to 80 in `remi_peers`, the envelope and the card | P2A, P2B |
| Binding pinned and checked at the write | Wrong-session delivery (#538) | Test: a rotated binding stops delivery with `binding_changed` | P2C, P3A |
| At most once into a harness | Duplicate actions after a crash | Test: gate item 7 | P2C |
| Honest states | A doc or screen overstating delivery (ADR 0011) | Test: one fixture per state; `seen` only with evidence in a user-role entry; `unconfirmed` after 10 minutes | P2C |
| Static tool descriptions | Tool poisoning | Test: the tool list is byte-identical across sessions with hostile names | P2A |

## 9. Cost, capacity and pace

| Item | Estimate |
|---|---|
| Implementation steps | 17 dispatchable (P1A to P4B, N1, N2, P2E and P3C conditional), plus 4 experiment batches and about 5 docs steps |
| Agent dispatches | About 8 per code step (1 implementer, 4 or 5 reviewers, 1 delta reviewer, 1 fix round, 1 verification): about 140; experiments and docs about 25; lead wakes about 10; total about 175 |
| Model turns on the owner's accounts | Experiments at most 45 Claude and 25 Codex; owner gates at most 35 Claude and 15 Codex; all short, on the smallest model |
| Calendar | P0 one week after approval; P1 one and a half weeks; P2 three weeks; P3 one and a half; P4 one and a half; native two weeks beside P3 and P4: nine to ten weeks if the owner answers each checkpoint within a day |
| What bounds the pace | The profiles epic on the same daemon lane and protocol files (P1A cannot start before profiles P1B merges, P1B before profiles P2B); the 61-minute relay soak on each daemon pull request; five lenses on security steps; one Xcode lock and one simulator |
| Slots | One worker-hard daemon step at a time for the whole plan (shared `cli.ts`, `peer/`, protocol files); web and docs beside it; no wave |
| Recommendation | Run P0 now, beside the profiles epic (it touches no product file); start P1A only after profiles CP1 |

## 10. Risks (pre-registered)

| # | Risk | Read by | If bad | Decides |
|---|---|---|---|---|
| R1 | Bun cannot report a socket peer (X1) | End of B0 | Attribution is `harness_env` only; the owner accepts the stated residual or P2 waits for a native helper design | Owner |
| R2 | Claude's socket is absent, gated or refuses Remi (E1, E2) | End of B2 | Section 3's table: pull plus nudge, and Q15 reopened | Owner |
| R3 | A bypass-mode receiver cannot be served in hub mode (E4) | End of B2 | Such receivers get the pull path only; the guide says so | Lead |
| R4 | Peer cards cannot coexist with harness cards in the session registry (X3) | End of B0 | A separate card list on the session daemon and a wire change; P2B grows by about 2 days | Lead |
| R5 | The profiles epic and this one conflict in the launch path | Each checkpoint | Serial order holds; this plan waits | Lead |
| R6 | A vendor release changes the socket wire or flag | Each Claude Code update (X5 rerun) | The adapter is switched off by version; pull path stays | Lead |
| R7 | Cost: every delivery to an idle session is a turn | OG-P2 | Lower the wake budget default; owner sets it | Owner |
| R8 | The device-key rule blocks the owner's own use (loopback web without a key) | P2D | Check the web client's key on loopback in the P2B card; if absent, a local terminal confirmation path is designed, stated as cooperative-grade | Lead, owner |
| R9 | The store holds private text for 7 days | CP1 | Shorten retention or make bodies memory-only (Q9) | Owner |
| R10 | A native board ships in a harness mid-build | Each checkpoint (`codex features list`, release notes) | Section 13 | Owner |

## 11. Rollback and kill switch

| Layer | What it does | Who can use it |
|---|---|---|
| Stop all (apps, Telegram, `remi peer off`) | Writes `~/.remi/peer/off`; the hub refuses sends and instructs no hand within 1 s; queued messages wait until their time to live | Anyone authenticated (tightening) |
| Hub stopped | Nothing is handed anywhere, because no session daemon holds a queue (C7) | The person at the machine |
| Pause or close a conversation; mute a session | Scoped stops | Anyone authenticated |
| `[peer] enabled = false` (the default) | No launch flag, no socket, no capability, no tool server for sessions started afterward; G-off proves it on every step. A running session keeps its tool server until it ends, but every send is refused | The person at the machine |
| Start all, resume, unmute, extend | Loosening | A signed device only |
| Release level | Each step is one merge commit, reverted with `git revert -m 1`; a client hides every screen when `peer_messages` is absent; the store directory can be deleted with the hub stopped and is rebuilt empty | Manager, owner |
| Not covered | Harness-native traffic (Claude's own `SendMessage`); the screens say so | - |

A release ships a phase only when its owner gate passed; P1 may ship alone (it delivers nothing), P2 never without P2B's device-key rule and kill switch.

## 12. Decision table for the owner

"When": CP0 means with the plan and ADR 0052; a blank "blocks" means the default is safe to build on.

| Q | Question (spec 10.2) | My recommendation | Blocks | When |
|---|---|---|---|---|
| Q1 | Name: Switchboard, conversation, peer message; wire prefix `peer_` | Yes | P1D, N1 | CP0 |
| Q2 | Off per machine until turned on | Yes | P1A | CP0 |
| Q3 | A running hub is required | Yes | P1A | CP0 |
| Q4 | Link default `ask`; a project may choose `open` | `ask` only in P2; `open` deferred until use shows the need | P2B | CP1 |
| Q5 | Show Claude's native cross-session messages | Yes, only if E17 can tell them from subagent reports; otherwise not shown and said so | P1C | CP0, after B0 |
| Q6 | Never launch Claude with a `crossSessionInbound` value | Yes, never | P2C | CP0 |
| Q7 | Attribution without secrets | Yes if X1 passes; if it fails, decide between the stated residual and waiting | P2A | CP0, after B0 |
| Q8 | Budgets as listed | Yes, with the wake budget at 6 per hour to start, raised after OG-P2 | P2B | CP1 |
| Q9 | Retention 7 days bodies, 30 days metadata, 64 MiB | 3 days for bodies to start; the rest as listed | P1A | CP0 |
| Q10 | Every spawn needs a card in the app | Yes | P4A | CP3 |
| Q11 | Spawn limits as listed | Yes | P4A | CP3 |
| Q12 | Spawn before OpenCode | Yes | - | CP0 |
| Q13 | Codex receives agent messages only when idle | Yes | P3A | CP2 |
| Q14 | Telegram: metadata and stop all only | Yes | P2B | CP1 |
| Q15 | Claude typed fallback off by default, built only if the socket is unavailable | Yes, and decided on E13's evidence as section 3 says; if E1 or E2 fails the question returns to you with the two options | P2C | After B2 |
| Q16 | Codex replies by observed turn answers | Yes, counted as agent messages (C14) | P3B | CP2 |
| Q17 | Two agents plus the person | Yes | - | CP0 |
| Q18 | No cross-machine before Relay R7 | Yes | - | CP0 |
| Q19 | Remi adds its tool server to launch flags when the board is on | Yes, if E6 shows no dialog | P2A | After B2 |
| Q20 | ADR 0052 before P2 | Before P1 instead: P1 already adds a capability, a store and a link | P1A | CP0 |
| Q21 | Credential-looking body held | Change to refused and not stored (C4), described as a courtesy check | P2B | CP0 |
| Q22 (new) | Approvals and loosening controls need a signed device; anything may tighten | Yes | P2B | CP0 |
| Q23 (new) | An agent-spawned Codex child starts read-only unless you pick the machine default on the card | Yes | P4A | CP3 |
| Q24 (new) | Spawn placement: the spawner's directory now; agent-requested worktrees later | Yes | P4A | CP3 |
| Q25 (new) | Unattended delivery bounded to 20 messages and 60 minutes | Yes | P2B | CP1 |
| Q26 (new) | A spawned child runs under the spawner's profile | Yes | P4A | CP3 |
| Q27 (new) | Experiment batches B1 to B3: launches and model turns on your default logins, with the caps of section 4.3 | Approve B0 and B1 with the plan; B2 and B3 each after the previous note | P0A | Now |

## 13. What could make us stop or reshape

| Evidence | Consequence |
|---|---|
| No harness offers delivery without typing: E1 or E2 fails for Claude and the owner rejects typed wake | The board becomes pull-only (agents read an inbox when they next act). That is useful for spawn hand-off and for the record, weak for conversation; reshape to P1 plus spawn, drop live delivery |
| X1 fails and the owner does not accept environment-only attribution | Stop before P2A; P1 can still ship |
| X2 and E12 show an agent can reach the control plane and no device-key rule is practical on the owner's setup (R8) | Stop: the human gates would be decorative, and a board without them is the claude-peers failure research C describes |
| E3 shows a structured message can interact with an open dialog | Keep the "nothing while a prompt is up" rule as absolute; if the rule cannot be made reliable (the guard's known holes), stop Claude delivery |
| Codex ships `agent_message_board` documented and local, or Claude's messaging gains a cross-harness address | Reshape: Remi becomes the view, the controls and the bridge (P1 plus cards plus the kill switch), and stops building its own transports for that harness; the store stays the record of what Remi carried |
| A vendor forbids or breaks third-party use of its inbox socket | Same as the first row for that harness |
| OG-P2 shows the cost or the interruption rate is not worth it (the person taps more cards than they would have typed messages) | Stop after P2; keep P1 and the spawn hand-off |
| The profiles epic's later phases need the same owner attention through December | Pause after P0; nothing rots, because the experiment notes and ADR are dated |

## 14. Becoming a manager-loop plan pack (after approval)

1. The lead moves this directory to a pack branch (`chore/message-board-plan`, never `develop`), keeps `spec.md` and the research as inputs, and splits this file into `plan.md` (section 0 for the manager added: start prompt, tick, precedence, merge authority, routing), `runbook.md`, `queue.md`, `checkpoints.md` (CP0 to CP3), `risks.md` (section 10), `owner-gates.md` (OG-P2 to OG-P4 and the batch approvals), and `cards/`.
2. Cards the lead completes first, in this order: `EXP-B0` (X1 to X5 and the E17 scan), `EXP-B1`, `ADR52` (lead-written, reviewed with the docs and security lenses), the shared `DV`, `RV-panel`, `RV-delta` and `RB` cards copied from the profiles pack with the `security` lens added, then `P1A`.
   `EXP-B2` and `EXP-B3` are completed only after the previous batch's note, because their setup depends on it.
   Every other step stays an outline until the checkpoint before it: P1B to P1D at CP0, P2 at CP1, P3 and N1 at CP2, P4 and N2 at CP3.
3. Pack review before the first tick: one executability reviewer, one design and security reviewer, each fresh, every finding with a disposition in an appendix.
4. First dispatches: `EXP-B0` to a worker (no approval beyond the plan); in parallel the lead drafts `ADR52`; `EXP-B1` when the owner says go.
   Nothing touches product code until CP0 is recorded and profiles P1B has merged.
5. One loop at a time: the profiles board and this one share the manager and the Codex slots, so this board runs its P0 while the profiles loop runs, and its code steps only in the gaps the serial daemon lane allows, as the owner decides at CP0.

## 15. What I am least sure about, and what nobody has verified

- **Bun and socket peers (X1).** I found no socket code in the daemon and did not run a probe; if Bun gives no route, T6 has no control and the plan says so instead of hiding it.
- **The socket for Remi's use (E1, E2).** Every statement about the path flag comes from `strings`; the vendor page documents the socket, not a third-party writer.
- **The device-key rule in daily use (R8).** I did not trace whether the web client on loopback always has a signed key; the rule is right, its ergonomics are unchecked.
- **Card coexistence (X3).** I read the tracker's header comments, not its full logic; the claim that peer cards can use the registry directly is a design intent until X3 runs.
- **Codex with the owner's default.** Under full access every message is held or runs unattended (C10); whether a bounded grant makes cross-harness conversation pleasant is a use question no experiment answers before OG-P3.
- **Native decoding (C11).** I did not read the Swift decoders; the optional-object choice is the conservative one, to be confirmed in N1's card.
- **The calendar.** It assumes the profiles epic reaches its second checkpoint in about two weeks; I did not estimate that epic.
- Everything the spec lists in its section 10.3 remains unverified until its experiment is recorded as run.
