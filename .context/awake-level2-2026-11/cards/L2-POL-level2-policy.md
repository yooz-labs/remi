# Card L2-POL: the level 2 policy, its settings and the foreign-holder rule (issue #1773, slice 3, pure)

Status: ready
Tier: worker-hard
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: none; any host (pure code, no macOS tool runs)
Depends: none for dispatch; the merge waits for the owner's answers to Q9 and Q10 (plan section 6; Q1 to Q3 were answered on 2026-11-17)
Branch: `feature/issue-1773-level2-policy` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-l2pol` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (L2-POL) and section 6a (armed mode); ADR 0050 "Fail-safe design for level 2" item 2, "Refusing while another app holds the Mac awake", "Battery, thermal, duration and display inputs", owner decisions 2, 4, 5, 7 and 8

## Goal

A pure, fully tested reducer decides when level 2 arms, starts (automatically at the first real work while armed, or on an explicit start), must revert, and stays off after a revert until an explicit action, and why, from settings, readings, the session census and a monotonic clock; a pure validator checks the level 2 settings (types, ranges and the relations between them); a pure classifier applies ADR 0050's foreign-holder rule; nothing is wired to the hub or the configuration file yet.

## Context

Read first: ADR 0050 (`.context/decisions/0050-keep-the-mac-awake.md`) lines 90-104, 114-129 and 148-185; plan.md section 6a; the level 1 reducer `packages/daemon/src/power/awake-policy.ts` (the model: a pure `step(config, state, event, at)` returning `{ state, effects, nextDeadline }`, monotonic time clamped to the last observed value at lines 119-131) and its tests `packages/daemon/tests/power/awake-policy.test.ts`.

The owner's answers of 2026-11-17 (recorded in the pack's `board-log.md`):
- Q1 (b), armed by configuration: with `level2 = true` the hub turns level 2 on at the first real work and keeps it for `level2_default_hours`; after any revert it stays off until an explicit start.
- Q2: the battery thresholds (`level2_start_battery_percent`, `level2_revert_battery_percent`, `level2_min_remaining_minutes`) apply only while the Mac runs on battery power; on AC power only the other rails apply, and unplugging below a threshold reverts at the next heartbeat.
- Q3: a Mac with no battery (a desktop) is refused (`no-battery`).
Open, implemented here as the lead recommends (a different answer is a fix round before merge): Q9 (a), only an explicit `arm` re-arms, and every period (automatic or explicit) consumes the arming; Q10, no extra condition on an automatic start (if the owner adds "a remote client connected recently", it becomes one more automatic-only refusal).
Lead decisions under owner decision 8 (every tunable is a key): `lease_stale_seconds` (default 120, ADR 0050 line 97's "heartbeat is older than 120 s") is a setting; the watchdog must be loaded and bound to this remi home for a start and on every heartbeat (`watchdog-missing`, `watchdog-mismatch`), because crash safety rests on it (ADR 0050 lines 97-98).

## Scope

May change:
- new `packages/daemon/src/power/level2-settings.ts`, `packages/daemon/src/power/level2-policy.ts`, `packages/daemon/src/power/level2-foreign-holders.ts`;
- new tests `packages/daemon/tests/power/level2-settings.test.ts`, `level2-policy.test.ts`, `level2-foreign-holders.test.ts`;
- `docs/agent-reference/keep-awake.md` (add to or create the section "Level 2 building blocks (not wired)"; W1 may add the same section: on a conflict, keep both texts);
- the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-POL/r1/`.
Not in scope: `config/config.ts` (L2-HUB adds the keys), readers, the switch, the lease, the arming latch file (L2-CORE persists it), the hub, any spawn or file access; `awake-policy.ts` (level 1).

## Decided design

Settled:

