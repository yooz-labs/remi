# ADR 0032: Harness seam and the session identity shim

**Status:** accepted; amended by #1163 (Phase 2) and #1164 (Phase 3), below; items changed since by the Codex foundations (#1176) say so inline
**Date:** 2026-10-02
**Owner:** Yahya

## Context

remi wraps one agent CLI, Claude Code, and its protocol and persistence name Claude's session id everywhere.
At `fa611ee2`, `claudeSessionId` appears on 240 lines of `packages/*/src` across 35 files (shared 22, daemon 155, web 59, signaling 4), and `Question` on 182.
`.context/strategy-2026-10.md` sections 8 and 10 add Codex next and OpenCode later, so the daemon needs a seam where a second harness can plug in.
Epic #1161 puts that seam in with Claude as the only implementation and zero behavior change; this ADR is phase 1 (#1162): the identity vocabulary, and how persisted records tolerate it.

Two facts about the existing store decide the shape, both measured at `fa611ee2` with a scratch script over a real `SessionStore`:

- `parseStoredSession` rebuilds each record from the eight keys it knows.
  A record carrying `harness: 'codex', harnessSessionId: 'thread-1'` came out of `markExited` with exactly `claudeSessionId,exitCode,exitedAt,pid,port,projectPath,remiSessionId,startedAt`.
  Any field the parser does not copy is dropped on the next rewrite, by whichever daemon writes.
- `read()` rejects any file whose `version` is not 1 (line 512 of `packages/daemon/src/session/session-store.ts` at that commit, `data['version'] !== 1`).
  A `{version: 2, sessions: []}` file threw `MalformedSessionStoreError: ... expected version 1 with a sessions array`, so an older daemon treats a bumped file as unreadable.

A daemon started before an upgrade keeps running the old code against the same `~/.remi/sessions.json`, so the file must stay readable and rewritable by the old parser.

## Decision

Add the vocabulary and make the store tolerate it, without changing what any daemon writes or emits.

1. **Names.** `HARNESS_IDS = ['claude', 'codex', 'opencode']` and `DEFAULT_HARNESS = 'claude'` live in `packages/shared/src/harness.ts`, exported from the package index only (no `package.json` exports entry).
   The registry (phase 2) holds only Claude until the Codex epic (superseded, see Phase 2 amendment item 3).
2. **Persisted Claude records store neither `harness` nor `harnessSessionId`.**
   Absence means Claude.
   A Claude record on disk therefore stays the eight-key object an older daemon already writes and reads, and `version` stays 1.
3. **One source of truth for Claude.**
   `SessionBindingStore.getIdentity` derives a Claude identity from the `claudeSessionId` column, including for a record that names `claude` explicitly; a stored `harnessSessionId` is never read for Claude.
   `update()` writes only that column, so a rotation cannot leave two copies apart.
4. **Tolerant parse.**
   `parseStoredSession` copies `harness` (a string) and `harnessSessionId` (a string or null) when well-typed and ignores them otherwise.
   It never throws on them and never validates `harness` against `HARNESS_IDS`, so a record naming a harness this build does not know, as a string, is kept verbatim across a rewrite instead of bricking the file.
   A `harness` that is not a string at all (a number, an object, an array, a boolean or `null`) is ignored like an absent one: it reads as Claude and is dropped on the next rewrite.
   A key is set only when present, which is what keeps a legacy record at eight keys in memory as well as on disk.
5. **Unknown means null, not Claude.**
   `getIdentity` returns `null` for an absent record and for an unrecognized `harness` string, so a caller never mistakes a newer daemon's record that names its harness as a string for a Claude one.
   That guarantee covers strings only: a non-string `harness` is treated as absent by the parser (decision 4), so `getIdentity` reports it as Claude.
   `get()` is not widened; it still returns exactly `{ claudeSessionId }`.
