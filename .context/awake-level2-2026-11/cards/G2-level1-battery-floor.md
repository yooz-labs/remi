# Card G2: the level 1 battery floor (issue #1773, guard-rails slice)

Status: ready
Tier: worker-hard
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: none (no Xcode, no simulator); macOS host (live readers and the real-daemon smoke run only on macOS)
Depends: G1 merged after its fix round of 2026-11-17 (its readers take `SpawnBoundedOptions`, with `DEFAULT_*` constants for the deadline, the two output caps and the kill grace), OG-CAP (the MacBook battery captures); the owner answered Q2, Q4, Q15 and Q16 on 2026-11-17
Branch: `feature/issue-1773-battery-floor` off `origin/develop` (after G1 merged)
Worktree: `/Volumes/S1/worktrees/remi/awake-g2` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (G2); ADR 0050 owner decisions 3 and 8, the table row `level1_battery_floor_percent`, "Battery, thermal, duration and display inputs"

## Goal

On battery power below `level1_battery_floor_percent` (default 20), level 1 holds nothing and releases a hold it has, read without privileges from `pmset -g batt` and `ioreg`; on AC power and on a Mac with no battery it holds as today; an unreadable battery releases (fail toward sleep); `level1_battery_floor_percent` and `battery_check_seconds` become supported keys in one commit, so neither can crash a daemon half-built.

## Context

Read first: ADR 0050 (`.context/decisions/0050-keep-the-mac-awake.md`) lines 34-40 (drivers: "Fail toward sleep: a crash, a lost lease, a parse failure ... ends with the Mac allowed to sleep"), 124-126 and 148-185; `docs/agent-reference/keep-awake.md`; G1's `packages/daemon/src/power/readings/run-reading.ts` (merged before this card).

What the code does today (`develop` `bbcec7d6`, checked by the lead on 2026-11-17; re-check each line at your base):
- `packages/daemon/src/config/config.ts`: `AwakeConfig` at lines 69-76, the maxima at 78-81, `DEFAULT_CONFIG.awake` at 228-234, `deepMerge` copies only keys present in the defaults (325-336), `validateAwakeTable` rejects any key outside its supported set (458-478, the set at 467-473), `validateAwake` checks types and ranges (480-498, also called from `applyEnvOverrides` at 714), the generated `[awake]` section at 814-829 says "No battery floor yet ... rejected as an unknown key until then" (818-819), `formatConfig` prints the table at 947-952.
- `packages/daemon/tests/power/awake-config.test.ts:87-91` asserts that `level1_battery_floor_percent = 20` is rejected and that the generated config says "No battery floor yet"; this card replaces that test.
- The level 1 reducer `packages/daemon/src/power/awake-policy.ts` (events at 8-20, release reasons at 24-30, `stepAwakePolicy` at 124-246, deadlines at 262-286); the session driver `awake-session.ts` takes test seams through `AwakeSessionOptions` (45-50: `createHolder`, `clock`, `retryDelaysMs`); `awake-wiring.ts` passes `session` options through (13-14, 52-58).
- `docs/agent-reference/keep-awake.md:40-41`, `AGENTS.md:248` and the 0.9.0 changelog bullet (`CHANGELOG.md:7`) say there is no battery floor yet; the changelog is not edited here (release preparation does).
- The real-daemon smoke `packages/daemon/tests/integration/keep-awake-daemon-smoke.test.ts` is the model for a real `cli.ts --daemon` under `env -i`.