1. **Settings** (`level2-settings.ts`): `Level2Settings` uses the configuration key names, so L2-HUB can pass the `[awake]` table's values unchanged:
   `level2` boolean, default false (true allows level 2 and arms it, Q1 (b));
   `level2_start_battery_percent` integer 1 to 100, default 35;
   `level2_revert_battery_percent` integer 0 to 99, default 30, and strictly below the start value;
   `level2_min_remaining_minutes` integer 0 to 600, default 20 (0 turns the time rule off);
   `level2_default_hours` integer 1 to 24, default 3, at most `level2_cap_hours`;
   `level2_cap_hours` integer 1 to 24, default 12;
   `level2_idle_revert_minutes` integer 1 to 1440, default 30;
   `thermal_refuse_level` and `thermal_revert_level` each one of `"moderate"`, `"heavy"`, `"trapping"`, defaults `"moderate"` and `"heavy"`, the refuse level at or below the revert level;
   `thermal_moderate_revert_minutes` integer 1 to 120, default 5;
   `heartbeat_seconds` integer 5 to 300, default 30;
   `lease_stale_seconds` integer from twice `heartbeat_seconds` to 3600, default 120;
   `watchdog_interval_seconds` integer 10 to 3600, default 60;
   `foreign_holder_revert_minutes` integer 1 to 60, default 2;
   `foreign_holder_ignore` array of at most 32 strings, each 1 to 64 characters with no control character, default empty;
   `require_password_on_wake` boolean, default true.
   Export `LEVEL2_DEFAULTS` and `validateLevel2Settings(value: unknown): { ok: true, settings } | { ok: false, errors: string[] }`; each error names the key and the rule (for example `awake.level2_revert_battery_percent must be below awake.level2_start_battery_percent`) and never echoes a string value from `foreign_holder_ignore`.
