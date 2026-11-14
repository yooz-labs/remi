# Keep the Mac awake (level 1, #1773)

What ships in the first slice of ADR 0050, and what does not.
The code is under `packages/daemon/src/power/`: the pure policy (`awake-policy.ts`), the per-session driver (`awake-session.ts`), the caffeinate boundary (`awake-holder.ts`) and the daemon glue (`awake-wiring.ts`).

## What holds and when

On macOS, each session daemon (a `remi --daemon` child of the hub) and each plain wrapper session (`remi` in a terminal) runs `/usr/bin/caffeinate -i -w <its own pid> -t <ttl-seconds>` while its session has real work.
The assertion prevents idle system sleep; the display can still sleep.
The `-w` binding makes macOS release the assertion when that process dies, and a synchronous `exit` listener stops the holder on a normal exit.
There are no SIGINT or SIGTERM listeners: wrapper mode forwards SIGINT to the agent and keeps running.
The hub (`remi serve`) is session-less and holds nothing.
Other platforms do nothing.

Real work is an open Claude turn, a busy status (`thinking`, `executing` or `waiting`), or a pending question.
`UserPromptSubmit` opens a turn even when Claude only reasons and emits no tool call; `Stop`, `StopFailure` and `SessionEnd` close it.
`SessionEnd` also fires on `/clear` and `/resume` while the PTY and the daemon stay alive, so it only closes the turn (the status goes idle) and the next turn holds again.
Only the session's end (PTY exit, registry close, daemon cleanup) ends the hold for good.

These refresh the stuck-state clock: the hook events `PreToolUse`, `PostToolUse` (both including subagents), `UserPromptSubmit`, `Stop`, `StopFailure` and `SessionEnd`, any hook that changes the session status, a change in the pending questions, PTY output, and Codex app-server notifications.
Other hook events do not.

- **Idle grace.** When the work ends, the hold continues for `idle_grace_seconds`; new work inside the grace keeps it.
- **Stuck bound.** A busy status or open turn with no activity for `stuck_busy_minutes` (an Escape-interrupted turn fires no `Stop`) releases the hold, logs once, and drops the stale turn and status: later PTY output does not hold again, only a new turn or busy status does.
- **Question cap.** A pending question holds for at most its configured cap, `question_hold_minutes`.
  While a question is pending, the `waiting` status and the turn it blocks count as the question's, so activity cannot extend the hold past the cap; a `thinking` or `executing` status (a subagent still working, for example) still holds on its own.
  The cap clock starts when the question count goes from zero to nonzero; a question replaced at the same count keeps the clock.
  At the cap the hold ends without an idle grace, and logs once.
- **Renewal.** At 80 percent of `ttl_minutes` (a fixed fraction, not an option) remi starts the next `caffeinate` and stops the previous one a second later, so the assertion does not lapse.
- **caffeinate failures.** A missing or non-executable `/usr/bin/caffeinate` (ENOENT or EACCES on spawn) turns keep-awake off for that session with one log line naming the cause.
  Any other spawn failure or unexpected exit is restarted up to three times (after 0.5, 1 and 2 seconds), logged once, and then left alone until the next time the session starts holding.

## Configuration

The `[awake]` defaults are `level1 = true`, `question_hold_minutes = 30`, `idle_grace_seconds = 120`, `stuck_busy_minutes = 15` and `ttl_minutes = 20`.
Set `level1 = false` to disable the feature.
The other values are positive integers with the bounds written in the generated default config.
Settings apply after a restart.

There is no battery floor in this slice: level 1 holds at any charge.
ADR 0050's `level1_battery_floor_percent` (default 20) arrives with the guard-rails slice; until then it is an unsupported `[awake]` key, which config validation rejects, and that stops every `remi` command at config load.

## What it looks like

The assertion is system-wide.
macOS does not scope idle sleep to remi's processes, so other apps keep running while it is held.
This slice never requests a display assertion, uses `sudo` or changes power settings.
`pmset -g assertions` shows the holder as `pid <caffeinate-pid>(caffeinate): ... PreventUserIdleSystemSleep` with `Created for PID: <session-pid>`.
The daemon log has one line when a hold starts, one when it ends and why, and one per stuck bound, question cap or caffeinate failure, never one per tick.

## Not verified

Level 1 does not implement a lid-closed mode and cannot override lid-close or emergency low-battery sleep.
Not verified by this slice: a MacBook on battery, behavior with the lid closed, and behavior across a real system sleep.
Whether `performance.now()` advances during system sleep is not checked; if it does, the first tick after wake can release a held session as the stuck bound, and the next turn or busy status holds again.
