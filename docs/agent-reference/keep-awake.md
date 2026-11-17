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

## Level 2 building blocks (not wired)

ADR 0050's level 2 (lid-closed mode) has pure building blocks under `packages/daemon/src/power/`, and **nothing calls them yet**: no hub, command or configuration reads them, and they run nothing, read no file and change no power setting.
Later slices are to wire them (the hub's controller, then the hub and the configuration, then the `remi keep-awake` command); none of those exists yet.

### The policy, its settings and the foreign-holder rule

- `level2-settings.ts`: `Level2Settings` (named after the `[awake]` keys), `LEVEL2_DEFAULTS` and `validateLevel2Settings`.
- `level2-policy.ts`: the reducer `stepLevel2Policy(settings, state, event, at)`, which returns `{ state, effects, nextDeadline }` like level 1's, plus `initialLevel2State`, `level2Status` and `level2Persisted`.
- `level2-foreign-holders.ts`: `classifyForeignHolders`, ADR 0050's foreign-holder rule.

**No key below is accepted by `config.toml` yet.**
An `[awake]` line naming one of them is an unsupported key today, which stops every `remi` command at config load; L2-HUB adds all of them in one commit.

Validation is sanity only (the owner's rule of 2026-11-17, Q15 (a)): the type; positive, or 0 where 0 turns the rule off; a percent from 0 to 100; and two required relations (`level2_revert_battery_percent` below `level2_start_battery_percent`; `thermal_revert_level` at or above `thermal_refuse_level`).
No key has a maximum.
A duration that becomes a timer's delay or a deadline (`heartbeat_seconds`, `watchdog_interval_seconds`, `watchdog_command_deadline_seconds` and every `_ms` deadline) must fit a timer, at most 2147483647 ms (about 24.8 days); the policy's own durations are only compared with clocks at each beat, so for them the value in milliseconds only has to be finite.
`nextDeadline` is never more than one `heartbeat_seconds` away while level 2 needs beats, so no timer waits longer than that.
Where a value is unwise, `validateLevel2Settings` returns a warning and the value is used; nothing prints the warnings yet (L2-HUB is to print them at config load and keep them for `remi keep-awake status`).
Errors and warnings name the key and the rule, never an entry of `foreign_holder_ignore`.
A key that is not a level 2 setting (level 1's, for example) is ignored here; a missing level 2 key is an error.

| Key | Default | Sanity rule | Warning when |
| --- | --- | --- | --- |
| `level2` | `false` | boolean | |
| `level2_start_battery_percent` | `35` | percent | less than 5 above the revert percent |
| `level2_revert_battery_percent` | `30` | percent, below the start percent | below 10 (emergency low-battery sleep with sleep disabled is unverified) |
| `level2_min_remaining_minutes` | `20` | integer, 0 turns it off | |
| `level2_default_hours` | `3` | positive number, decimals allowed | above `level2_cap_hours` |
| `level2_cap_hours` | `12` | positive number | at or above `level2_window_hours` |
| `level2_window_hours` | `24` | positive number | |
| `level2_idle_revert_minutes` | `30` | positive integer | |
| `thermal_refuse_level` | `"moderate"` | `moderate`, `heavy` or `trapping` | |
| `thermal_revert_level` | `"heavy"` | the same, at or above the refuse level | |
| `thermal_moderate_revert_minutes` | `5` | positive integer | |
| `heartbeat_seconds` | `30` | positive integer, fits a timer | above 300 |
| `lease_stale_seconds` | `120` | positive integer | below twice `heartbeat_seconds` |
| `watchdog_interval_seconds` | `60` | positive integer, fits a timer | |
| `foreign_holder_revert_minutes` | `2` | positive integer | |
| `foreign_holder_ignore` | `[]` | non-empty strings without control characters | |
| `require_password_on_wake` | `true` | boolean | `false` |
| `level2_resume_dwell_seconds` | `120` | integer, 0 turns it off | 0 |
| `level2_resume_min_interval_minutes` | `10` | integer, 0 turns it off | 0 |
| `level2_max_resumes_per_day` | `12` | integer; 0 means only an explicit start turns level 2 on | |
| `level2_breaker_failures` | `3` | positive integer | |
| `level2_wake_gap_seconds` | `90` | positive integer | at or below `heartbeat_seconds` |
| `clock_skew_tolerance_seconds` | `60` | integer, 0 allowed | |
| `switch_deadline_ms` | `5000` | positive integer, fits a timer | |
| `switch_sync_deadline_ms` | `3000` | positive integer, fits a timer | |
| `shutdown_budget_ms` | `3000` | positive integer, fits a timer | at or above the time `remi stop` waits before SIGKILL (5000 ms, or the `stopWaitMs` the caller passes) |
| `status_file_max_bytes` | `65536` | positive integer | |
| `process_start_time_deadline_ms` | `2000` | positive integer, fits a timer | |
| `lease_max_bytes` | `4096` | positive integer | below 1024 |
| `lease_start_time_max_length` | `64` | positive integer | |
| `endpoint_body_max_bytes` | `4096` | positive integer | |
| `endpoint_read_deadline_ms` | `2000` | positive integer, fits a timer | |
| `cli_request_timeout_ms` | `5000` | positive integer, fits a timer | |
| `watchdog_command_deadline_seconds` | `10` | positive integer, fits a timer | at or above `watchdog_interval_seconds` |
| `lease_integer_max_digits` | `16` | positive integer | above 18 (the watchdog's shell arithmetic overflows at 19 digits) |
| `sudoers_user_max_length` | `32` | positive integer | |

The reducer reads the policy keys and `clock_skew_tolerance_seconds`; `lease_stale_seconds`, `watchdog_interval_seconds` and the mechanism keys are only validated here, for the slices that will read them.

**States.**
`disabled` (`level2` false); `armed` (off, waiting for work); `paused` (off, a condition prevents it); `starting`; `on`; `reverting`; `disarmed` (off until a person runs `arm` or `start`).
`initialLevel2State` gives `disabled` when `level2` is false, `disarmed` with `restart` when the persisted state says disarmed or is malformed, the previous hub did not record a clean exit, a lease was found or the flag does not read `no` (Q12 (b)), and otherwise `armed`, the very first run included.

**Turning on.**
On a beat while `armed` or `paused`, the first condition that holds, in this order, keeps level 2 off: `no-session`, `no-work`, `flag-unknown`, `sleep-disabled-by-other`, `no-battery` (Q3), `battery-unknown`, `battery-low` and `battery-time-low` (on battery power only, Q2), `thermal-unknown`, `thermal`, `assertions-unknown`, `foreign-holder`, `password-on-wake-unknown` and `password-on-wake-off` (only when `require_password_on_wake`), `watchdog-unknown`, `watchdog-missing`, `watchdog-mismatch`, `daily-cap` (less on-time left under the cap than the minimum interval), then for an automatic start only `lid-closed` (the lid not reported `open`, Q13), `resume-interval` and `dwell`.
`no-session` and `no-work` leave it `armed`; any other condition makes it `paused` with that condition, and the condition shown changes as the readings change (one log line per change, never per beat).
The dwell counts from the first beat at which every condition but the minimum interval is clear, the lid open included (the two run side by side), and restarts on any blocked beat and on a beat more than `level2_wake_gap_seconds` after the previous one by the wall clock or the monotonic clock (a wake from sleep).
An automatic start that passes but would exceed `level2_max_resumes_per_day` in `level2_window_hours` disarms with `resume-limit` instead.
An explicit `start` (which also arms, clearing the counters, from `disarmed`) skips `no-work`, the lid, the interval and the dwell; when a condition blocks it, the state is `paused` with that condition (or `armed` with `no-session`), a `blocked` effect names the condition, and level 2 then resumes by itself under the automatic rules.
A run ends `level2_default_hours` (or the start's hours) later, never past the on-time left under `level2_cap_hours`.

**Pausing.**
While `on`, each of these reverts (a `disable` effect, state `reverting`) and then pauses: `run-limit`, `daily-cap` (the cap cut the run), `no-battery`, `battery-unknown`, `battery-low` (at or below the revert percent on battery power), `battery-time-low`, `thermal-unknown`, `thermal` (at or above the revert level), `thermal-moderate-held`, `assertions-unknown` and `foreign-holder` (present for `foreign_holder_revert_minutes`; the first beat that sees it emits one `notify` with process names only), `watchdog-missing`, `watchdog-mismatch`, `watchdog-unknown`, `flag-unknown` and `heartbeat-failed`; `idle` (no work for `level2_idle_revert_minutes`) and `no-session` return to `armed` instead.
`no-battery` while on (a battery that is no longer reported) also pauses, failing toward sleep.
A running level 2 stays on when the lid closes, and the password setting is checked only when turning on.
`lease-write-failed` from the controller pauses without a revert, since no switch call happened.
A `disable-failed` keeps `reverting`, and every later beat emits `disable` again.

**Only a person ends it** (`disarmed`): `stopped`, `flag-cleared-by-other` (the flag read `no` while on: a `forget` effect, never `disable`), `switch-failed`, `revert-not-permitted` and `sudo-refused` (never retried by itself), `resume-limit`, `breaker` (`level2_breaker_failures` failures in the window: `heartbeat-failed`, `lease-write-failed`, `flag-unknown` and `watchdog-mismatch` while on, `disable-failed`; the current revert finishes first) and `restart`.
`arm` clears the failure and resume counters; it is refused with `disabled` while `level2` is false.
`extend` while `on` moves the run's end later, never past the on-time left under the cap (`cutByCap` says when the cap cut it).
Other refusals: `hours-invalid`, `not-on`, `already-on`, `reverting` and `exiting`.
`hub-exit` while `starting`, `on` or `reverting` emits `disable` and records the clean exit only after the revert; otherwise it records it at once.

**Clocks and the state file.**
Timers use the monotonic clock, clamped to the last observed value; the window counters use the wall clock, and a recorded time more than `clock_skew_tolerance_seconds` in the future counts as now, so a backward clock step keeps a counted resume or failure for at least a full window.
Every transition emits `persist` with `{ armed, disarmReason, cleanExit, resumes, failures, runs }`, which the controller (L2-CORE, not written yet) is to write to `REMIHOME/keep-awake/state.json`; `runs` includes the run in progress, so it changes at every beat while on and a crash cannot drop its on-time.
A step's effects come in this order: `persist`, then `log`, then the actions (`enable`, `disable`, `forget`, ...), so a counted resume reaches the state file before the switch is called.
An automatic start is counted when its `enable` is emitted, so an attempt that fails also counts.
`level2Status` gives the state, the reason, the origin, the run's end, the on-time and automatic starts left in the window, the failures in it, and `waitingFor`, for example `battery at 35 percent or AC power`, `lid open` or `2 minutes without a blocking condition`.

**The foreign-holder rule.**
A holder is remi's when its pid or the pid it was created for is one of remi's.
powerd's `PreventUserIdleSystemSleep` named `Prevent sleep while display is on` is exempt only when the process, the type and the name all match.
`PreventUserIdleDisplaySleep` and `NoDisplaySleepAssertion` always block; `PreventSystemSleep`, `PreventUserIdleSystemSleep` and `NoIdleSleepAssertion` block unless the process name is in `foreign_holder_ignore` (exact, case-sensitive), and are then listed as ignored; every other type is ignored.
The result carries process names only, never an assertion's name.

**How it is tested.**
`packages/daemon/tests/power/level2-settings.test.ts`, `level2-policy.test.ts` and `level2-foreign-holders.test.ts` drive the real validator, reducer and classifier; the reducer tests acknowledge each `enable` and `disable` effect the way the controller will, and nothing is spawned.

## Not verified

Level 1 does not implement a lid-closed mode and cannot override lid-close or emergency low-battery sleep.
Not verified by this slice: a MacBook on battery, behavior with the lid closed, and behavior across a real system sleep.
Whether `performance.now()` advances during system sleep is not checked; if it does, the first tick after wake can release a held session as the stuck bound, and the next turn or busy status holds again.