2. **Foreign holders** (`level2-foreign-holders.ts`): `classifyForeignHolders(holders, remiPids, ignore)`; a holder is `{ pid, process, type, name, createdForPid }` (structurally the same as G1's parsed holder; declare it here, do not import G1).
   A holder is remi's when its `pid` or its `createdForPid` is in `remiPids`.
   Exempt: exactly process `powerd`, type `PreventUserIdleSystemSleep`, name `Prevent sleep while display is on`.
   Display types `PreventUserIdleDisplaySleep` and `NoDisplaySleepAssertion` always block; system types `PreventSystemSleep`, `PreventUserIdleSystemSleep` and `NoIdleSleepAssertion` block unless the process name is in `ignore` (exact, case-sensitive); every other type is ignored.
   Returns `{ blocking, ignored }`, each a list of `{ process, kind: 'display' | 'system' }` (process names only; never `name`, which can carry an application's or page's text).
3. **States**: `disabled` (`level2` false: nothing starts), `armed` (waits for the first real work), `disarmed` (`level2` true, but a period has run since the last `arm`: only an explicit `start` or `arm` leaves it), `starting`, `on`, `reverting`.
   `initialLevel2State(settings, latched)` gives `disabled` when `level2` is false, `disarmed` when the controller found the persisted latch (L2-CORE), else `armed`.
   The arming is consumed by the period it starts: every `enable` (automatic or explicit) emits `latch` first, and the controller persists it before the lease and the switch, so a crash, a reboot or any revert leaves the hub `disarmed` (ADR 0050 fail-safe item 5: a new hub never resumes level 2 by itself).
4. **Inputs** read by the controller: `battery` (`{ kind: 'none' }`, `{ kind: 'battery', source: 'ac' | 'battery', percent, remainingMinutes: number | null }` or `{ kind: 'unknown' }`), `thermal` (`nominal`, `moderate`, `heavy`, `trapping`, `sleeping` or `unknown`), `sleepDisabled` (`yes`, `no`, `unknown`), `foreign` (`{ kind: 'ok', blocking }` or `{ kind: 'unknown' }`), `passwordOnWake` (`on`, `off`, `unknown`), `watchdog` (`loaded`, `missing`, `mismatch`, `unknown`), `sessions` (`{ live, working }`).
5. **Events**: `start` (explicit, optional whole `hours`), `arm` (explicit), `extend` (whole `hours`), `stop`, `census` (sessions only: the cheap beat while `armed`), `attempt` (the readings the controller took after a `read-for-start` effect), `beat` (readings and sessions while `starting`, `on` or `reverting`), `enabled` and `enable-failed` (the controller's latch, lease and switch results), `disabled` and `disable-failed`, `heartbeat-failed` (the lease could not be rewritten), `hub-exit`.
6. **Automatic start** (Q1 (b)): while `armed`, a work episode begins when `census` shows `working` above 0 after a census (or the arming) that showed 0, including the first census after arming if work is already under way.
   At an episode's beginning the reducer emits `read-for-start`; the following `attempt` runs the start refusals of item 7 with `hours` = `level2_default_hours` and origin `automatic`.
   A refused automatic start keeps the state `armed`, records `lastRefusal`, emits a `log` effect only when the reason differs from the previous automatic refusal (no log loop), and makes no further attempt until the next episode (`working` back to 0, then above 0); no `read-for-start` is emitted while an episode continues.
   A passing one emits `latch` then `enable` with origin `automatic`.
7. **Start refusals** (explicit `start` from `armed` or `disarmed`, and automatic attempts), checked in this order, the first that holds is the reason: `disabled` (`level2` false), `already-on`, `hours-invalid` (not a whole number from 1 to `level2_cap_hours`; no `hours` means `level2_default_hours`), `no-session` (`live` 0), `flag-unknown`, `sleep-disabled-by-other` (`sleepDisabled` yes with no level 2 of ours on: the flag is someone else's), `no-battery` (Q3), `battery-unknown`, `battery-low` (on battery power and below the start percent), `battery-time-low` (on battery power, an estimate present and below `level2_min_remaining_minutes`), `thermal-unknown`, `thermal` (at or above `thermal_refuse_level`), `assertions-unknown`, `foreign-holder` (any blocking holder; the refusal lists their process names), `password-on-wake-unknown` and `password-on-wake-off` (only when `require_password_on_wake`; only `on` passes), `watchdog-unknown`, `watchdog-missing`, `watchdog-mismatch` (loaded, but its script is not this remi home's or not this build's).
   A start that passes emits `latch` and `enable` with `expiresAt` (now plus the hours), `capAt` (now plus `level2_cap_hours`) and the origin; the state is `starting` until `enabled` (state `on`) or `enable-failed` (state `disarmed`, refusal `switch-failed`, `revert-not-permitted` or `lease-write-failed` as the controller reports: the latch already stands, so a switch failure is never retried automatically).
   An explicit `start` that is refused leaves the state as it was (`armed` stays `armed`).
8. **Arm, stop, extend**: `arm` moves `disarmed` to `armed` and emits `unlatch` (from `armed`, `starting` or `on` it is a no-op; from `disabled` it is refused with `disabled`); `stop` from `armed` moves to `disarmed` and emits `latch` (the person said no), from `on` reverts with `stopped`, and from `disarmed` or `disabled` is a no-op; `extend` only while `on`, passing the refusals of item 7 from `hours-invalid` on except `no-session` and `sleep-disabled-by-other`, sets `expiresAt` to the smaller of now plus the hours and `capAt`, and an extension that would not move `expiresAt` later is `hours-invalid`.
9. **Reverts while `on`**, evaluated at each `beat`: `flag-cleared-by-other` (`sleepDisabled` no: emit `forget`, never `disable`, since the flag is already clear and not ours to touch), `flag-unknown`, `expired` (now at or past `expiresAt`), `no-session` (`live` 0), `idle` (`working` 0 continuously for `level2_idle_revert_minutes` since the later of the start and the last beat with `working` above 0), `battery-unknown`, `battery-low` (on battery power at or below the revert percent), `battery-time-low` (on battery power, an estimate present and below the minimum), `thermal-unknown`, `thermal` (at or above `thermal_revert_level`), `thermal-moderate-held` (exactly `moderate`, below the revert level, for `thermal_moderate_revert_minutes`), `foreign-holder` (a blocking holder or an unknown assertions reading present continuously for `foreign_holder_revert_minutes`; the first beat that sees it emits one `notify` with the process names), `watchdog-missing`, `watchdog-mismatch` and `watchdog-unknown`.
   Also `stopped` (`stop`), `heartbeat-failed` and `hub-exit` (from `armed` or `disarmed`, `hub-exit` is a no-op: no revert happened).
   Each emits `disable` with the reason and moves to `reverting`; `disabled` moves to `disarmed` (never back to `armed`: "after any revert it stays off until an explicit start"); `disable-failed` stays `reverting` and every later `beat` emits `disable` again.
   The password-on-wake setting is checked at a start (explicit or automatic) and at `extend` only; the watchdog at every start, `extend` and `beat`.
10. **Clock**: one monotonic millisecond clock, clamped to the last observed value as `awake-policy.ts:130` does; wall-clock times for the lease and the latch are the controller's job.
    Durations in settings are converted once.
11. **Status**: `level2Status(state, now)` returns `{ state, origin, reason, startedAt, expiresAt, capAt }` in monotonic milliseconds (the controller converts), plus the last refusal (automatic or explicit) and the last revert reason.
The implementer may choose: internal state field names, the effect and event type spellings beyond the state names and reason strings above (which are fixed: the CLI, the endpoint and the docs will print them), test names.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-POL/r1/`.
1. Settings tests: `LEVEL2_DEFAULTS` validates; each key's lower and upper bound passes and one past each fails with an error naming the key; each relation fails alone (start at or below revert, default above cap, refuse level above revert level, stale below twice the heartbeat); a wrong type per key fails; a 33-entry or control-character `foreign_holder_ignore` fails and the error does not contain the planted string.
2. Classifier tests: the powerd display-on assertion is exempt; a near miss (another name, another process or another type) is not; a holder created for a remi pid and a holder whose own pid is remi's are remi's; a display holder in the ignore list still blocks; a system holder in the ignore list is ignored; `UserIsActive` and a kernel type are ignored; the result never contains a holder's `name`.
3. Policy tests, table-driven, one row per refusal of item 7 (each row breaks exactly one rule with all others passing, and asserts the exact reason string), for an explicit start and for an automatic attempt; one row per revert of item 9; plus: the refusal order (two failing rules give the earlier one); AC power at 10 percent passes the battery rules and unplugging at 10 percent reverts at the next beat (Q2); an absent time estimate skips the time rule; the moderate timer resets when the level drops to nominal; the foreign grace resets when the holder goes and `notify` is emitted once per appearance; `idle` counts from the last working beat; `extend` never passes `capAt`; `disable-failed` re-emits `disable` on each beat; `flag-cleared-by-other` emits `forget` and no `disable`; a clock that goes backwards does not shorten or lengthen any timer.
4. Arming tests: `initialLevel2State` gives `disabled`, `disarmed` and `armed` for its three cases; an armed reducer whose census goes 0, 2, 3, 0, 1 emits `read-for-start` exactly twice (at 2 and at 1) and never while an episode continues; an armed census already above 0 at the first census starts an episode; a passing attempt emits `latch` before `enable` and the period lasts `level2_default_hours`; the same refusal at three episodes logs once, a changed reason logs again, and the state stays `armed`; `enable-failed` with each of its three reasons leaves `disarmed` and a later episode emits no `read-for-start`; every revert of item 9 ends in `disarmed`, and a later episode emits nothing; `arm` from `disarmed` emits `unlatch` and the next episode starts; `stop` from `armed` emits `latch` and leaves `disarmed`; `hub-exit` from `armed` emits nothing; an explicit `start` from `disarmed` that passes emits `latch` and `enable` with origin `explicit`.
5. `mkdir -p /private/tmp/remi-canon-L2-POL && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-L2-POL/ bun test packages/daemon/tests/power/level2-settings.test.ts packages/daemon/tests/power/level2-policy.test.ts packages/daemon/tests/power/level2-foreign-holders.test.ts` ends with `0 fail`.
6. Revert checks, each with its failing log and a `revert-index.md` line: let the powerd exemption match on process alone (a classifier row fails); apply the battery rules on AC power (the Q2 row fails); emit `disable` for `flag-cleared-by-other` (its row fails); allow `extend` past `capAt` (its row fails); return to `armed` after a revert (an arming row fails); attempt again within one episode after a refusal (an arming row fails); emit `enable` before `latch` (an arming row fails).
7. The PR body states that nothing is wired (no key is accepted by `config.toml` yet; L2-HUB adds them), lists the state names and reason strings, names Q1 (b), Q2 and Q3 as the owner's answers and Q9 (a) and Q10 as implemented as recommended pending the owner, and says "Part of #1773".

## Gates

`bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; Acceptance 5 passes in the canonical environment; hosted CI's `Test worker 0` to `2` and `Test` pass on the final head.

## Stop conditions

A rule of items 3 to 9 contradicts ADR 0050 or the owner's Q1 to Q3 answers as you read them (quote both and stop); a test would need a mock of the reducer or the classifier; the design needs a file outside Scope.

## Report

The preamble's report; one line per acceptance item and the final list of state names and reason strings go into `report-details.md` in the evidence folder.
