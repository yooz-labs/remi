# ADR 0032: Harness seam and the session identity shim

**Status:** accepted
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
   The registry (phase 2) holds only Claude until the Codex epic.
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
6. **Wire fields are typed, not emitted.**
   `harness?` and `harnessSessionId?` exist on `DiscoverableSession`, `HelloAckMessage` and `QuestionMessage` (written `?: T | undefined` for `exactOptionalPropertyTypes`), each documented as typed only.
   Populating them, adding `answerPath`, and giving `create_session_request` `harness` and `args` with an argument allowlist are deferred to the Codex epic (#1165): nothing consumes them until a non-Claude harness exists, and a typed-but-unpopulated field described as shipped is the failure AGENTS.md rule 4 names.
7. **`Decision` is `type Decision = Question`.**
   `localRender`, `answerPath` and `resolvedBy` are typed (`LocalRender`, `AnswerPath`, `ResolvedBy`) and attached to no message.
   The strategy section 8 field mapping is the doc comment on `Decision`.
8. **No physical move** of Claude modules into a `harness/claude/` directory in this series; a boundary ratchet test (phase 3) guards the line.
9. **No web or iOS changes** in this series.

## Consequences

- The Codex adapter has a place to plug in, and the persisted shape for a second harness is decided before anything writes it.
- Claude records are untouched on disk, so a daemon from before this change reads, rewrites and resumes them as it always did.
- A **non-Claude record is not protected from a daemon older than this change.**
  Such a daemon drops `harness` on its next rewrite, and the record then reads as Claude.
  The Codex epic must close that before it writes the first non-Claude record (for example by refusing to create one while an older daemon is registered).
  This phase makes the current build tolerant; it does not retrofit the builds already installed.
- `getIdentity` has no production caller yet, and no code sets `harness` or `harnessSessionId` on a record or a message (checked below), so the behavior of every shipped path is unchanged.
- A record whose harness string this build does not know still resumes by `claudeSessionId` through the existing methods; only `getIdentity` withholds it.
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
  - `grep -rn "harnessSessionId" packages/*/src` hits only declarations (`types.ts`, `protocol.ts`, `StoredSession`), the parser copy in `parseStoredSession`, `getIdentity`, and `harness.ts`.
  - `grep -rn "getIdentity" packages/*/src` hits only its definition and comments.
  - `packages/shared/tests/harness.test.ts` asserts the `hello_ack`, `question` and `session_list_response` factories emit neither key.
- ADR 0011 (verify before you describe) is why each wire field says "typed only" instead of describing intent; ADR 0012 (protocol registry) is untouched because no message type is added.

## Phase 2 amendment: the `Harness` descriptor (#1163)

Phase 2 adds the descriptor the daemon asks instead of spelling Claude's values at each call site.
It changes no behavior: the same bytes are typed, the same arguments are spawned, the same paths are built.

1. **Three members, each with a production caller.**
   `packages/daemon/src/harness/types.ts` declares `gracefulExitInput: string | null` (Stop types it; `null` takes the existing force-close path), `resumeArgs(harnessSessionId)` (the resume handler's launch arguments) and `transcriptPath(projectPath, harnessSessionId)` (four call sites).
   `ClaudeHarness` returns `'/exit'`, `['--resume', id]` and `<projectsDir>/<project path with every "/" replaced by "-">/<id>.jsonl`.
2. **`id` and `command` are not declared, which departs from the issue text.**
   Issue #1163 listed both, but also said the interface carries only members with a caller in this PR.
   Nothing calls either: the one `command: 'claude'` site is `pty-session-setup.ts` 203, which the same issue says to leave alone, and nothing branches on a harness id while one harness exists.
   Phase 3 adds `command` with `createSession`, which is the first thing that spawns through the harness, and the id with the first consumer that has more than one harness to tell apart.
3. **No registry.**
   The epic title says "descriptor and registry", but no code looks a harness up by id: a daemon hosts one session, so `cli.ts` builds one `ClaudeHarness` and passes it to the handler factories (`createSessionHandlers`, `createTranscriptHandlers`, `createResumeSessionHandlers`, `makeCurrentSessionResolver`).
   An id-keyed registry arrives with the first caller that needs one, the `harness` field on `create_session_request` (#1165 section B).
   The phrase "The registry (phase 2) holds only Claude" in decision 1 above is superseded by this item.
4. **One transcript path rule.**
   `current-session.ts`, the session-list decoration, the durable-index load in `transcript-events.ts` and `expectedTranscriptPath` all go through `transcriptPath`, so the rule lives in `ClaudeHarness` alone.
   `expectedTranscriptPath` keeps its `(discovery, projectPath, id)` signature because `same-cwd-no-cross-binding.test.ts` calls it, and builds a `ClaudeHarness` per call; the harness holds no state beyond the discovery it is given.
5. **Claude knowledge still outside the harness, by scope.**
   The `claudeArgs.unshift('--resume', ...)` in `cli.ts` (for `remi --resume <id>`) and `pty-session-setup.ts` 203 (`'claude'`) are untouched, as the issue says.
   `transcript-binder.ts` 995 asks the discovery for the project directory (the rotation poll), and `transcript-binder.ts` 1074-1075 and `transcript-discovery.ts` 167-174 strip the `.jsonl` suffix to recover an id.
   Those read a directory or a filename rather than building a session's transcript path, so `transcriptPath` does not cover them; a second harness will have to.

### Receipts

- Pin test, passing on the unmodified source before any change: `packages/daemon/tests/cli/transcript-path-golden.test.ts` (a hand-built literal for `/Users/x/my.proj`, which pins that only `/` is replaced, at all four sites).
  `session-events.test.ts` (`/exit`) and `resume-session-events.test.ts` (`['--resume', id]`) are the other pins; their assertions are unmodified.
- `session-events-harness.test.ts` and `resume-session-events-harness.test.ts` give the handlers a harness whose exit input or resume arguments differ (and one with no exit input), because the pins above cannot tell a handler that asks the harness from one that still hardcodes Claude's value.
- `grep -rn 'getProjectTranscriptDir(.*)}/\${' packages/daemon/src` hits only `ClaudeHarness.transcriptPath`.
