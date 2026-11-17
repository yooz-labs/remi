# Card L2-POL: the level 2 policy, its settings and the foreign-holder rule (issue #1773, slice 3, pure)

Status: ready
Tier: worker-hard
Timebox: L, 1.5 days; escalate at 3 days or two failed approaches
Needs: none; any host (pure code, no macOS tool runs)
Depends: none for dispatch; the merge waits for the owner's answers to Q15 and Q16 (plan section 6; Q1 to Q14, the Q9 amendment and the rule that every limit is a setting were answered on 2026-11-17)
Branch: `feature/issue-1773-level2-policy` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-l2pol` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (L2-POL) and section 6a (armed mode, pause and resume); ADR 0050 "Fail-safe design for level 2" items 2 and 5, "Refusing while another app holds the Mac awake", "Battery, thermal, duration and display inputs", owner decisions 2, 4, 5, 7 and 8

## Goal

A pure, fully tested reducer decides, from settings, readings, the session census, the lid, the persisted counters and two clocks, when an armed level 2 turns on, when a condition pauses it (it reverts to the safe state and resumes by itself once the condition is gone), when only a person's action can bring it back (disarmed), and why; a pure validator checks the level 2 settings (types, ranges and the relations between them); a pure classifier applies ADR 0050's foreign-holder rule; nothing is wired to the hub or the configuration file yet.

## Context

Read first: ADR 0050 (`.context/decisions/0050-keep-the-mac-awake.md`) lines 90-104, 114-129 and 148-185; plan.md section 6a; the level 1 reducer `packages/daemon/src/power/awake-policy.ts` (the model: a pure `step(config, state, event, at)` returning `{ state, effects, nextDeadline }`, monotonic time clamped to the last observed value at lines 119-131) and its tests `packages/daemon/tests/power/awake-policy.test.ts`.

The owner's answers of 2026-11-17 (recorded in the pack's `board-log.md`):
- Q1 (b): `level2 = true` arms level 2; real work turns it on.
- The Q9 amendment: once armed, level 2 stays on until a condition prevents it; it then reverts to the safe state and pauses, and when the condition goes away it resumes by itself; an explicit stop or disarm by the person ends it until the person arms it again.
- Q2: the battery thresholds apply only while the Mac runs on battery power; on AC power only the other rails apply.
- Q3: a Mac with no battery (a desktop) never turns level 2 on (`no-battery`).
- Q10: no extra condition beyond the refusals; Q11: log and status now, a phone push with L2-APP.
- Q12 (b): a new hub comes up armed only after a clean exit with no lease left, never after a crash.
- Q13: an automatic start or resume needs the lid open for the whole dwell.
- Q14 (a): `level2_default_hours` is the longest continuous run, and `level2_cap_hours` is the on-time in a rolling window (`level2_window_hours`, default 24).
- The owner's rule: every limit is a setting the person can change; the plan only sets defaults (no maximum, sanity validation only).

Open, implemented here as the lead recommends (a different answer is a fix round before merge): Q15 (a), every former maximum and the 5-point gap become warnings, never refusals; Q16 (a), mechanism constants (subprocess deadlines, size caps, the clock-skew tolerance) stay named constants.

Lead decisions under owner decision 8 and the owner's rule: `lease_stale_seconds` (default 120, ADR 0050 line 97), the four pause-and-resume bounds, `level2_window_hours` and `level2_wake_gap_seconds` are keys; the watchdog must be loaded and bound to this remi home to turn on, and on every heartbeat.

## Scope

May change:
- new `packages/daemon/src/power/level2-settings.ts`, `packages/daemon/src/power/level2-policy.ts`, `packages/daemon/src/power/level2-foreign-holders.ts`;
- new tests `packages/daemon/tests/power/level2-settings.test.ts`, `level2-policy.test.ts`, `level2-foreign-holders.test.ts`;
- `docs/agent-reference/keep-awake.md` (add to or create the section "Level 2 building blocks (not wired)"; W1 may add the same section: on a conflict, keep both texts);
- the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-POL/r1/`.
Not in scope: `config/config.ts` (L2-HUB adds the keys), readers, the switch, the lease, the state file (L2-CORE persists what this reducer hands it), the hub, any spawn or file access; `awake-policy.ts` (level 1).

