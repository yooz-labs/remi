# Card AW1: keep the Mac awake while a session has real work, level 1, no privileges (issue #1773, slice 1)

Status: ready
Tier: worker
Timebox: L, 8 hours; escalate at 1 day or two failed approaches
Needs: none (no Xcode, no simulator); runs on this macOS Mac
Depends: ADR 0050 accepted (`.context/decisions/0050-keep-the-mac-awake.md`, merged on develop; PR #1779 records the owner decisions and may still be open: read the ADR on that branch or its owner-decisions section if present) and develop `82e1cde6` or later
Branch: `feature/issue-1773-awake-level1` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-l1` (the manager creates it with `git worktree add -b` and runs `bun install`)
Plan: ADR 0050 sections "Recommended decision" (level 1), "What counts as real work", slice 1 of "Slices and how each is tested without a lid"; issue #1773 and its comments

## Goal

Each session daemon on macOS holds a no-idle-sleep power assertion (`/usr/bin/caffeinate -i -w <its own pid> -t <ttl>`) while its session has real work (an agent turn is open, a tool is executing, or a question is pending), releases it after an idle grace period, never holds longer than the stuck-state bounds, and does nothing on other platforms; the behavior is a pure, tested state machine plus a thin real-process boundary, configurable from the config file, with no privileges and no effect when disabled.

## Context

- Decided by the owner (2026-11-14, ADR 0050 and issue #1773): level 1 only in this slice (no `pmset`, no sudoers, no lid-closed mode, no battery or thermal reading: those are later slices); idle-system-sleep assertion only, never a display assertion; the hold is bound to the session daemon's own process id so the OS releases it when that process dies; the pending-question hold cap is 30 minutes by default and is a configuration option; the idle revert/grace default and the stuck-state bound are options too.
- ADR facts to use (read them, they carry file and line citations at `3bb7ad9d`): the status funnel `MessageApi.handleStatusChange` (`packages/daemon/src/api/message-api.ts`), busy means `thinking`, `executing` or `waiting` (`packages/shared/src/types.ts`); the gap: `UserPromptSubmit` (`packages/daemon/src/cli/session-phases/hook-bridge-setup.ts` near line 1268) sets no status, so a turn that only reasons reads `idle`: add a turn-open flag from UserPromptSubmit to Stop, StopFailure or SessionEnd; pending questions come from `SessionRegistry` `onQuestionsChanged`; a turn interrupted with Escape fires no Stop (`notifications/turn-timer.ts`), so busy can stick: busy with no hook event, PTY output or Codex notification for 15 minutes releases the hold and logs once; the caffeinate time to live is 20 minutes and is renewed while busy by spawning the new holder BEFORE killing the old one; release after a 2 minute idle grace; Codex sessions (`harness/codex/codex-session.ts`) must be covered through the same funnel.
- The repository forbids mocks that replace business logic: the policy is a pure function of (events, clock, config) to a desired hold state and is tested directly; the OS boundary is tested with the real `caffeinate` and the real `pmset -g assertions` on this Mac (the ADR records that both were done by hand: an assertion appears as "Created for PID", and is gone after the target is killed).
- The hub (`remi serve`) is session-less and never holds anything in this slice; the session daemon (`remi --daemon` children and a plain `remi` session) is the unit.
- The owner's real hub is PID 2140 on port 18765 with session daemons on 18766 to 18769: never touch them, never signal them, and never use those ports. Run any daemon you need with `env -i` and its own `REMI_HOME` (for example under `/tmp/remi-awake-test`) on a port above 18790, with the fake agent approach of the GUI fixture at `/Volumes/S1/yooz/remi/gui-fixture/` as a model if you need a session (read-only reference; do not modify it).
- Never read or print secrets. No emojis, American English, no em dashes. Biome and Bun only (never npm or npx).

## Scope

May change: new `packages/daemon/src/power/` (for example `awake-policy.ts` the pure state machine, `awake-holder.ts` the caffeinate boundary, `awake-wiring.ts` the glue to the status funnel, hook events and the session registry; names are yours); the minimal edits in `packages/daemon/src/cli/session-phases/hook-bridge-setup.ts`, `packages/daemon/src/api/message-api.ts` and the session start path only to feed events in and to start and stop the holder; `packages/daemon/src/config/config.ts` (a new `[awake]` table with validation, defaults and the generated default config text); tests under `packages/daemon/tests/` (a new `power/` folder); `docs/agent-reference/` (one short new file `keep-awake.md` describing what ships) and a pointer line in `AGENTS.md`; the PR body.
No other file; not the Swift apps, not the signaling Worker, not the shared protocol, not the daemon's wire messages.

## Decided design

Settled:
1. `[awake]` configuration (names are proposals from the ADR; keep them unless a name collides): `level1 = true` (hold while there is real work; `false` turns the whole feature off), `question_hold_minutes = 30`, `idle_grace_seconds = 120`, `stuck_busy_minutes = 15`, `ttl_minutes = 20`. Validate types and ranges (positive integers, sane maximums) with the same style as the existing config validation; unknown keys are rejected or warned as the existing config does; the generated default config text documents each option.
2. The pure state machine: inputs are status changes (busy or idle), turn open and turn closed events, pending question count changes, activity heartbeats (hook event, PTY output, Codex notification), session end, and clock ticks; output is `hold` or `release` plus the next deadline. Cases to pin with literal expectations: a turn with no tool calls (turn-open only) holds; Escape-interrupted turn (no Stop) releases after `stuck_busy_minutes` without activity and logs once; idle grace delays the release by `idle_grace_seconds` and a new busy event inside the grace cancels the release; a pending question holds up to `question_hold_minutes` then releases and logs once even if the question is still pending; two overlapping reasons (a question and a turn) release only when both are gone; session end releases immediately; clock goes backwards or jumps forward (tick with an earlier or much later time) does not hold forever or release early; the feature disabled never holds.
3. The boundary: on `process.platform === 'darwin'` only, spawn `/usr/bin/caffeinate -i -w <process.pid> -t <ttl seconds>` with no shell; renew by starting the new holder BEFORE killing the old one; one holder at most steady-state; kill the holder on release and on process exit (`exit`, `SIGINT`, `SIGTERM` handlers) and never leave a holder behind if `caffeinate` is missing or fails (log once, behave as released, never crash the session). Elsewhere it is a no-op.
4. Real-process tests (macOS only, skipped elsewhere with a clear reason): start the holder for a child process that you spawn, find it in the real `pmset -g assertions` output as an assertion whose text contains "Created for PID" and the child's pid, release and find it gone, and SIGKILL the child (a stand-in for a daemon crash) and see the assertion disappear; the tests must clean up every process they start and must never signal a process they did not start (no `pgrep -f` patterns; use the pids you hold).
5. Wiring tests: a hook event stream (UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd) drives the policy through the real hook bridge code path with literal expectations of the hold and release decisions; a Codex status path is covered through the same funnel; the Escape case; a question appears and is answered.
6. Observability: one concise log line when a hold starts, when it ends and why (turn open, executing, waiting, question, stuck bound, grace, session end), never per tick. No new wire messages in this slice (the app surface is slice 4).
7. The doc `docs/agent-reference/keep-awake.md` says what ships (level 1 only; no lid-closed mode; macOS only; system-wide sleep cannot be scoped to remi's processes; what `pmset -g assertions` shows) and what is not verified (a MacBook on battery; behavior with the lid closed is not covered by level 1 at all: the OS may still sleep on lid close or low battery).
Not changing: the hub, the wire, the apps, any sudoers or `pmset` usage, battery or thermal logic (slice 2).
The worker may choose: file and function names, how events are fed in, test names.

Never do: use `pmset -a` or anything that changes system power settings; use `sudo`; hold a display assertion (`-d`, `-u`, `-s` flags are not allowed); kill any process you did not start; touch the real hub or its session daemons; read or print secrets; add a timer-based guess in a place the pure policy should decide.

## Acceptance

1. The pure policy has literal tests for every case in design item 2, and one revert check per rule (mutate: ignore turn-open, drop the stuck bound, drop the question cap, drop the grace cancel, release on only one of two reasons; show each failing test) with isolated logs in the evidence folder `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/AW1/r1/`.
2. The real-process tests pass on this Mac and leave no `caffeinate` or child process behind (`pgrep` listing before and after, by the pids you started, quoted).
3. The wiring tests pass through the real hook bridge path.
4. Config validation tests cover defaults, a valid override of each option, out-of-range and wrong-type values.
5. `bunx biome check .`, `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests`, `bun run typecheck:signaling`, `bun scripts/third-party-notices.ts --check`, and `typos` on the changed files are clean; `bun test packages/daemon/tests/power` passes.
6. The PR body states what changed, the config options and their defaults, which tests cover each design item, that the real-process tests are macOS-only, what is not verified (a MacBook, lid closed, battery, behavior across an actual system sleep), and uses only "Part of #1773" (never a closing word).

## Gates

`bun test packages/daemon/tests/power` passes; `bunx biome check .` ends with no errors; `bun run typecheck` passes; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; a final `bun test packages/daemon` run (the daemon package) passes, or fails only in tests unrelated to the change, each named in the report.

## Stop conditions

The status funnel or the hook bridge cannot feed the policy without changing the wire or the hub; a test would need a mock that replaces business logic; anything would touch the real hub, a process you did not start, or a power setting.

## Report

The preamble's report, plus one line per acceptance item with the test or command, the config options as shipped, the evidence paths, and the final head after one push.