6. **Wire fields are typed, not emitted.** (Changed by #1179: `harness` and `harnessSessionId` are emitted on `hello_ack`, `question` and the daemon's own session-list entry, `create_session_request` has `harness` and `args`, and `hello_ack` has `harnesses`; `answerPath` is still not added. See ADR 0033, Phase 5 amendment. The text below is what was true when this was written.)
   `harness?` and `harnessSessionId?` exist on `DiscoverableSession`, `HelloAckMessage` and `QuestionMessage` (written `?: T | undefined` for `exactOptionalPropertyTypes`), each documented as typed only.
   Populating them, adding `answerPath`, and giving `create_session_request` `harness` and `args` with an argument allowlist are deferred to the Codex epic (#1165): nothing consumes them until a non-Claude harness exists, and a typed-but-unpopulated field described as shipped is the failure AGENTS.md rule 4 names.
7. **`Decision` is `type Decision = Question`.**
   `localRender`, `answerPath` and `resolvedBy` are typed (`LocalRender`, `AnswerPath`, `ResolvedBy`) and attached to no message.
   The strategy section 8 field mapping is the doc comment on `Decision`.
8. **No physical move** of the existing Claude modules (`hooks/`, `transcript/`, `auto-approve/`, `parser/`) into a `harness/claude/` directory; Phase 3 adds three flat files under `harness/` (`claude.ts`, `claude-session.ts`, `claude-transcript-path.ts`) and moves only the launch out of `cli.ts`; a boundary ratchet test (phase 3) guards the line.
9. **No web or iOS changes** in this series.

## Consequences

- The Codex adapter has a place to plug in, and the persisted shape for a second harness is decided before anything writes it.
- Claude records are untouched on disk, so a daemon from before this change reads, rewrites and resumes them as it always did.
- A **non-Claude record is not protected from a daemon older than this change.**
  Such a daemon drops `harness` on its next rewrite, and the record then reads as Claude.
  The Codex epic must close that before it writes the first non-Claude record (for example by refusing to create one while an older daemon is registered).
  This phase makes the current build tolerant; it does not retrofit the builds already installed.
- `getIdentity` has no production caller yet, and no code sets `harness` or `harnessSessionId` on a record or a message (checked below), so the behavior of every shipped path is unchanged. (Changed since: Codex records set them (#1177) and the wire emits them (#1179); `getIdentity` is called by the session list and every question emission.)
- Besides `getIdentity`, these exports have no production caller: `identityFromClaudeId`, `isHarnessId`, `HARNESS_IDS` and `SessionIdentity` (reached only through `getIdentity`), and `DEFAULT_HARNESS`, `Decision`, `AnswerPath`, `LocalRender` and `ResolvedBy` (tests and doc comments only).
  They are vocabulary for the Codex epic (#1165); delete any it does not use.
- A record whose harness string this build does not know was reachable by `claudeSessionId` through the existing methods when this was written; only `getIdentity` withheld it. Changed by #1176: `findByClaudeSessionId` and the fallback of `resolveStoredSession` match Claude records only, `getMostRecent('claude')` skips such a record, and `remi --resume <remi id>` of one exits 1 with a message instead of resuming it.
- `Decision` being an alias means there is no separate object to validate: the strategy's `kind` values `sandbox` and `trust` have no `Question.kind` today (they are hook-less PTY prompts, `source: 'pty'`), and `answerPath` cannot be read from `Question.held`, which marks every card pushed by id.
  The mapping comment records both so nobody rediscovers them.

## Alternatives considered

- **Write `harness: 'claude'` on every record.**
  Rejected: the first probe above shows a daemon without the field in its parser deletes it, and Claude records would then differ in shape depending on which build last wrote them.
- **Bump `sessions.json` to `version: 2`.**
  Rejected: the second probe above shows an older daemon refuses the file, which would break `--resume` on a machine running two versions.
- **Widen `get()` / `SessionBinding` with harness fields.**
  Rejected: `session-binding-store.test.ts` lines 53 and 79 pin `get()` to exactly `{ claudeSessionId }`, and every caller reads only that.
  A separate `getIdentity` leaves them untouched.
- **Type `StoredSession.harness` as `HarnessId`.**
  Rejected: the parser would have to reject or coerce an unrecognized string, and either bricks the file or rewrites a newer daemon's record as something else.
- **Rename `Question` to `Decision`.**
  Rejected: more than 100 uses, and no benefit before a second harness exists.
- **Emit `harness` and `harnessSessionId` on the wire now.**
  Rejected for this series: nothing would read them (see decision 6).

## Receipts

- Epic #1161, this phase #1162, deferred wire work #1165; `.context/strategy-2026-10.md` sections 8 (the `Decision` object) and 10 (sequencing).
- Pin tests that passed on the unmodified source before any change: `packages/daemon/tests/session-store.test.ts`, "legacy record shape (#1162)"; and `session-binding-store.test.ts` lines 53 and 79, unmodified.
  The preservation tests under "harness identity fields (#1162)" fail on the unmodified parser.
- Checks that nothing populates the new fields, run on the finished branch:
  - `grep -rn "harnessSessionId" packages/*/src` hits only declarations (`shared/src/types.ts`, `protocol.ts`, `StoredSession`), the parser copy in `parseStoredSession`, `getIdentity`, `shared/src/harness.ts`, and, since Phase 2, the parameter name of `Harness.resumeArgs` and `Harness.transcriptPath` (`harness/types.ts`, `harness/claude.ts`), which carries the id a caller passes in and sets it on no record or message.
  - `grep -rn "getIdentity" packages/*/src` hits only its definition and comments.
  - `packages/shared/tests/harness.test.ts` asserts the `hello_ack`, `question` and `session_list_response` factories emit neither key. (Changed by #1179: it asserts they emit neither key GIVEN no identity, and that they dual-emit the identity they are given.)
- ADR 0011 (verify before you describe) is why each wire field says "typed only" instead of describing intent; ADR 0012 (protocol registry) is untouched because no message type is added.

## Phase 2 amendment: the `Harness` descriptor (#1163)

Phase 2 adds the descriptor the daemon asks instead of spelling Claude's values at each call site.
It changes no behavior: the same bytes are typed, the same arguments are spawned, the same paths are built.

1. **Three members, each with a production caller.** Phase 3 adds a fourth member, `createSession` (its item 2).
   `packages/daemon/src/harness/types.ts` declares `gracefulExitInput: string | null` (Stop types it; `null` takes the existing force-close path), `resumeArgs(harnessSessionId)` (the resume handler's launch arguments) and `transcriptPath(projectPath, harnessSessionId)` (three call sites: `current-session.ts`, the session-list decoration and the durable-index load; `expectedTranscriptPath` calls the leaf, item 4).
   `ClaudeHarness` returns `'/exit'`, `['--resume', id]` and `<projectsDir>/<project path with every "/" replaced by "-">/<id>.jsonl`.
2. **`id` and `command` are not declared, which departs from the issue text.**
   Issue #1163 listed both, but also said the interface carries only members with a caller in this PR.
   Nothing calls either: the one `command: 'claude'` site is in `createPtySessionForSession` (`pty-session-setup.ts`), which the same issue says to leave alone, and nothing branches on a harness id while one harness exists.
   Phase 3 expected to add `command` with `createSession` and did not (Phase 3 item 4); the id arrives with the first consumer that has more than one harness to tell apart.
3. **No registry.**
   The epic title says "descriptor and registry", but no code looks a harness up by id: a daemon hosts one session, so `cli.ts` builds one `ClaudeHarness` and passes it to the handler factories (`createSessionHandlers`, `createTranscriptHandlers`, `createResumeSessionHandlers`, `makeCurrentSessionResolver`).
   An id-keyed registry arrives with the first caller that needs one, the `harness` field on `create_session_request` (#1165 section B).
   The phrase "The registry (phase 2) holds only Claude" in decision 1 above is superseded by this item.
4. **One transcript path rule.**
   `current-session.ts`, the session-list decoration and the durable-index load in `transcript-events.ts` go through `Harness.transcriptPath`; `expectedTranscriptPath` goes through `claudeTranscriptPath`, the leaf that `ClaudeHarness.transcriptPath` also calls (Phase 3 item 7), so the `<dir>/<id>.jsonl` composition lives in `harness/claude-transcript-path.ts` alone.
   The directory encoding stays in `TranscriptDiscovery.getProjectTranscriptDir`, which `claudeTranscriptPath` calls and which `transcript-binder.ts` 995 also calls.
   `expectedTranscriptPath` keeps its `(discovery, projectPath, id)` signature because `same-cwd-no-cross-binding.test.ts` calls it.
   It built a `ClaudeHarness` per call until Phase 3 item 7, which was cheap because the harness held no state beyond the discovery it is given.
5. **Claude layout knowledge still outside the harness, by scope.**
   Two sites spell a Claude value and are untouched.
   The `claudeArgs.unshift('--resume', ...)` in `cli.ts` (for `remi --resume <id>`) cannot use the harness: it runs at module top level, before `const harness` is constructed further down the file, so calling it there would be a temporal dead zone error.
   Comments in `cli.ts` and on `ClaudeHarness.resumeArgs` name each other, so a change to Claude's resume flag touches both.
   `command: 'claude'` in `createPtySessionForSession` (`pty-session-setup.ts`) was left alone, as the issue says; Phase 3 expected to add `command` with `createSession` and did not (Phase 3 item 4); the id arrives with the first consumer that has more than one harness to tell apart. (Changed by #1176: that site now takes the command as a defaulted `launch` parameter, see Phase 3 item 4.)
   The remaining sites read or derive from an existing path, directory or directory entry, rather than building a session's transcript path from `(projectPath, id)`, so `transcriptPath` does not cover them and a second harness will have to:
   - `transcript-binder.ts` 995 asks the discovery for the project directory (the rotation poll), and 1085 builds a candidate path from a directory entry (`path.join(rotationPollDir, name)`).
   - `transcript-binder.ts` 590 and 1074-1075, and `transcript-discovery.ts` 174, recover an id from a filename (`path.basename(resolved, '.jsonl')` or a stripped `.jsonl` suffix).
   - `transcript-discovery.ts` 177-178 and `resume-session-events.ts` 223 decode `-` back to `/` in a directory name.
   - `api/subagent-view-registry.ts` 40-41, 55 and 80 derive `<base>/subagents/agent-<id>.jsonl` from the main transcript path.

### Receipts

- Pin test, passing on the unmodified source before any change: `packages/daemon/tests/cli/transcript-path-golden.test.ts` (a hand-built literal for `/Users/x/my.proj`, which pins that only `/` is replaced, at all four sites).
  `session-events.test.ts` (`/exit`) and `resume-session-events.test.ts` (`['--resume', id]`) are the other pins; their assertions are unmodified.
- `session-events-harness.test.ts` and `resume-session-events-harness.test.ts` give the handlers a harness whose exit input or resume arguments differ (and one with no exit input), because the pins above cannot tell a handler that asks the harness from one that still hardcodes Claude's value.
- `grep -rn 'getProjectTranscriptDir(.*)}/\${' packages/daemon/src` hits only `claudeTranscriptPath` in `harness/claude-transcript-path.ts` (at Phase 2 it was `ClaudeHarness.transcriptPath`).
- Both handler sites that take a `TranscriptDiscovery` for other reasons are held to the harness by tests, because reverting either to the inline expression compiled and passed every Claude-valued test: `session-events-harness.test.ts` (the listed session's `transcriptPath` from a stand-in harness), `transcript-events-harness.test.ts` (a durable-index transcript that exists only at the stand-in path), and `tests/harness/transcript-path-source.test.ts` (`getProjectTranscriptDir(` may appear only in `transcript-discovery.ts`, `transcript-binder.ts` and `harness/claude-transcript-path.ts` (Phase 2 named `harness/claude.ts`; Phase 3 item 7 moved it)).

## Phase 3 amendment: `HarnessSession` and the launch extraction (#1164)

Phase 3 moves the Claude-specific middle of `createNewSession` behind the seam, in two steps: the launch extraction (#1171), then one `harnessSessions` map with a `DecisionChannel` and `dispose()` in place of the per-session maps.
Nothing a client, a file or a process can see changes, apart from one log line (item 5).
The items below describe the end state.

1. **What moved.**
   The 207 lines of base `cli.ts` at `7b3d1843`, lines 1554-1760, which start at the comment two lines above `sessionNotifiers.set` and end with the `createPtySessionForSession(...)` call (the `QuestionPresenceTracker`, the `OutputProcessor`, `resolveClaudeBinding` and `bindingStore.preAssign`, the hook bridge, the PTY), are now `createClaudeSession` in `packages/daemon/src/harness/claude-session.ts`, reached through `Harness.createSession(ctx: HarnessLaunchContext): HarnessSession`.
   In the move commit (`aec82ea5`; PR #1171 head history, `refs/pull/1171/head`; not in the squashed epic branch) 192 of those 207 lines are byte-identical; the other 15 only swap a daemon global for a dependency (`hookServer` for `deps.hookServer()`, `PORT` for `deps.currentPort()`, and so on).
   `createNewSession` keeps the neutral shell: the message API, `createSession`, `registerSession`, the `starting` status, `start()` with `markExited` on failure, and the child pid.
   Statement order inside the moved block is unchanged, and only one of its constraints is observable: `preAssign` before `setupHookBridge`, because `setupHookBridge` reads the binding synchronously (the `preAssignedClaudeId` block of `setupHookBridge`, `hook-bridge-setup.ts`) and arms the transcript binder only when one exists.
   Moving `preAssign` after the bridge fails `launch-characterization.test.ts` (the daemon logs that the fallback poll is not armed and never binds the transcript) and `claude-session.test.ts` (no fallback timer).
   The tracker before the hook bridge is kept for fidelity only: the statements between them are synchronous and the maps are read only inside later callbacks, so reordering it survives every test, and that is expected. `sessionNotifiers.set` was in this order too (before the tracker); #1176 moved it out of the launch into `createNewSession`, before `harness.createSession`, where `tests/harness/session-notifier-order.test.ts` and `tests/integration/session-notifier-registration.test.ts` pin it.
   One order is relaxed on purpose: the daemon-side registration of the tracker and gate (formerly the `sessionTrackers` and `sessionGateHandles` maps, filled mid-launch) is now `createNewSession` storing the returned `HarnessSession` in `harnessSessions` after `createSession` returns and before it registers the PTY.
   That is unobservable: the tracker's closures read the session's own `decisions`, which has no gate until the bridge exists, and the handlers that read `harnessSessions` run only on client messages, after the launch has returned; a pin in `claude-session.test.ts` holds the store between `createSession` and `registerSession`.
2. **Members, each with a production caller.**
   `HarnessLaunchContext` carries what the shell hands over (session id, working directory, extra arguments, pass-through, reserved rows, the message API, `sendAndRecord`, `sendMessage`), and `createClaudeSession` reads every field. (The context carried the session's notifier until #1176 moved its registration into the shell; nothing read it after that, so the field went.)
   `HarnessSession` is `{pty, decisions, start(), dispose()}`: `cli.ts` registers `pty` with the session registry, reads its child pid, calls `start()`, and calls `dispose()` from `onSessionClosed` and `cleanup`.
   `DecisionChannel` carries the member names of the permission gate's `SessionGateHandle`, so `gateAnswerDeps` (`retireQuestion`, `answerHeld`, `noteTerminalEscape`), `promptUpDeps` (`hasMainHold`, `hasOpenHookPrompt`, `screen`) and `trackerScreenDeps` (`screen`) take it with no edit, `forceReleaseAllSessions` calls `forceRelease`, and the tracker's own closure calls `isHeld` through the same channel.
   `screen` is typed optional because a harness may have no screen to read; Claude always has one.
   `DecisionScreen` repeats the three tracker reads that `ScreenObserver` (`input-events.ts`) and `PromptUpScreen` (`prompt-up.ts`) declare; they are structurally equal and `cli.ts` passes one where the other is expected, so a drift is a type error.
   A session with no hook server has a channel that reads as nothing held (`answerHeld` is `unknown`, `forceRelease` resolves 0).
   `HeldAnswer` and `HeldAnswerOutcome` moved verbatim from `auto-approve/auto-approve-gate.ts` to `harness/decision.ts` (re-exported from `auto-approve/index.ts`), so `input-events.ts` no longer imports `auto-approve/`.
3. **Four values arrive as getters.**
   `hookServer` is read at PTY-event time and nulled by `cleanup`; `PORT` is reassigned by port probing after the harness is built; the websocket port feeds the `remi:<port>` name and `REMI_PORT` at spawn time; `[prompts]` picks the hold policy at each launch, where the original read the config global.
   `ClaudeLaunchDeps` takes `hookServer: () => HookServer | null`, `currentPort: () => number`, `wsPort: () => number` and `prompts: () => ...`, and `tests/harness/claude-session.test.ts` pins both ends: one harness built before the hook server and the websocket port exist launches twice and must see them (a harness that snapshots any of them fails), and `cli.ts` is pinned to pass getters while the PTY callbacks are pinned to call `deps.hookServer()` when they fire.
4. **`command` is still not on `Harness`.**
   This supersedes Phase 2 items 2 and 5, which both expected it here.
   It was not added because nothing neutral asks for it: `command: 'claude'` stays in `createPtySessionForSession` (`pty-session-setup.ts`), which only `createClaudeSession` calls.
   Changed by #1176: the spawn site takes an optional `launch: {command, childEnv}` (both required when given, so a non-Claude command never inherits `buildClaudeChildEnv`) and an `outputSink` in place of the `OutputProcessor`; absent, it is the Claude launch unchanged. `command` is still not on `Harness`; the first caller that spawns a command other than `claude` is the Codex epic.
5. **One map replaces three, and the turn filter moved.**
   `harnessSessions: Map<UUID, HarnessSession>` replaces `sessionGateHandles`, `sessionTrackers` and `binderClosers` in `cli.ts`; every session that launched has an entry.
   `sessionAdmitsHandles` became `ClaudeHarness.admitsAnySession(input)`, which `onTurnStop` calls; it is a Claude hook filter, so it is on the class and not on `Harness`.
   `sessionNotifiers` stays in `cli.ts` and `createClaudeSession` filled it, as the issue specified; registering a notifier is neutral work a second harness would repeat, so #1176 moved it into the shell: `createNewSession` registers the session's dispatcher before `createSession`, and `ClaudeLaunchDeps.sessionNotifiers` is a read-only reference for the lazy terminal-notice closures.
   Three differences from the inline code, none visible on the wire or on disk:
   - `remi unstick` logs `Force-released N session(s)` with N counting every session, so a daemon whose hook server failed to start now counts its session with 0 cards resolved (before, N was 0 there). This log text is the one visible change.
   - `cleanup` calls `dispose()` on each session after `hookServer.stop()` and leaves the sessions in the map.
     `onSessionClosed` disposes them again when the PTY exits (`cleanup` runs, `sessionRegistry.shutdown()` closes the PTY, `onSessionClosed` fires), which the `disposed` guard makes a no-op; a test pins the guard with a sentinel timer that a second `binder.close()` would delete.
     Before, `cleanup` called every binder closer and cleared `binderClosers`, so `onSessionClosed` found no closer and did nothing, and the gate, tracker and turn-filter maps stayed.
     The turn filter is now dropped at `cleanup` (it was kept before), which is harmless because the hook server is already stopped (`HookServer.stop()` calls `server.stop(true)`), so no Stop can arrive to read it.
     A pin holds the stop-before-dispose order.
   - A launch that throws after the hook bridge exists is not cleaned up, and head differs from base in what it leaves behind.
     The only throw after the bridge is `createPtySessionForSession`'s `Invalid wsPort`, which the daemon cannot trigger because the websocket port is positive by then; a test can (`wsPort = 0` with a hook server): head ends with one entry in `transcriptFallbackTimers` and `admitsAnySession` true for the dead launch's claude id.
     Base leaked the same way for the turn filter and, because its maps were populated mid-launch, also left binder-closer and gate entries that `cleanup` could still close; head leaves a timer nobody references.
     This phase does not wrap the launch segment in a try/catch.
     One related case is better than before: if `setupHookBridge` itself throws, no tracker is left in `harnessSessions` for a session that never registered, where `sessionTrackers` kept one.
6. **The harness is constructed later in `cli.ts`.**
   Launching reads services declared after the Phase 2 construction site, so `new ClaudeHarness(transcriptDiscovery, launchDeps)` now sits just before its first consumer, `createSessionHandlers`.
   `launchDeps` is optional and `createSession` refuses without it, because `expectedTranscriptPath` and the Phase 2 tests build a harness only to resolve paths.
   Phase 2 said the harness holds no state beyond the discovery it is given; it now also holds each live session's turn filter.
7. **The transcript fallback no longer imports the harness.**
   `expectedTranscriptPath` used to build a `ClaudeHarness`, which closed a runtime import cycle: `claude-session.ts` -> `hook-bridge-setup.ts` -> `transcript/index.ts` -> `transcript-binder.ts` -> `transcript-fallback.ts` -> `harness/index.ts` -> `harness/claude.ts` -> `claude-session.ts`.
   It was benign (the PR review imported every daemon module as an entry point and built a compiled binary at the base and head commits, all fine), but it would break on any top-level `class extends` or construction in the loop.
   The path composition is now `claudeTranscriptPath` in `harness/claude-transcript-path.ts`, a leaf with no runtime import, called by both `ClaudeHarness.transcriptPath` and `expectedTranscriptPath`.
   `transcript-path-source.test.ts` names that leaf as the one allowed caller of `getProjectTranscriptDir(` besides the discovery and the binder; the golden tests are unmodified.
8. **Boundary ratchet.**
   `tests/harness/harness-boundary.test.ts` fails when a neutral module (`harness/types.ts`, `harness/decision.ts`, `cli/current-session.ts`, `cli/handlers/`, `api/`, `session/`) imports `hooks/`, `auto-approve/`, `transcript/`, `cli/session-phases/`, `harness/index`, `harness/claude`, `harness/claude-session`, `harness/claude-transcript-path`, `cli/claude-binding`, `parser/{output-processor,question-parser,status-parser,index}` or the package root.
   `@remi/daemon` and its `exports` subpaths resolve onto `src` through the package's own `exports` table, so the package name is no way around it; neutral code takes the contract from `harness/types` and `harness/decision`.
   A second rule lets only `cli.ts` and `harness/` import `harness/index`, `harness/claude` or `harness/claude-session` other than as a type, which is what keeps item 7's cycle from re-closing.
   The debt list holds today's three offenders, chat-seam debt: `cli/handlers/session-events.ts`, `resume-session-events.ts` and `transcript-events.ts`, each importing `transcript/index.ts` for Claude's transcript types.
   A new offender fails, and so does a debt entry whose import is gone, so the list can only shrink.
   What stays outside by design: a specifier computed at runtime, a path built by hand for `fs` or `new URL`, and a second hop through another neutral file's re-export.
9. **Still outside the seam.**
   The two hook-server start blocks in `cli.ts` (they have different failure semantics), the turn-complete, denial and failure events, the `--resume` rewrite at the top of `cli.ts`, and the three handlers in item 8. (`command: 'claude'` with `buildClaudeChildEnv` is now the default of the spawn's `launch` parameter, item 4, and `sessionNotifiers` is filled by the shell, item 5, both since #1176.)

### Receipts

- Pin test, passing on the unmodified source (`7b3d1843` plus the test only) before any refactor: `packages/daemon/tests/integration/launch-characterization.test.ts`, 5 of 5 runs; the final file (Phase 3 and 3b added the unstick cases) passes 5 of 5 on the final tree and 3 of 3 against `7b3d1843` (with the final `hub-test-utils.ts` copied in, which the final file needs).
  It runs the real `cli.ts --daemon` with a real executable fake `claude` on PATH and reads the argv (`--session-id <uuid> -n remi:<port>`), the child environment and working directory, `sessions.json`, the live-sessions `claudeChildPid`, the hook URL in `settings.local.json`, `hello_ack.claudeSessionId`, the `starting` status in the connect replay, the binder binding the transcript the fake wrote (so `preAssign` ran before the bridge), the daemon exiting when Claude exits (#641) and the hooks being removed on SIGTERM.
  A further case runs the daemon with no `claude` on PATH and a stand-in login shell, and asserts exit 1, the stored record marked exited, live-sessions unregistered and the hooks removed.
  Its daemon takes a random port from `reserveRange` and an empty `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, so concurrent test processes and a developer shell that exports `=0` cannot change the result.
- Mutation checks of that test, each reverted: the `-n` display name, `setClaudeChildPid`, `preAssign` (also moved after the bridge), the `REMI_PORT` value, the inline-renderer variable, `markExited` (both paths), the hook install, the hook uninstall, the whole cleanup-and-exit on PTY exit, `hello_ack`'s `claudeSessionId`, the `starting` status, and a `start()` that swallows its error each fail it.
  One survivor: replacing only the `exitProcess(...)` call in the PTY exit handler passes, because `cleanup()` lets the event loop drain and the daemon exits anyway.
- `git diff -M --stat` cannot show this as a move: `cli.ts` is modified, not renamed, so rename detection has nothing to pair `claude-session.ts` with.
  The evidence is the line comparison in item 1.
- A runtime import-graph walk (non-type imports under `packages/daemon/src`) finds the cycle in item 7 at `8545a1d0` (PR #1171 head history, `refs/pull/1171/head`; not in the squashed epic branch) and none through `harness/claude-session.ts`, `harness/claude.ts`, `harness/index.ts` or the new leaf afterwards.
- The consolidation is pinned by `claude-session.test.ts` (a real hook server holds a prompt that `decisions.answerHeld` answers; `retireQuestion`, `forceRelease` and `noteTerminalEscape` each reach the gate; two sessions each claim only their own events and `dispose()` releases one; `cli.ts` is read with comments stripped for the store-before-register order, the dispose-before-drop order in `onSessionClosed`, the stop-before-dispose order in `cleanup`, and the `harnessSessions` iteration and count in `forceReleaseAllSessions`), by the SIGUSR2 case in `launch-characterization.test.ts` (the unstick log line for the one session), and by the retargeted wiring pins in `input-events.test.ts`.
  Mutation checks, each reverted, kill every `ClaudeDecisions` delegation (`isHeld` is also asked about an id nothing holds, because a delegation to `hasMainHold` agrees with it on the held card), the gate attach, the screen, the turn-filter registration and release, the binder close in `dispose()`, `admitsAnySession` always true or ignoring the map, each `cli.ts` ordering, and a commented-out `onTurnStop` filter or `isHeld` read.
  `dispose()` removes the turn filter in a `finally`, and a test makes the binder's close throw to pin it; the `disposed` guard is pinned by the sentinel timer in the dispose test.
  `launch-characterization.test.ts` sends SIGUSR2 twice over: with nothing held (`Force-released 1 session(s): 0 card(s) resolved`) and with a real held PermissionRequest (`1 card(s) resolved` and an empty hook response), which kills a loop that iterates nothing, a dropped `resolved +=`, a `forceRelease` that is never called and a session count fixed at 0.
- `grep -rn "sessionGateHandles\|sessionTrackers\|binderClosers\|sessionAdmitsHandles" packages/daemon/src AGENTS.md` hits only comments that say what the old maps were.
- Source-text tests that pinned the moved lines in `cli.ts` were retargeted, not weakened: `hold-policy.test.ts` and `live-questions.test.ts` read `claude-session.ts`, and `transcript-path-source.test.ts` names the leaf.
  The stand-ins in the session, resume and transcript harness tests are typed with each handler's own dependency type (`SessionHandlerDeps['harness']` and the like), so they carry no `createSession` and no member the handler cannot ask for.