Facts the lead read on this Mac (Mac16,11, macOS 27.2) on 2026-11-17, read-only: `pmset -g batt` prints only `Now drawing from 'AC Power'`; `ioreg -r -c AppleSmartBattery -d 1` lists an `AppleSmartBattery` node even here, with `"BatteryInstalled" = No`, `"ExternalConnected" = Yes`, `"CurrentCapacity" = 0` and `"MaxCapacity" = 0` (so the node's presence does not mean a battery).
The laptop shapes come from OG-CAP: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/captures/OG-CAP/` (one folder per state, see `owner-gates.md` OG-CAP).

Owner answers of 2026-11-17 this card implements (plan section 6): Q2, the floor applies only on battery power (decision 3 is titled "Level 1 on battery"); Q4, an unknown `[awake]` key keeps stopping config load.
Lead decisions under owner decision 8 and the owner's rule of 2026-11-17 (every limit is a key, the plan only sets defaults): the read cadence is a key, `battery_check_seconds`, and so is the unknown-reading tolerance, `level1_battery_unknown_reads`; the four slice 1 keys lose their maxima (`AWAKE_MAX_*` at `config/config.ts:78-81`), keeping only sanity validation (preamble item 9).

## Scope

May change:
- new `packages/daemon/src/power/readings/battery.ts` (and its test and fixtures: the Mac mini's own capture plus redacted OG-CAP battery captures under `packages/daemon/tests/power/fixtures/`, each folder with `SOURCE.md`);
- `packages/daemon/src/power/awake-policy.ts`, `awake-session.ts`, `awake-wiring.ts`;
- new `packages/daemon/src/power/long-timeout.ts` (`setLongTimeout` and `clearLongTimeout`: a delay above 2147483647 ms is armed as a chain of shorter timeouts, so a large setting is honored instead of firing after 1 ms), used by `REAL_AWAKE_CLOCK.setTimer` (`awake-session.ts:28-36`) and by `spawnBounded`'s deadline in `power/readings/run-reading.ts` (only that timer line), and its test;
- `packages/daemon/src/config/config.ts` (only the `[awake]` parts listed in Context);
- tests under `packages/daemon/tests/power/` and `packages/daemon/tests/integration/keep-awake-daemon-smoke.test.ts` or a new `packages/daemon/tests/integration/keep-awake-battery-smoke.test.ts`;
- `docs/agent-reference/keep-awake.md`, the line at `AGENTS.md:248`, and ADR 0050 (`.context/decisions/0050-keep-the-mac-awake.md`: the status line's slice note and table rows for `battery_check_seconds` and `level1_battery_unknown_reads`);
- the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/G2/r1/`.
Not in scope: `cli.ts`, level 2 files, the hub, any other configuration table.

## Decided design

Settled:

1. **Battery reading** (`readings/battery.ts`): `parseBattery(pmsetBatt, ioregBattery)` returns `{ kind: 'none' }`, `{ kind: 'battery', source: 'ac' | 'battery', percent, remainingMinutes: number | null }` or `{ kind: 'unknown', reason }`.
   The source comes from the first line, `Now drawing from 'AC Power'` or `'Battery Power'` (any other source is unknown).
   The battery line's grammar comes from the OG-CAP captures (percent, state, `H:MM remaining` or a no-estimate form, which gives `remainingMinutes: null`).
   `"BatteryInstalled" = Yes|No` must appear exactly once in the `ioreg` output, or the node must be absent (counts as No).
   `none` only when installed is No, no battery line exists and the source is AC power; `battery` only when installed is Yes and exactly one battery line parses; every other combination is unknown.
   `readBattery()` runs `runReading('/usr/bin/pmset', ['-g', 'batt'])` and `runReading('/usr/sbin/ioreg', ['-r', '-c', 'AppleSmartBattery', '-d', '1'])`; a failed run is unknown with the runner's reason.
   Reasons never contain the raw text.
2. **Policy** (`awake-policy.ts`): a new event `{ type: 'battery', reading }`.
   The floor allows a hold when the reading is `none`, or `source: 'ac'`, or on battery with `percent >= level1_battery_floor_percent`; `unknown` never starts a hold, and a held session releases on `unknown` only after `level1_battery_unknown_reads` consecutive unknown readings (default 2: one slow `pmset` under an agent's load must not drop a turn's hold); the first `none` reading is kept for the daemon's lifetime and no further reads happen (a Mac does not gain a battery).
   When the reducer wants a hold (its existing active reasons) and has no reading newer than `battery_check_seconds`, it emits one `{ type: 'read-battery' }` effect and does not emit another until a reading arrives or `battery_check_seconds` passes; a hold starts only after a reading allows it; a held session whose new reading does not allow it releases at once, without the idle grace, with reason `battery floor` or `battery unknown` (new members of `AwakeReleaseReason`); the next check is part of `nextDeadline` while a hold is wanted; nothing is read while no hold is wanted.
   `level1_battery_floor_percent = 0` turns the floor off: no reads and no battery release.
3. **Session** (`awake-session.ts`): `AwakeSessionOptions` gains `readBattery?: () => Promise<BatteryReading>` (default the real `readBattery`), the same seam pattern as `createHolder`; at most one read in flight; the result is fed back as the `battery` event; a thrown or rejected read is fed as unknown.
   Log lines, one per transition, never per read: `[Awake] Hold ended for ID (battery floor: P% on battery, floor F%)`, `[Awake] Hold refused for ID (battery floor: P% on battery, floor F%)` once until a hold is allowed again, and the same two with `battery unknown: REASON`.
4. **Configuration**, all in one commit (preamble item 9):
   - `level1_battery_floor_percent`: integer from 0 to 100, default 20 (0 means no floor);
   - `battery_check_seconds`: positive integer, default 60 (a warning below 10: every check spawns two processes);
   - `level1_battery_unknown_reads`: positive integer, default 2;
   - the slice 1 keys `question_hold_minutes`, `idle_grace_seconds`, `stuck_busy_minutes` and `ttl_minutes` keep their defaults and lose their maxima (remove `AWAKE_MAX_*` and the "(1 to N ...)" comments); they are positive integers whose milliseconds are safe integers (no timer ceiling);
   - the mechanism keys of level 1 and of the readings (Q16 (b)), each read once at process start and passed down as an option: `reading_deadline_ms` (default 2000), `reading_stdout_max_bytes` (262144), `reading_stderr_max_bytes` (65536) and `reading_kill_grace_ms` (500), passed to every G1 reader and to `readBattery`; `caffeinate_retry_delays_ms` (an array of integers, 0 or more, default `[500, 1000, 2000]`; its length is the number of retries, and an empty array means no retry), replacing `AWAKE_RETRY_DELAYS_MS` (`power/awake-session.ts:43`); `ttl_renewal_fraction` (a number above 0, default 0.8; a warning at 1 or more: the holder lapses before it is renewed), replacing `RENEWAL_FRACTION` (`power/awake-policy.ts:65`); and `caffeinate_renew_overlap_ms` (an integer, 0 or more, default 1000; a warning at 0: the target may be without an assertion for a moment), passed to `AwakeHolder`'s existing `renewOverlapMs` option (`power/awake-holder.ts:49`);
   - error texts in the existing style (`Invalid awake.KEY in PATH: must be ...`);
   - the generated `[awake]` section documents every level 1 key as `default X; set KEY = Y to change` and drops the "No battery floor yet" lines; `formatConfig` prints every key.
5. **Docs**: `keep-awake.md` replaces lines 40-41 with a "Battery floor" section (what is read, the AC and no-battery rules, unknown releases, the cadence, the log lines, that it is unverified on a MacBook until OG-G2); `AGENTS.md:248` drops "no battery floor yet" and mentions the floor; ADR 0050's table gains the `battery_check_seconds` row (default 60, slice 2) and the `level1_battery_unknown_reads` row (default 2), its status line says slice 2's floor shipped and that the level 1 keys have no maxima; `keep-awake.md` documents every level 1 key as `default X; set KEY = Y to change`.
The implementer may choose: names inside `battery.ts`, how the reducer stores the last reading, test names.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/G2/r1/`.
1. Parser tests over committed, redacted fixtures: the Mac mini pair gives `none`; each OG-CAP state gives its exact `battery` value (source, percent, `remainingMinutes` or null); derived negatives give unknown: installed Yes with no battery line, installed No with a battery line, two `BatteryInstalled` lines, a `'UPS Power'` source, empty output, a percent above 100.
2. Reducer tests: on battery below the floor no hold starts and one refusal is reported; a hold on battery that drops below the floor releases with `battery floor` and no grace; AC power at 5 percent holds; `none` holds; one unknown keeps a hold, two consecutive unknowns release it with `battery unknown`, and unknown never starts one; after a `none` no further `read-battery` is emitted; floor 0 emits no `read-battery`; no `read-battery` while idle; reads repeat no faster than `battery_check_seconds`; the existing level 1 tests pass with no assertion changed (adding the two new keys to their `AwakeConfig` literals, or building them from `DEFAULT_CONFIG.awake`, is the only edit allowed there, because `bun run typecheck` checks tests).
3. Wiring tests through `AwakeWiring` with a fixture-backed `readBattery` (the real `parseBattery` over a committed capture): one log line per transition, none per read; a rejected read releases.
4. Config tests:
   - defaults load;
   - each of the seven level 1 keys accepts a large value that the old maxima refused (for example `ttl_minutes = 600`, `question_hold_minutes = 2000`), refuses 0 or a negative, a wrong type and a value whose milliseconds exceed `Number.MAX_SAFE_INTEGER`, with the key's name in the error;
   - `level1_battery_floor_percent` refuses 101;
   - `battery_check_seconds = 5` loads with a warning;
   - the generated config round-trips through `loadConfig` to `DEFAULT_CONFIG.awake`, and each key's line reads `default X; set KEY = Y to change`;
   - the old rejection test and the old maximum rows (`awake-config.test.ts:65-91`) are replaced;
   - a config holding every slice 1 and slice 2 key loads.
   `long-timeout.ts`: with an injected underlying timer, a delay of 3000000000 ms is armed as 2147483647 ms and then the remainder, and fires once at the end; a delay below the limit is armed once; `clearLongTimeout` stops a chain midway.
   Per-key behavior: a reducer or wiring test per new key reads a non-default value through `loadConfig` and shows the change: a floor of 50 releases at 45 percent where 20 would not; `battery_check_seconds = 10` reads every 10 s; `level1_battery_unknown_reads = 1` releases on the first unknown; `ttl_renewal_fraction = 0.5` renews at half the TTL; `caffeinate_retry_delays_ms = [10]` retries once; `caffeinate_renew_overlap_ms = 50` stops the old holder 50 ms after the new one starts; `reading_deadline_ms`, `reading_stdout_max_bytes`, `reading_stderr_max_bytes` and `reading_kill_grace_ms` reach the readers (a battery read with `reading_stdout_max_bytes = 16` is unknown with `oversize`).
5. Real-daemon smoke on this Mac (darwin-only; it may skip only on a host whose `readBattery()` is not `none`, and must run here): a `cli.ts --daemon` under `env -i` with `[awake]` `level1_battery_floor_percent = 20`, `battery_check_seconds = 10` and `idle_grace_seconds = 1` holds a real `caffeinate` for its pid during a turn and releases after the grace (the existing smoke's method); a second daemon whose config has `level1_battery_floor_percent = 100` exits nonzero before listening, with `Invalid awake.level1_battery_floor_percent` in its output.
6. `mkdir -p /private/tmp/remi-canon-G2 && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-G2/ bun test packages/daemon/tests/power packages/daemon/tests/integration/keep-awake-daemon-smoke.test.ts` (plus the new smoke file if you add one) ends with `0 fail` and no skipped test on this Mac.
7. Revert checks, each with its failing log and a `revert-index.md` line: apply the floor on AC power (the AC row fails); treat unknown as allowed (its row fails); release on the first unknown with the default of 2 (its row fails); keep the old `ttl_minutes` maximum (the 600-minute row fails); keep the idle grace after a floor release (its row fails); add the key to `DEFAULT_CONFIG.awake` but not to the supported set (the config test fails).
8. Fixture privacy: `rg -n -i '/Users/|@[a-z0-9.-]+\.[a-z]{2,}|https?://' packages/daemon/tests/power/fixtures` prints nothing.
9. The PR body says what ships, that the floor is unverified on a MacBook until OG-G2, names Q2 and Q4 as answered or pending, and says "Part of #1773".

## Gates

`bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; Acceptance 6 passes in the canonical environment; hosted CI's `Test worker 0` to `2`, `Test` and the `local-relay` soak pass on the final head.

## Stop conditions

The OG-CAP folder is missing or has no on-battery capture (do not invent a laptop format; report); the captures disagree with each other on the battery line's grammar; a change outside the `[awake]` parts of `config.ts` would be needed; a darwin-only test cannot run on this Mac without a skip.

## Report

The preamble's report; one line per acceptance item goes into `report-details.md` in the evidence folder.
