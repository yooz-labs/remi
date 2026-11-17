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

## Readings for later slices

`packages/daemon/src/power/readings/` holds three readers and their pure parsers for the guard-rails slice (#1773, ADR 0050).
Nothing calls them yet: level 1 does not read any of them, and no setting or message mentions them.

- `readAssertions()` runs `pmset -g assertions` and returns the system-wide assertion counts and each holder (`pid`, process, type, name, and the `Created for PID` target when present).
  Any line in the owning-process block that the grammar does not know makes the whole reading `unknown`, never a skipped line; the reason names the line number, not its text, because assertion names can carry application or document names.
- `readThermal()` runs `notifyutil -g com.apple.system.thermalpressurelevel` and maps 0 to 4 to nominal, moderate, heavy, trapping and sleeping; anything else is `unknown`.
- `readRootDomain()` runs `ioreg -r -c IOPMrootDomain -d 1` and returns `SleepDisabled` (yes, no or unknown) and the lid (`AppleClamshellState`: open, closed, absent when the key is not listed, or unknown).

All three go through `runReading` (`run-reading.ts`), which runs only the exact invocations of `isReadOnlyInvocation`: `pmset -g` with at most one of `assertions`, `batt`, `therm` or `ps`; `ioreg -r -c IOPMrootDomain -d 1` (or the same with `AppleSmartBattery`); and `notifyutil -g com.apple.system.thermalpressurelevel`.
Anything else is `refused` without a spawn, and a test asserts the refusal of `pmset sleepnow`, `displaysleepnow`, `-a disablesleep`, `notifyutil -p` and `-s` on the pure predicate, never by running them.
Those invocations only read, which is what keeps a reading from changing power state.
`spawnBounded` under it is not guarded and runs whatever it is given, so every later entry point must go through `runReading` or the predicate.
Each run has no shell, no stdin, an environment of `LC_ALL=C` and `PATH` only, and a failure never throws.
Every number is an option of `spawnBounded` (and, through `SpawnBoundedOptions`, of each reader) whose default is an exported constant:
`DEFAULT_TIMEOUT_MS` (2000, the deadline), `DEFAULT_MAX_STDOUT_BYTES` (262144), `DEFAULT_MAX_STDERR_BYTES` (65536, kept only with `captureStderr`) and `DEFAULT_KILL_GRACE_MS` (500, the wait after the kill).
Nothing reads them from configuration yet; G2 makes them `[awake]` settings (`reading_deadline_ms`, `reading_stdout_max_bytes`, `reading_stderr_max_bytes`, `reading_kill_grace_ms`).
The child leads its own process group, and a timeout or oversize kill reaches the group (a wrapper shell's children too).
The parsers are tested against redacted captures of a Mac16,11 (`packages/daemon/tests/power/fixtures/mac16-11-macos-27.2/`, with its `SOURCE.md`).
Both text parsers need the end of the output: the assertions reading is unknown unless the `Kernel Assertions:` header was seen, and the root-domain reading is unknown unless the property block's closing brace was.
`absent` for the lid means the key is not listed in a complete read; it is not proof that the Mac has no lid.
A thermal `nominal` is not proof of health: `notifyutil -g` prints 0 for a notification nobody posted, and `pmset -g therm` cannot cross-check it (a healthy Mac and a dead key both read "No thermal warning level has been recorded"; the text of a recorded warning is UNVERIFIED), so a caller treats `nominal` as "no pressure reported" and only a level above it as a signal.
Not verified: the lid reading on a laptop (the capture is a Mac mini; the `clamshell` fixtures are edited, not captured), that every Mac prints the `Kernel Assertions:` header, and the assertions text on other macOS builds.
Battery (`pmset -g batt`) and the password-on-wake reading are later slices.

## Level 2 building blocks (not wired)

### The policy, its settings and the foreign-holder rule

ADR 0050's level 2 (lid-closed mode) has pure building blocks under `packages/daemon/src/power/`, and **nothing calls them yet**: no hub, command or configuration reads them, and they run nothing, read no file and change no power setting.
Later slices are to wire them (the hub's controller, then the hub and the configuration, then the `remi keep-awake` command); none of those exists yet.

- `level2-settings.ts`: `Level2Settings` (named after the `[awake]` keys), `LEVEL2_DEFAULTS` and `validateLevel2Settings`.
- `level2-policy.ts`: the reducer `stepLevel2Policy(settings, state, event, at)`, which returns `{ state, effects, nextDeadline }` like level 1's, plus `initialLevel2State`, `level2Status` and `level2Persisted`.
- `level2-foreign-holders.ts`: `classifyForeignHolders`, ADR 0050's foreign-holder rule.

**No key below is accepted by `config.toml` yet.**
An `[awake]` line naming one of them is an unsupported key today, which stops every `remi` command at config load; L2-HUB adds all of them in one commit.

Validation is sanity only (the owner's rule of 2026-11-17, Q15 (a)): the type; positive, or 0 where 0 turns the rule off; a percent from 0 to 100; and two required relations (`level2_revert_battery_percent` below `level2_start_battery_percent`; `thermal_revert_level` at or above `thermal_refuse_level`).
No key has a maximum, and no key has a timer ceiling: a duration (any key with a unit) only needs its value in milliseconds to be a safe integer (at most `Number.MAX_SAFE_INTEGER`), which says the number can be represented, not how large it may be.
A timer armed from one of these settings is to go through a helper that chains delays longer than a single `setTimeout` can wait (`power/long-timeout.ts`, planned with G2; not in this slice).
The hours keys (`level2_default_hours`, `level2_cap_hours`, `level2_window_hours`) must also be representable as a time: the current time plus the value must fit a JavaScript `Date` (epoch second 8640000000000) and an integer of `lease_integer_max_digits` digits; when those digits cannot hold the current time at all, a warning says so and only the `Date` bound applies.
`nextDeadline` is never more than one `heartbeat_seconds` away while level 2 needs beats (a design note: the rules themselves are checked at each beat).
Where a value is unwise, `validateLevel2Settings` returns a warning and the value is used; nothing prints the warnings yet (L2-HUB is to print them at config load and keep them for `remi keep-awake status`).
Errors and warnings name the key and the rule, never an entry of `foreign_holder_ignore`.
A key that is not a level 2 setting (level 1's, for example) is ignored here; a missing level 2 key is an error.

The "Setting" column says how each key will be set once L2-HUB supports it in `config.toml`; today none of these lines is accepted (see above).

| Key | Setting (once L2-HUB supports it) | Sanity rule | Warning when |
| --- | --- | --- | --- |
| `level2` | default `false`; set `level2 = true` to change | boolean |  |
| `level2_start_battery_percent` | default `35`; set `level2_start_battery_percent = 40` to change | percent | less than 5 above the revert percent (with the default revert 30: below 35) |
| `level2_revert_battery_percent` | default `30`; set `level2_revert_battery_percent = 25` to change | percent, below the start percent | below 10 (emergency low-battery sleep with sleep disabled is unverified) |
| `level2_min_remaining_minutes` | default `20`; set `level2_min_remaining_minutes = 30` to change | integer, 0 turns it off; duration |  |
| `level2_default_hours` | default `3`; set `level2_default_hours = 2.5` to change | positive number, decimals allowed; representable as a time | above `level2_cap_hours` (12 by default) |
| `level2_cap_hours` | default `12`; set `level2_cap_hours = 8` to change | positive number; representable as a time | at or above `level2_window_hours` (24 by default) |
| `level2_window_hours` | default `24`; set `level2_window_hours = 48` to change | positive number; representable as a time |  |
| `level2_idle_revert_minutes` | default `30`; set `level2_idle_revert_minutes = 60` to change | positive integer; duration |  |
| `thermal_refuse_level` | default `"moderate"`; set `thermal_refuse_level = "heavy"` to change | `moderate`, `heavy` or `trapping` |  |
| `thermal_revert_level` | default `"heavy"`; set `thermal_revert_level = "trapping"` to change | the same, at or above the refuse level |  |
| `thermal_moderate_revert_minutes` | default `5`; set `thermal_moderate_revert_minutes = 10` to change | positive integer; duration |  |
| `heartbeat_seconds` | default `30`; set `heartbeat_seconds = 15` to change | positive integer; duration | above 300 |
| `lease_stale_seconds` | default `120`; set `lease_stale_seconds = 180` to change | positive integer; duration | below twice `heartbeat_seconds` (60 at the default heartbeat of 30) |
| `watchdog_interval_seconds` | default `60`; set `watchdog_interval_seconds = 120` to change | positive integer; duration |  |
| `foreign_holder_revert_minutes` | default `2`; set `foreign_holder_revert_minutes = 5` to change | positive integer; duration |  |
| `foreign_holder_ignore` | default `[]`; set `foreign_holder_ignore = ["ChatApp"]` to change | non-empty strings without control characters |  |
| `require_password_on_wake` | default `true`; set `require_password_on_wake = false` to change | boolean | `false` |
| `level2_resume_dwell_seconds` | default `120`; set `level2_resume_dwell_seconds = 300` to change | integer, 0 turns it off; duration | 0 |
| `level2_resume_min_interval_minutes` | default `10`; set `level2_resume_min_interval_minutes = 20` to change | integer, 0 turns it off; duration | 0 |
| `level2_max_resumes_per_day` | default `12`; set `level2_max_resumes_per_day = 6` to change | integer; 0 means only an explicit start turns level 2 on |  |
| `level2_breaker_failures` | default `3`; set `level2_breaker_failures = 5` to change | positive integer |  |
| `level2_wake_gap_seconds` | default `90`; set `level2_wake_gap_seconds = 120` to change | positive integer; duration | at or below `heartbeat_seconds` (30 at the default) |
| `clock_skew_tolerance_seconds` | default `60`; set `clock_skew_tolerance_seconds = 120` to change | integer, 0 allowed; duration |  |
| `switch_deadline_ms` | default `5000`; set `switch_deadline_ms = 8000` to change | positive integer; duration |  |
| `switch_sync_deadline_ms` | default `3000`; set `switch_sync_deadline_ms = 4000` to change | positive integer; duration |  |
| `shutdown_budget_ms` | default `3000`; set `shutdown_budget_ms = 2000` to change | positive integer; duration | at or above the time `remi stop` waits before SIGKILL (5000 ms by default; the caller passes its value as `stopWaitMs`) |
| `status_file_max_bytes` | default `65536`; set `status_file_max_bytes = 131072` to change | positive integer |  |
| `process_start_time_deadline_ms` | default `2000`; set `process_start_time_deadline_ms = 3000` to change | positive integer; duration |  |
| `lease_max_bytes` | default `4096`; set `lease_max_bytes = 8192` to change | positive integer | below 1024 |
| `lease_start_time_max_length` | default `64`; set `lease_start_time_max_length = 80` to change | positive integer |  |
| `endpoint_body_max_bytes` | default `4096`; set `endpoint_body_max_bytes = 8192` to change | positive integer |  |
| `endpoint_read_deadline_ms` | default `2000`; set `endpoint_read_deadline_ms = 3000` to change | positive integer; duration |  |
| `cli_request_timeout_ms` | default `5000`; set `cli_request_timeout_ms = 10000` to change | positive integer; duration |  |
| `watchdog_command_deadline_seconds` | default `10`; set `watchdog_command_deadline_seconds = 20` to change | positive integer; duration | at or above `watchdog_interval_seconds` (60 at the default) |
| `lease_integer_max_digits` | default `16`; set `lease_integer_max_digits = 12` to change | positive integer | above 18 (the watchdog's shell arithmetic overflows at 19 digits), or too few to hold the current time in epoch seconds |
| `sudoers_user_max_length` | default `32`; set `sudoers_user_max_length = 40` to change | positive integer |  |

The reducer reads the policy keys, `clock_skew_tolerance_seconds`, `switch_deadline_ms` and `switch_sync_deadline_ms` (the bound on `starting`) and `lease_integer_max_digits` (the latest end a run can have); `lease_stale_seconds`, `watchdog_interval_seconds` and the other mechanism keys are only validated here, for the slices that will read them.

**States.**
`disabled` (`level2` false); `armed` (off, waiting for work); `paused` (off, a condition prevents it); `starting`; `on`; `reverting`; `disarmed` (off until a person runs `arm` or `start`).
`initialLevel2State` gives `disabled` when `level2` is false, `disarmed` with `restart` when the persisted state says disarmed or is malformed, the previous hub did not record a clean exit, a lease was found or the flag does not read `no` (Q12 (b)), and otherwise `armed`, the very first run included.

**Turning on.**
On a beat while `armed` or `paused`, the first condition that holds, in this order, keeps level 2 off: `no-session`, `no-work`, `flag-unknown`, `sleep-disabled-by-other`, `no-battery` (Q3), `battery-unknown`, `battery-low` and `battery-time-low` (on battery power only, Q2), `thermal-unknown`, `thermal`, `assertions-unknown`, `foreign-holder`, `password-on-wake-unknown` and `password-on-wake-off` (only when `require_password_on_wake`), `watchdog-unknown`, `watchdog-missing`, `watchdog-mismatch`, `daily-cap` (less on-time left under the cap than the minimum interval), then for an automatic start only `lid-closed` (the lid not reported `open`, Q13), `resume-interval` and `dwell`.
`no-session` and `no-work` leave it `armed`; any other condition makes it `paused` with that condition, and the condition shown changes as the readings change (one log line per change, never per beat).
The dwell counts from the first beat at which every condition but the minimum interval is clear, the lid open included (the two run side by side), and restarts on any blocked beat and on a beat more than `level2_wake_gap_seconds` after the previous one by the wall clock or the monotonic clock (a wake from sleep).
An automatic start that passes but would exceed `level2_max_resumes_per_day` in `level2_window_hours` disarms with `resume-limit` instead.
An explicit `start` (which also arms, clearing the counters, from `disarmed`) skips `no-work`, the lid, the interval and the dwell; when a condition blocks it, the state is `paused` with that condition (or `armed` with `no-session`), a `blocked` effect names the condition, and level 2 then resumes by itself under the automatic rules.
A run ends `level2_default_hours` (or the start's hours) later, never past the on-time left under `level2_cap_hours`, and never past the latest time a `Date` and the lease's integers can hold.
After a `thermal-moderate-held` pause, an automatic resume waits until the level is below `moderate`, whatever `thermal_refuse_level` says (otherwise, with `thermal_refuse_level = "heavy"`, it would resume at moderate and pause again after `thermal_moderate_revert_minutes`, in a loop); `waitingFor` then says `thermal pressure below moderate`.
`level2_resume_min_interval_minutes` counts from every completed revert, including an `idle` or `no-session` return to `armed`, so it also delays the first automatic start after such a return.

**Pausing.**
While `on`, each of these reverts (a `disable` effect, state `reverting`) and then pauses: `run-limit`, `daily-cap` (the cap cut the run), `no-battery`, `battery-unknown`, `battery-low` (at or below the revert percent on battery power), `battery-time-low`, `thermal-unknown`, `thermal` (at or above the revert level), `thermal-moderate-held`, `assertions-unknown` and `foreign-holder` (present for `foreign_holder_revert_minutes`; the first beat that sees it emits one `notify` with process names only), `watchdog-missing`, `watchdog-mismatch`, `watchdog-unknown`, `flag-unknown`, `heartbeat-failed` and (from `starting`) `enable-timeout`; `idle` (no work for `level2_idle_revert_minutes`) and `no-session` return to `armed` instead.
`no-battery` while on (a battery that is no longer reported) also pauses, failing toward sleep.
A running level 2 stays on when the lid closes, and the password setting is checked only when turning on.
`lease-write-failed` from the controller pauses without a revert, since no switch call happened.
`starting` is bounded: if the controller has not answered an `enable` with `enabled` or `enable-failed` within `switch_deadline_ms` plus `switch_sync_deadline_ms` (8000 ms by default), the next beat or census reverts with `enable-timeout`, a breaker failure, and pauses; a beat while `starting` also reverts on an unreadable flag (`flag-unknown`) or at the run's end.
An `enabled` that arrives during that revert still counts the on-time.
A `disable-failed` keeps `reverting`, and every later beat emits `disable` again.

**Only a person ends it** (`disarmed`): `stopped`, `flag-cleared-by-other` (the flag read `no` while on: a `forget` effect, never `disable`), `switch-failed`, `revert-not-permitted` and `sudo-refused` (never retried by itself), `resume-limit`, `breaker` (`level2_breaker_failures` failures in the window: `heartbeat-failed`, `lease-write-failed`, `enable-timeout`, `flag-unknown` while starting or on, `watchdog-mismatch` while on, and `disable-failed`; the current revert finishes first, and at most `level2_breaker_failures` failures are kept) and `restart`.
`arm` clears the failure and resume counters; it is refused with `disabled` while `level2` is false.
`extend` while `on` moves the run's end later, never past the on-time left under the cap (`cutByCap` says when the cap cut it).
Other refusals: `hours-invalid`, `not-on`, `already-on`, `reverting` and `exiting`.
`hub-exit` while `starting`, `on` or `reverting` emits `disable` and records the clean exit only after the revert; otherwise it records it at once.

**Clocks and the state file.**
Timers use the monotonic clock, clamped to the last observed value; the window counters use the wall clock, and a recorded time more than `clock_skew_tolerance_seconds` in the future counts as now, so a backward clock step keeps a counted resume or failure for at least a full window.
Every transition emits `persist` with `{ armed, disarmReason, cleanExit, resumes, failures, runs }`, and so does every beat while `starting`, `on` or `reverting`; the controller (L2-CORE, not written yet) is to write it to `REMIHOME/keep-awake/state.json`.
`runs` includes the run in progress up to the last beat, so a crash loses at most one heartbeat of on-time.
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

### The root boundary, the lease and the watchdog

ADR 0050's level 2 (lid-closed mode, option A) has three modules under `packages/daemon/src/power/`, and **nothing runs, prints or installs any of them yet**: no code calls them, remi runs no `sudo`, changes no power setting, writes no lease, and installs no sudoers file, LaunchDaemon, LaunchAgent or watchdog script.
Later slices wire them (the hub's controller, then the `remi keep-awake` command, which does not exist yet).

- `level2-commands.ts`, the root boundary: the absolute paths (`/usr/bin/sudo`, `/usr/bin/pmset`, `/usr/sbin/ioreg`, `/usr/bin/plutil`, `/bin/ps`, `/bin/date`, `/bin/launchctl`), the `pmset` arguments that set and clear the flag, the `sudo -n` and `sudo -n -l` argument builders, the sudoers line, the boot LaunchDaemon and watchdog LaunchAgent property lists, and the owner's setup and removal texts.
  It is the only file under `packages/daemon/src` with a string literal that names `/usr/bin/sudo` or the `pmset` keyword for the flag (a test that reads the literals with the TypeScript compiler; comments do not count, and `readings/root-domain.ts` mentions the keyword in one), and the printed texts are built from the same constants as the commands remi will run.
- `level2-lease.ts`, the lease at `REMIHOME/keep-awake/lease.json`.
- `watchdog-script.ts`, the generated POSIX `sh` watchdog.

### Every number is an option

Each module takes every number as an option whose default is an exported constant; nothing reads the configuration yet, and the `[awake]` keys that set these values arrive with the hub and command slices (L2-HUB, L2-CLI).
Each must be a positive integer and none has a maximum.

| Option | Default constant | Default | Where |
|---|---|---|---|
| `maxLength` (`userMaxLength` in `setupText`) | `DEFAULT_SUDOERS_USER_MAX_LENGTH` | 32 | `isSafeShortName`, `sudoersLine`, `setupText` |
| `maxBytes` | `DEFAULT_LEASE_MAX_BYTES` | 4096 | `readLease` |
| `startTimeMaxLength` | `DEFAULT_START_TIME_MAX_LENGTH` | 64 | `readLease`, `validateLease`, `writeLease` |
| `timeoutMs` | `DEFAULT_PROCESS_START_TIME_TIMEOUT_MS` | 2000 | `processStartTime` |
| `commandDeadlineSeconds` | `DEFAULT_WATCHDOG_COMMAND_DEADLINE_SECONDS` | 10 | `buildWatchdogScript` |
| `killGraceSeconds` | `DEFAULT_WATCHDOG_KILL_GRACE_SECONDS` | 1 | `buildWatchdogScript` |
| `pollIntervalMs` | `DEFAULT_WATCHDOG_POLL_INTERVAL_MS` | 20 | `buildWatchdogScript` |
| `runLimitSeconds` | `DEFAULT_WATCHDOG_RUN_LIMIT_SECONDS` | 45 | `buildWatchdogScript` |
| `integerMaxDigits` | `DEFAULT_LEASE_INTEGER_MAX_DIGITS` | 16 | `buildWatchdogScript` |
| `revertFailureMarkerThreshold` | `DEFAULT_REVERT_FAILURE_MARKER_THRESHOLD` | 3 | `buildWatchdogScript` |
| `failureLogIntervalSeconds` | `DEFAULT_FAILURE_LOG_INTERVAL_SECONDS` | 3600 | `buildWatchdogScript` |
| `revertErrorMaxChars` | `DEFAULT_REVERT_ERROR_MAX_CHARS` | 200 | `buildWatchdogScript` |
| `orphanMaxAgeSeconds` | `DEFAULT_ORPHAN_MAX_AGE_SECONDS` | 300 | `buildWatchdogScript` |
| `invalidLeaseMaxAgeMinutes` | `DEFAULT_INVALID_LEASE_MAX_AGE_MINUTES` | 5 | `buildWatchdogScript` |

`fallbackWorkParent` (`DEFAULT_FALLBACK_WORK_PARENT`, `/private/tmp`) is a path, not a number.
The user name's character class, `^[a-z_][a-z0-9_-]*$`, is fixed: it keeps spaces, commas, `ALL` and every other sudoers syntax out at any length.

### What the owner installs

The boot LaunchDaemon first, then the sudoers line, for a user whose short name matches the class above and is at most 32 characters long by default (any other name is refused):

```
<user> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0
```

It goes in `/etc/sudoers.d/remi-keep-awake`, mode 0440, owner root, group wheel.
Do not widen it: sudoers matches listed arguments exactly, and a rule naming `/usr/bin/pmset` with no arguments allows any arguments, among them `hibernatefile`, `tcpkeepalive 0` (breaks Find My Mac), `schedule`, `autorestart` and `restoredefaults` (ADR 0050, option A).

What the rule exposes, said in the setup text too: once it is installed, any process running as the person, including coding agents started by remi, can keep the Mac awake with the lid closed, without a lease or a battery limit.
remi's lease and watchdog are crash safety, not a barrier.
The rule grants no root access beyond those two `pmset` commands.

The boot LaunchDaemon, `/Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist` (mode 0644, root, wheel), clears the flag once at boot, before any login (owner decision 1); `sudo plutil -p` on it prints:

```
{
  "Label" => "com.yooz.remi.keep-awake-boot"
  "ProgramArguments" => [
    0 => "/usr/bin/pmset"
    1 => "-a"
    2 => "disablesleep"
    3 => "0"
  ]
  "RunAtLoad" => true
}
```

The setup text (`setupText`) stages both files only in a directory that root creates with `sudo mktemp -d /private/tmp/remi-keep-awake.XXXXXX` (mode 0700 inside the sticky `/private/tmp`), and writes them there with `sudo tee` from quoted here-documents.
Every staged path is written `"${D:?}/NAME"`, so a failed `mktemp` line (an empty `D`) stops the command instead of naming a file in `/`.
The boot daemon comes first, because the rule is what makes level 2 possible: an unload of an older copy (on a first install it reports that the service is not loaded, which is expected), then one chained command `plutil -lint ... && install ... && launchctl bootstrap system ...` (loading runs it once and only clears the flag).
The rule follows as `launchctl print system/com.yooz.remi.keep-awake-boot >/dev/null && visudo -cf ... && install ...`, so it goes in only while the boot daemon is loaded, even when the whole text is pasted after a failed step 2; the text tells the person to stop and run the removal steps if `visudo` prints anything but "parsed OK", or if any step fails.
Then it removes the staging directory and checks the rule: `sudo -k` (so no cached password helps), plain `sudo -n -l`, which must list `(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0`, `sudo -n -l` for each command, `sudo -k` again and `sudo -n /usr/bin/pmset -a disablesleep 0`, which must finish without a password prompt.
What these checks show: the rule is installed, sudo reads it, and the revert runs as root with no password.
What they do not show: that the enable runs without a password (running it would set the flag), anything about the lid or the battery, or what other rules on the Mac allow (the listing shows them; the person reads it).
Last, it prints the installed files and `sudo launchctl print system/com.yooz.remi.keep-awake-boot` for the person to compare with this page.
The setup text ends with the removal text under "If any step failed, run these removal steps:".
The removal text (`removalText`) starts with `remi keep-awake stop` and a check that `ioreg` reads `"SleepDisabled" = No`, removes the sudoers file, the boot daemon, the watchdog agent and its script, and ends with the owner's own `sudo /usr/bin/pmset -a disablesleep 0`.

### The lease

`REMIHOME/keep-awake/lease.json`, the directory mode 0700, the file mode 0600, written through a temporary file in the same directory, `fsync` and `rename`, so a reader sees the previous lease or the new one.
Version 1 has exactly the keys `version`, `hubPid`, `hubStartTime`, `startedAt`, `expiresAt`, `heartbeatAt` (integer epoch seconds), `staleSeconds` and `revertBatteryPercent` (copied from the configuration, so the watchdog parses none).
`hubStartTime` is `LC_ALL=C TZ=UTC0 ps -o lstart= -p PID`, trimmed: `ps` prints local time, and a time-zone change while traveling must not make a live hub look gone.
`readLease` calls a lease invalid, with a reason, for an extra or missing key, a wrong type, a non-integer, a value out of range (`hubPid` and `staleSeconds` below 1, a negative time, `revertBatteryPercent` above 100, an empty, padded, multi-line or over-long `hubStartTime`), a version other than 1, unparsable JSON, more than `maxBytes`, a symlink, a file that is not regular, or a file the current user does not own; `writeLease` refuses to write a lease the reader would call invalid.
The lease is crash safety, not a security boundary: any process of the same user can delete or rewrite it.

### The watchdog script

`buildWatchdogScript({ remiHome })` returns the script a user LaunchAgent (`watchdogPlist`, label `com.yooz.remi.keep-awake-watchdog`) will run with `/bin/sh`; the planned paths are `REMIHOME/keep-awake/watchdog.sh` and `REMIHOME/keep-awake/watchdog.log`.
It sets `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `LC_ALL=C` and `TZ=UTC0`, and uses no `jq` and no `timeout`.
Each command that reads state or changes the lease runs in a wrapper subshell that writes the command's status to a file in a private work directory, which the script polls every `pollIntervalMs`.
At `commandDeadlineSeconds` the command is killed; after `killGraceSeconds` more the script gives up on it without waiting, so a child stuck in the kernel stays behind as an orphan and the run goes on (launchd does not start a job that is still running, so one hung run would stop every later one).
A run that lasts `runLimitSeconds` stops, logs `run exceeded N s` and counts as a failure.
The deadline, the grace and the run limit are sleeping timers that create a file the poll looks for, so they are wall-clock time whatever the load; counting poll intervals instead stretched a 10 s deadline to 14.3 to 14.8 s at a load average of 9 to 13 on the owner's Mac mini, because starting each `sleep` took about 9 ms of every 20 ms interval.
A run whose flag read hangs at the defaults takes the 10 s deadline plus about 30 short commands at one poll interval or more each: 10.8 to 10.9 s measured at a load average of 13 to 15.
Only the revert without any work directory (below) still counts poll intervals, so its deadline stretches under load.
The work directory sits next to the lease; when that directory cannot hold one, it goes under `fallbackWorkParent`, and when neither works the script logs `work directory unavailable` once and the revert reason says `flag unreadable (no work directory)` rather than a plain `flag unreadable`.
It decides:

- **No lease file and no lease renamed aside:** exit, whatever the flag reads (the flag is not remi's then); this is checked with shell builtins first, so nothing else runs while level 2 is off.
- **A lease left renamed aside** (`lease.json.watchdog-PID`, from a run killed while deleting): with no lease in place, the newest is linked back as the lease, and the claim is removed once a lease is in place.
  Work directories older than `orphanMaxAgeSeconds` are removed, and so are older claims, but only while a lease is in place: a claim keeps the modification time of the lease it was, so the claim of an expired lease looks old at once, and with no lease in place it may be the only copy.
- **`SleepDisabled` unreadable** (not exactly one `"SleepDisabled" = Yes` or `No` line in `ioreg -r -c IOPMrootDomain -d 1`): revert, reason `flag unreadable`.
- **`SleepDisabled` No:** revert nothing; delete a valid lease that is expired, stale or whose hub is gone, so a lease left by a crash before the enable, a failed enable or a reboot can never later revert a flag remi did not set.
  An invalid lease is kept for `invalidLeaseMaxAgeMinutes` (a hub may be replacing it) and then deleted with one log line, for the same reason.
- **`SleepDisabled` Yes**, the first that holds: the lease is invalid (`lease invalid`); `now >= expiresAt` (`expired`); the heartbeat is more than `staleSeconds` old or more than `staleSeconds` ahead of the clock (`heartbeat stale`); `ps` does not print `hubStartTime` for `hubPid`, a dead or reused pid (`hub gone`); on battery power, at or under `revertBatteryPercent` (`battery`).
  Two reasons go beyond ADR 0050's list, both toward sleep: `clock unreadable` when `date` fails, and `battery unreadable` when `pmset -g batt` fails, when its first line names neither AC nor battery power, or when it shows no percent on battery power.
- **Revert:** run the revert command (`/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0`, fixed when the script is generated) and read the flag again.
  When the command exited 0 and the flag reads No, it logs `UTC-TIMESTAMP revert REASON`, clears the failure count and the marker, and deletes the lease if it still holds the `hubPid` and `startedAt` this run read (it is renamed aside first and linked back if it changed, so a newer lease is never deleted).
  Otherwise the lease stays (the next run retries) and it logs `revert REASON` and `revert failed REASON (exit S, flag F, stderr: ...)`, with the exit status (or `timed out after N s`), the flag as read afterwards and the first `revertErrorMaxChars` characters of the command's first stderr line; never lease contents.
  A failure line identical to the previous run's is logged again only after `failureLogIntervalSeconds`.
- **Repeated failures:** after `revertFailureMarkerThreshold` consecutive failures (failed reverts or late runs) the script writes `REMIHOME/keep-awake/revert-failed`, holding the last failure line, and removes it at the next successful revert.
  Nothing reads that file yet; the hub and `remi keep-awake status` will surface it (L2-CORE, L2-CLI).
  The count and the throttle live in `REMIHOME/keep-awake/watchdog-state`.
- It logs nothing else and always exits 0.

The script checks the lease's types with `plutil -extract KEY raw -expect integer` (or `string` for `hubStartTime`), and its key set with `plutil -convert xml1`, so a string of digits, an array, a float or an extra key is `lease invalid`, as in `readLease`.
Both options exist in the `plutil` of macOS 27.2.
On a release whose `plutil` rejects `-expect`, every lease would read invalid and the watchdog would revert every run, which fails toward sleep; UNVERIFIED: which releases lack it and how they fail.

### Limits of the watchdog

- **A missing or broken sudo rule after the flag was set keeps the Mac awake.**
  The watchdog's revert then fails every run (it logs the failure and, after a few, leaves the marker), and the flag stays set until someone clears it by hand.
  ADR 0050's "fail toward sleep" holds only before the flag is set: the protection is L2-CORE's refusal to enable unless `sudo -n -l` shows that the revert is allowed.
- **`staleSeconds` and `expiresAt` are not bounded by the script.**
  A huge `staleSeconds` disables both heartbeat rules, and a far `expiresAt` disables the expiry rule; under the owner's rule that no option has a maximum, this is a recorded decision, and the hub's settings decide what a lease carries.
- **A macOS change that drops the `SleepDisabled` line when the flag is clear** would make the flag read as unreadable on every run while a lease exists: the watchdog would run the revert every run, read every revert as failed (the flag never reads No afterwards), keep the lease, log the failure (throttled) and, after a few runs, leave the marker.
- **After a logout** the user LaunchAgent stops, and only the hub's SIGTERM revert recovers; the boot daemon acts at boot only.
  A LaunchAgent that was disabled can go unnoticed, so L2-CORE's watchdog check must do more than test that the property list exists.
- **Crash safety, not a barrier:** a same-user process can delete the lease, the script or the agent.

### How these are tested

`packages/daemon/tests/power/level2-commands.test.ts`, `level2-lease.test.ts` and `watchdog-script.test.ts`, on macOS, without privileges.
The watchdog tests run the generated script with `/bin/sh` and an empty environment against a temporary remi home, the real `plutil` and `ps`, the real `date` (a stand-in with a fixed clock where a boundary or the log throttle needs one), fake `ioreg` and `pmset` executables that print `fixtures/watchdog/` captures (one test uses the real `ioreg`), an `ln` stand-in where a test kills the run at the relink, and a stand-in at the root boundary in place of `sudo` that records its arguments and writes the new flag where the fake `ioreg` reads it.
The production script's revert line is checked as text and never run.

### Not verified for level 2

The laptop battery line the watchdog parses is UNVERIFIED until owner gate OG-CAP captures a MacBook on battery: the fixtures follow ADR 0050's recollection (`-InternalBattery-0 ... 62%; discharging; 1:40 remaining`).
What `sudo -n -l` prints for an installed rule, whether `/etc/sudoers` reads `/etc/sudoers.d` on macOS 27.2, whether macOS sudo keeps `TMPDIR`, any launchd run of the watchdog, and every lid behavior (ADR 0050's hardware checks) are not verified here.

## Not verified

Level 1 does not implement a lid-closed mode and cannot override lid-close or emergency low-battery sleep.
Not verified by this slice: a MacBook on battery, behavior with the lid closed, and behavior across a real system sleep.
Whether `performance.now()` advances during system sleep is not checked; if it does, the first tick after wake can release a held session as the stuck bound, and the next turn or busy status holds again.