## Decided design

Settled:

1. **Settings** (`level2-settings.ts`): `Level2Settings` uses the configuration key names, so L2-HUB can pass the `[awake]` table's values unchanged.
   The owner's rule of 2026-11-17 applies: every limit is a key, the plan only sets defaults, and validation is sanity only (preamble item 9: type, positive or 0 where 0 turns a rule off, percent from 0 to 100, durations within the timer limit, and the two order relations below); no key has a maximum.
   Each key, with its default (the docs and the generated config say `default X; set KEY = Y to change`):
   - `level2`: boolean, default false (true allows and arms level 2, Q1 (b));
   - `level2_start_battery_percent`: percent, default 35 (no turning on, and no resuming, below it on battery power);
   - `level2_revert_battery_percent`: percent, default 30 (pause at or below it on battery power); required relation: below `level2_start_battery_percent` (otherwise level 2 would turn on and pause at the same reading);
   - `level2_min_remaining_minutes`: integer, 0 or more, default 20 (0 turns the time rule off);
   - `level2_default_hours`: positive number, decimals allowed, default 3 (Q14 (a): the longest continuous run, and the length of an explicit `start` without hours);
   - `level2_cap_hours`: positive number, default 12 (Q14 (a): the most on-time in `level2_window_hours`);
   - `level2_window_hours`: positive number, default 24 (new: the rolling window of the on-time cap, the resume count and the breaker count);
   - `level2_idle_revert_minutes`: positive integer, default 30;
   - `thermal_refuse_level` and `thermal_revert_level`: each one of `"moderate"`, `"heavy"`, `"trapping"`, defaults `"moderate"` and `"heavy"`; required relation: the revert level at or above the refuse level (a thermal pause resumes only below the refuse level);
   - `thermal_moderate_revert_minutes`: positive integer, default 5;
   - `heartbeat_seconds`: positive integer, default 30;
   - `lease_stale_seconds`: positive integer, default 120;
   - `watchdog_interval_seconds`: positive integer, default 60;
   - `foreign_holder_revert_minutes`: positive integer, default 2;
   - `foreign_holder_ignore`: array of non-empty strings with no control character, default empty;
   - `require_password_on_wake`: boolean, default true;
   - `level2_resume_dwell_seconds`: integer, 0 or more, default 120 (every condition clear, without a gap, this long before an automatic start or resume; 0 turns the dwell off);
   - `level2_resume_min_interval_minutes`: integer, 0 or more, default 10 (no automatic resume sooner after the last pause; 0 turns it off);
   - `level2_max_resumes_per_day`: integer, 0 or more, default 12 (automatic starts and resumes in `level2_window_hours`; the next one disarms instead; 0 means level 2 never turns on by itself, only by an explicit `start`);
   - `level2_breaker_failures`: positive integer, default 3 (failures of item 7 in `level2_window_hours` that disarm);
   - `level2_wake_gap_seconds`: positive integer, default 90 (new: a beat whose `wallNow` is more than this after the previous beat counts as a wake from sleep and restarts the dwell; 90 is three heartbeats at the default).
   Warnings, never refusals, each returned by the validator and printed at config load and in `remi keep-awake status` (Q15 asks the owner whether any should refuse instead):
   - the start percent less than 5 above the revert percent (pause and resume may alternate);
   - the revert percent below 10 (whether a Mac with sleep disabled still makes its emergency low-battery sleep is unverified, ADR 0050 line 104);
   - `heartbeat_seconds` above 300 (the battery and thermal pauses are only as prompt as the heartbeat);
   - `lease_stale_seconds` below twice `heartbeat_seconds` (the watchdog may revert a healthy period);
   - `level2_wake_gap_seconds` at or below `heartbeat_seconds` (every beat would count as a wake, so nothing resumes);
   - `level2_default_hours` above `level2_cap_hours`, or `level2_cap_hours` at or above `level2_window_hours` (the larger value has no effect);
   - `level2_resume_dwell_seconds` or `level2_resume_min_interval_minutes` set to 0 (no protection against flapping but the daily resume count);
   - `require_password_on_wake = false` (the Mac stays awake and unlocked with the lid closed, ADR 0050 table: "logged loudly").
   Export `LEVEL2_DEFAULTS` and `validateLevel2Settings(value: unknown): { ok: true, settings, warnings: string[] } | { ok: false, errors: string[] }`; each error and warning names the key and the rule (for example `awake.level2_revert_battery_percent must be below awake.level2_start_battery_percent`) and never echoes a string value from `foreign_holder_ignore`.
