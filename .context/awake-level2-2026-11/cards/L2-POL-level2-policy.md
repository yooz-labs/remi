# Card L2-POL: the level 2 policy, its settings and the foreign-holder rule (issue #1773, slice 3, pure)

Status: ready
Tier: worker-hard
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: none; any host (pure code, no macOS tool runs)
Depends: none for dispatch; the merge waits for the owner's answers to Q2 and Q3 (plan section 6)
Branch: `feature/issue-1773-level2-policy` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-l2pol` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (L2-POL); ADR 0050 "Fail-safe design for level 2" item 2, "Refusing while another app holds the Mac awake", "Battery, thermal, duration and display inputs", owner decisions 2, 4, 5, 7 and 8

## Goal

A pure, fully tested reducer decides when level 2 may start, when it must revert and why, from settings, readings and a monotonic clock; a pure validator checks the level 2 settings (types, ranges and the relations between them); a pure classifier applies ADR 0050's foreign-holder rule; nothing is wired to the hub or the configuration file yet.

## Context

Read first: ADR 0050 (`.context/decisions/0050-keep-the-mac-awake.md`) lines 90-104, 114-129 and 148-185; the level 1 reducer `packages/daemon/src/power/awake-policy.ts` (the model: a pure `step(config, state, event, at)` returning `{ state, effects, nextDeadline }`, monotonic time clamped to the last observed value at lines 119-131) and its tests `packages/daemon/tests/power/awake-policy.test.ts`.

Gaps ADR 0050 leaves, filled here with the lead's recommended answers (owner questions Q2 and Q3, plan section 6; a different answer is a fix round before merge):
- Q2: the battery thresholds (`level2_start_battery_percent`, `level2_revert_battery_percent`, `level2_min_remaining_minutes`) apply only while the Mac runs on battery power; on AC power only the other rails apply, and unplugging below a threshold reverts at the next heartbeat.
- Q3: a Mac with no battery (a desktop) is refused (`no-battery`): it has no lid, and level 1 already covers idle sleep.
Lead decisions under owner decision 8 (every tunable is a key): `lease_stale_seconds` (default 120, ADR 0050 line 97's "heartbeat is older than 120 s") is a setting; the watchdog must be loaded for a start (`watchdog-missing`), because crash safety rests on it (ADR 0050 lines 97-98).

## Scope

May change:
- new `packages/daemon/src/power/level2-settings.ts`, `packages/daemon/src/power/level2-policy.ts`, `packages/daemon/src/power/level2-foreign-holders.ts`;
- new tests `packages/daemon/tests/power/level2-settings.test.ts`, `level2-policy.test.ts`, `level2-foreign-holders.test.ts`;
- `docs/agent-reference/keep-awake.md` (add to or create the section "Level 2 building blocks (not wired)"; W1 may add the same section: on a conflict, keep both texts);
- the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-POL/r1/`.
Not in scope: `config/config.ts` (L2-HUB adds the keys), readers, the switch, the lease, the hub, any spawn or file access; `awake-policy.ts` (level 1).

## Decided design

Settled:

1. **Settings** (`level2-settings.ts`): `Level2Settings` uses the configuration key names, so L2-HUB can pass the `[awake]` table's values unchanged:
   `level2` boolean, default false;
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
3. **Inputs** to the reducer, read by the controller (L2-CORE) at each request and heartbeat: `battery` (`{ kind: 'none' }`, `{ kind: 'battery', source: 'ac' | 'battery', percent, remainingMinutes: number | null }` or `{ kind: 'unknown' }`), `thermal` (`nominal`, `moderate`, `heavy`, `trapping`, `sleeping` or `unknown`), `sleepDisabled` (`yes`, `no`, `unknown`), `foreign` (`{ kind: 'ok', blocking }` or `{ kind: 'unknown' }`), `passwordOnWake` (`on`, `off`, `unknown`), `watchdog` (`loaded`, `missing`, `unknown`), `sessions` (`{ live, working }`).
4. **Events**: `start` (optional whole `hours`), `extend` (whole `hours`), `stop`, `beat`, `enabled` and `enable-failed` (the controller's lease write and switch result), `disabled` and `disable-failed`, `heartbeat-failed` (the lease could not be rewritten), `hub-exit`.
   Every event carries the readings it was evaluated with where it needs them.
5. **Start refusals**, checked in this order, the first that holds is the reason: `disabled` (`level2` false), `already-on`, `hours-invalid` (not a whole number from 1 to `level2_cap_hours`; no `hours` means `level2_default_hours`), `no-session` (`live` 0), `flag-unknown`, `sleep-disabled-by-other` (`sleepDisabled` yes with no level 2 of ours on: the flag is someone else's), `no-battery`, `battery-unknown`, `battery-low` (on battery power and below the start percent), `battery-time-low` (on battery power, an estimate present and below `level2_min_remaining_minutes`), `thermal-unknown`, `thermal` (at or above `thermal_refuse_level`), `assertions-unknown`, `foreign-holder` (any blocking holder; the refusal lists their process names), `password-on-wake-unknown` and `password-on-wake-off` (only when `require_password_on_wake`; only `on` passes), `watchdog-unknown`, `watchdog-missing`.
   A start that passes emits `enable` with `expiresAt` (now plus the hours) and `capAt` (now plus `level2_cap_hours`); the state is `starting` until `enabled` (state `on`) or `enable-failed` (state `off`, refusal `switch-failed` or `lease-write-failed` as the controller reports).
6. **Extend**: only while `on`; passes the same refusals from `hours-invalid` on except `no-session` and `sleep-disabled-by-other`; sets `expiresAt` to the smaller of now plus the hours and `capAt`; an extension that would not move `expiresAt` later is `hours-invalid`.
   A new period after a revert is a new `start` with a new `capAt`.
7. **Reverts while `on`**, evaluated at each `beat`: `flag-cleared-by-other` (`sleepDisabled` no: emit `forget`, never `disable`, since the flag is already clear and not ours to touch), `flag-unknown`, `expired` (now at or past `expiresAt`), `no-session` (`live` 0), `idle` (`working` 0 continuously for `level2_idle_revert_minutes` since the later of the start and the last beat with `working` above 0), `battery-unknown`, `battery-low` (on battery power at or below the revert percent), `battery-time-low` (on battery power, an estimate present and below the minimum), `thermal-unknown`, `thermal` (at or above `thermal_revert_level`), `thermal-moderate-held` (exactly `moderate`, below the revert level, for `thermal_moderate_revert_minutes`), `foreign-holder` (a blocking holder or an unknown assertions reading present continuously for `foreign_holder_revert_minutes`; the first beat that sees it emits one `notify` with the process names).
   Also `stopped` (`stop`), `heartbeat-failed` and `hub-exit`; `stop` and `hub-exit` while `off` are no-ops with no effects.
   Each emits `disable` with the reason and moves to `reverting`; `disabled` moves to `off`; `disable-failed` stays `reverting` and every later `beat` emits `disable` again.
   The password-on-wake setting and the watchdog are checked at `start` and `extend` only.
8. **Clock**: one monotonic millisecond clock, clamped to the last observed value as `awake-policy.ts:130` does; wall-clock times for the lease are the controller's job.
   Durations in settings are converted once.
9. **Status**: `level2Status(state, now)` returns `{ state, reason, startedAt, expiresAt, capAt }` in monotonic milliseconds (the controller converts), plus the last refusal and the last revert reason.
The implementer may choose: internal state field names, the effect and event type spellings beyond the reason strings above (which are fixed: the CLI, the endpoint and the docs will print them), test names.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-POL/r1/`.
1. Settings tests: `LEVEL2_DEFAULTS` validates; each key's lower and upper bound passes and one past each fails with an error naming the key; each relation fails alone (start at or below revert, default above cap, refuse level above revert level, stale below twice the heartbeat); a wrong type per key fails; a 33-entry or control-character `foreign_holder_ignore` fails and the error does not contain the planted string.
2. Classifier tests: the powerd display-on assertion is exempt; a near miss (another name, another process or another type) is not; a holder created for a remi pid and a holder whose own pid is remi's are remi's; a display holder in the ignore list still blocks; a system holder in the ignore list is ignored; `UserIsActive` and a kernel type are ignored; the result never contains a holder's `name`.
3. Policy tests, table-driven, one row per refusal of item 5 (each row breaks exactly one rule with all others passing, and asserts the exact reason string), one row per revert of item 7, plus: the refusal order (two failing rules give the earlier one); AC power at 10 percent passes the battery rules and unplugging at 10 percent reverts at the next beat (Q2); an absent time estimate skips the time rule; the moderate timer resets when the level drops to nominal; the foreign grace resets when the holder goes and `notify` is emitted once per appearance; `idle` counts from the last working beat; `extend` never passes `capAt`; `disable-failed` re-emits `disable` on each beat; `flag-cleared-by-other` emits `forget` and no `disable`; a clock that goes backwards does not shorten or lengthen any timer.
4. `mkdir -p /private/tmp/remi-canon-L2-POL && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-L2-POL/ bun test packages/daemon/tests/power/level2-settings.test.ts packages/daemon/tests/power/level2-policy.test.ts packages/daemon/tests/power/level2-foreign-holders.test.ts` ends with `0 fail`.
5. Revert checks, each with its failing log and a `revert-index.md` line: let the powerd exemption match on process alone (a classifier row fails); apply the battery rules on AC power (the Q2 row fails); emit `disable` for `flag-cleared-by-other` (its row fails); allow `extend` past `capAt` (its row fails).
6. The PR body states that nothing is wired (no key is accepted by `config.toml` yet; L2-HUB adds them), lists the reason strings, names Q2 and Q3 as the owner's pending answers implemented as recommended, and says "Part of #1773".

## Gates

`bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; Acceptance 4 passes in the canonical environment; hosted CI's `Test worker 0` to `2` and `Test` pass on the final head.

## Stop conditions

A rule of items 5 to 7 contradicts ADR 0050 as you read it (quote both and stop); a test would need a mock of the reducer or the classifier; the design needs a file outside Scope.

## Report

The preamble's report; one line per acceptance item and the final list of reason strings go into `report-details.md` in the evidence folder.