2. **Foreign holders** (`level2-foreign-holders.ts`): `classifyForeignHolders(holders, remiPids, ignore)`; a holder is `{ pid, process, type, name, createdForPid }` (structurally the same as G1's parsed holder; declare it here, do not import G1).
   A holder is remi's when its `pid` or its `createdForPid` is in `remiPids`.
   Exempt: exactly process `powerd`, type `PreventUserIdleSystemSleep`, name `Prevent sleep while display is on`.
   Display types `PreventUserIdleDisplaySleep` and `NoDisplaySleepAssertion` always block; system types `PreventSystemSleep`, `PreventUserIdleSystemSleep` and `NoIdleSleepAssertion` block unless the process name is in `ignore` (exact, case-sensitive); every other type is ignored.
   Returns `{ blocking, ignored }`, each a list of `{ process, kind: 'display' | 'system' }` (process names only; never `name`, which can carry an application's or page's text).
3. **States**: `disabled` (`level2` false), `disarmed` (only a person's `arm` or `start` leaves it; carries its reason), `armed` (off; nothing prevents it; waiting for work), `paused` (off; a condition prevents it; carries the condition), `starting`, `on`, `reverting`.
   `initialLevel2State(settings, persisted, startup)` (Q12 (b)):
   - `disabled` when `level2` is false;
   - `disarmed` with reason `restart` when the persisted state says disarmed, the previous hub did not record a clean exit, `startup.leaseFound`, or `startup.flag` is not `no`;
   - else `armed`, also on the very first run, with no persisted state.
   `persisted` is `{ armed, disarmReason, cleanExit, resumes, failures, runs }`: wall-clock epoch seconds of the resumes and failures, and the `[start, end]` on-time runs, of the last `level2_window_hours`.
   Every transition emits `persist` with the new value, so a restart cannot reset a counter.
4. **Inputs** on each `beat`, beside the monotonic `now`:
   - `battery`: `{ kind: 'none' }`, `{ kind: 'battery', source: 'ac' | 'battery', percent, remainingMinutes: number | null }` or `{ kind: 'unknown' }`;
   - `thermal`: `nominal`, `moderate`, `heavy`, `trapping`, `sleeping` or `unknown`;
   - `sleepDisabled`: `yes`, `no` or `unknown`;
   - `foreign`: `{ kind: 'ok', blocking }` or `{ kind: 'unknown' }`;
   - `passwordOnWake`: `on`, `off` or `unknown`;
   - `watchdog`: `loaded`, `missing`, `mismatch` or `unknown`;
   - `clamshell`: `open`, `closed`, `absent` or `unknown`;
   - `sessions`: `{ live, working }`;
   - `wallNow`: epoch seconds.
   While `armed` with `working` 0, the controller sends a cheap `census` instead (no readings).
   As soon as `working` is above 0, and while `paused`, `starting`, `on` or `reverting`, it sends full `beat`s.
5. **Events**: `start` (explicit; arms too; optional positive `hours`), `arm`, `stop`, `extend` (positive `hours`), `census`, `beat`, `enabled`, `enable-failed` (with the controller's reason), `disabled`, `disable-failed`, `heartbeat-failed`, `hub-exit`.
6. **Conditions that block turning on** (an automatic start or resume, and an explicit `start`), in this order; the first that holds is the reported condition:
   - `no-session`;
   - `no-work` (`working` 0; not checked for an explicit `start`);
   - `flag-unknown`;
   - `sleep-disabled-by-other` (`sleepDisabled` yes and not ours);
   - `no-battery` (Q3);
   - `battery-unknown`;
   - `battery-low` (on battery power, below `level2_start_battery_percent`);
   - `battery-time-low` (on battery power, an estimate present and below `level2_min_remaining_minutes`);
   - `thermal-unknown`;
   - `thermal` (at or above `thermal_refuse_level`);
   - `assertions-unknown`;
   - `foreign-holder` (with the process names);
   - `password-on-wake-unknown` and `password-on-wake-off` (both only when `require_password_on_wake`);
   - `watchdog-unknown`, `watchdog-missing`, `watchdog-mismatch`;
   - `daily-cap` (less than `level2_resume_min_interval_minutes` of on-time left under `level2_cap_hours` in the last `level2_window_hours`);
   - for an automatic start or resume only:
     - `lid-closed` (`clamshell` not `open`, Q13);
     - `resume-interval` (less than `level2_resume_min_interval_minutes` since the last pause);
     - `dwell` (the conditions have not all been clear for `level2_resume_dwell_seconds` without a gap; a beat whose `wallNow` is more than `level2_wake_gap_seconds` after the previous one counts as a wake from sleep and restarts the dwell).
   If an automatic start or resume passes but would be the `level2_max_resumes_per_day`+1-th in `level2_window_hours`, it disarms with `resume-limit` instead.
   A pass emits `enable` with the run's end and the origin (`automatic` or `explicit`), and the state is `starting`.
   The run's end is now plus `level2_default_hours` (or the `start` hours), never past the on-time left under the cap.
   A blocked automatic start leaves `armed` (`no-session`, `no-work`) or `paused` with the condition.
   A blocked explicit `start` arms and pauses with the condition, and then resumes by itself later.
   A log line is emitted only when the condition changes, never per beat.
7. **Conditions that pause a running level 2**: each reverts, then pauses with the condition, and resumes by item 6 once it is gone.
   - `run-limit` (the run's end reached) and `daily-cap`;
   - `battery-unknown`, `battery-low` (on battery power at or below `level2_revert_battery_percent`) and `battery-time-low`;
   - `thermal-unknown`, `thermal` (at or above `thermal_revert_level`) and `thermal-moderate-held`;
   - `foreign-holder` (a blocking holder or an unknown assertions reading present for `foreign_holder_revert_minutes`; the first beat that sees it emits one `notify`);
   - `watchdog-missing`, `watchdog-mismatch` and `watchdog-unknown`;
   - `flag-unknown` and `heartbeat-failed`;
   - `idle` (`working` 0 for `level2_idle_revert_minutes`) and `no-session` (`live` 0), which revert to `armed` rather than `paused`.
   Each emits `disable` with the condition and moves to `reverting`.
   `disabled` moves to the target state and records the pause time and the on-time run.
   `disable-failed` stays `reverting`, counts one failure, and every later `beat` emits `disable` again (reverting is the safe direction and is always retried).
   An `enable-failed` with `lease-write-failed` (no switch call happened) counts one failure and pauses.
   Failures for the breaker are `heartbeat-failed`, `lease-write-failed`, `flag-unknown` while on, `watchdog-mismatch` while on, and `disable-failed`.
8. **Explicit-only ends**: the state becomes `disarmed` with the reason, and only `arm` or `start` leaves it.
   - `stopped`: `stop` (after a `disable`, if on).
   - `flag-cleared-by-other`: `sleepDisabled` reads no while on.
     Emit `forget`, never `disable`.
     Someone cleared the flag, possibly the owner's own `sudo pmset -a disablesleep 0`, and that is treated as a person's kill switch.
   - `switch-failed`, `revert-not-permitted` and `sudo-refused`: an `enable-failed` from the switch.
     The enable is never retried automatically.
   - `resume-limit` (item 6).
   - `breaker`: the failures of item 7 in `level2_window_hours` reach `level2_breaker_failures`.
     The current revert finishes first.
   - `restart` (item 3).
   `arm` from `disarmed` moves to `armed` and clears the failure and resume counters (the person has looked); from any armed state it is a no-op; from `disabled` it is refused with `disabled`.
   `start` from `disarmed` arms, clearing the counters, and then evaluates item 6 as an explicit start.
   `extend` while `on` moves the run's end later, never past the on-time left under `level2_cap_hours` (the status says when the cap cut it); hours that are not a positive number are refused with `hours-invalid`.
   `hub-exit` while `starting`, `on` or `reverting` emits `disable`, and persists `cleanExit` true only after the revert; from any other state it persists `cleanExit` true and changes nothing else.
9. **Clocks**: timers use the monotonic clock, clamped to the last observed value as `awake-policy.ts:130` does; the window counters use `wallNow`, and a recorded time later than `wallNow` plus `CLOCK_SKEW_TOLERANCE_SECONDS` (a named mechanism constant, 60, Q16) counts as `wallNow` (a backward clock step cannot drop a counted resume or failure).
10. **Status**: `level2Status(state, now, wallNow)` returns `{ state, reason, origin, runEnd, onTimeLeftToday, resumesLeftToday, failuresToday, waitingFor }`.
    `waitingFor` names what a `paused` or `armed` level 2 needs to turn on, for example `battery at 35 percent or AC power`, `lid open`, `2 minutes without a blocking condition`.
The implementer may choose: internal field names, the effect and event type spellings beyond the state names and reason strings above (which are fixed: the CLI, the endpoint and the docs will print them), test names.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-POL/r1/`.
1. Settings tests:
   - `LEVEL2_DEFAULTS` validates with no warning;
   - each key refuses a wrong type, and each numeric key refuses a value below its floor (negative, or 0 where 0 is not allowed) and a duration beyond the timer limit, with an error naming the key;
   - no key has a maximum: `level2_default_hours = 100`, `level2_cap_hours = 100`, `level2_window_hours = 1000`, `level2_idle_revert_minutes = 100000`, `heartbeat_seconds = 3600`, `level2_max_resumes_per_day = 1000`, `level2_breaker_failures = 1000`, `level2_min_remaining_minutes = 100000` and a 1000-entry `foreign_holder_ignore` all validate;
   - each of the two required relations refuses alone (revert percent at or above start percent; thermal revert level below the refuse level);
   - each warning of item 1 appears for its trigger and not otherwise, and the settings still validate;
   - a control-character `foreign_holder_ignore` entry fails, and the error does not contain the planted string.
   Per key: a table-driven reducer test with one row per numeric key of item 1 sets a non-default value and shows the decision it governs change (for example `level2_default_hours = 0.5` pauses with `run-limit` after 30 minutes; `level2_window_hours = 6` lets a resume counted 7 hours ago expire; `level2_wake_gap_seconds = 600` keeps a 5-minute gap from restarting the dwell), besides the default's row.
2. Classifier tests: the powerd display-on assertion is exempt; a near miss (another name, another process or another type) is not; a holder created for a remi pid and a holder whose own pid is remi's are remi's; a display holder in the ignore list still blocks; a system holder in the ignore list is ignored; `UserIsActive` and a kernel type are ignored; the result never contains a holder's `name`.
3. Condition tests, table-driven:
   - one row per blocking condition of item 6, for an automatic start and, where it applies, an explicit `start`; each row breaks exactly one rule with all others passing and asserts the exact reason string;
   - one row per pausing condition of item 7, asserting the revert and the target state (`paused`, or `armed` for `idle` and `no-session`);
   - one row per explicit-only end of item 8, asserting `disarmed` and its reason;
   - the order: two failing rules give the earlier one;
   - Q2: AC power at 10 percent passes the battery rules, and unplugging at 10 percent pauses at the next beat.
4. Pause-and-resume tests:
   - a battery pause at 30 percent does not resume at 31, 32 or 34 on battery power, and after plugging in resumes only once the dwell and the minimum interval have passed;
   - a battery reading that oscillates 29, 31, 29, 31 every beat produces one pause and no resume;
   - a thermal pause at `heavy` does not resume at `moderate`, and resumes at `nominal` after the dwell;
   - a foreign holder that comes and goes every 30 s never resumes (the dwell);
   - Q13: `lid-closed` blocks a resume until the lid has been open for the whole dwell;
   - a beat gap of more than `level2_wake_gap_seconds` (a wake from sleep) restarts the dwell;
   - the `level2_max_resumes_per_day`+1-th automatic resume in `level2_window_hours` disarms with `resume-limit`, and `level2_max_resumes_per_day = 0` never turns on by itself;
   - a run reaching `level2_default_hours` pauses with `run-limit` and resumes after the minimum interval;
   - on-time reaching `level2_cap_hours` in `level2_window_hours` pauses with `daily-cap` until enough on-time is free;
   - `idle` returns to `armed`, and the next work episode turns it on again.
5. Failure and person tests:
   - `enable-failed` with `switch-failed`, `revert-not-permitted` or `sudo-refused` disarms, and later beats with every condition clear emit no `enable`;
   - `level2_breaker_failures` failures in `level2_window_hours` disarm with `breaker`;
   - `disable-failed` re-emits `disable` on every beat;
   - `flag-cleared-by-other` emits `forget` and no `disable`, and disarms;
   - `stop` while on emits `disable`, then disarms with `stopped`, and nothing turns it on until `arm`;
   - `arm` clears the counters;
   - `initialLevel2State` gives `disabled`; `armed` on the first run and after a clean exit; and `disarmed` with `restart` after no clean exit, a lease found, the flag not `no`, or a persisted disarmed state;
   - every transition emits `persist`;
   - a counter recorded in the future does not expire early when the clock steps back.
6. `mkdir -p /private/tmp/remi-canon-L2-POL && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-L2-POL/ bun test packages/daemon/tests/power/level2-settings.test.ts packages/daemon/tests/power/level2-policy.test.ts packages/daemon/tests/power/level2-foreign-holders.test.ts` ends with `0 fail`.
7. Revert checks, each with its failing log and a `revert-index.md` line:
   - let the powerd exemption match on process alone (a classifier row fails);
   - apply the battery rules on AC power (the Q2 row fails);
   - resume a battery pause at the revert threshold plus 1 (a row of item 4 fails);
   - skip the dwell (the oscillation row fails);
   - ignore the lid on a resume (the Q13 row fails);
   - retry `enable` after a switch failure (a row of item 5 fails);
   - emit `disable` for `flag-cleared-by-other` (its row fails);
   - let a restart reset the resume counter (a row of item 5 fails);
   - put back one maximum, for example `level2_default_hours` at most 24 (the no-maximum row of acceptance 1 fails);
   - read the window as a fixed 24 hours instead of `level2_window_hours` (its per-key row fails).
8. The PR body:
   - states that nothing is wired (no key is accepted by `config.toml` yet; L2-HUB adds them);
   - lists the state names and reason strings, which conditions pause and resume, and which only a person ends;
   - names the owner's answers, and Q12 to Q14 as implemented as recommended pending the owner;
   - says "Part of #1773".

## Gates

`bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; Acceptance 6 passes in the canonical environment; hosted CI's `Test worker 0` to `2` and `Test` pass on the final head.

## Stop conditions

A rule of items 3 to 9 contradicts ADR 0050 or the owner's answers as you read them (quote both and stop); a test would need a mock of the reducer or the classifier; the design needs a file outside Scope.

## Report

The preamble's report; one line per acceptance item and the final list of state names and reason strings go into `report-details.md` in the evidence folder.
