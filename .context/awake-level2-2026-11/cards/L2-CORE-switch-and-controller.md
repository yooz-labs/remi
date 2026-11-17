# Card L2-CORE: the privileged switch and the hub's level 2 controller (issue #1773, slice 3)

Status: ready
Tier: worker-hard
Timebox: L, 1.5 days; escalate at 3 days or two failed approaches
Needs: none (no Xcode, no simulator); macOS host
Depends: CP-L2 (which waits for G0, G1, G2, W1, L2-POL merged, OG-CAP recorded and the owner's answers to Q1 to Q3)
Branch: `feature/issue-1773-level2-core` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-l2core` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (L2-CORE); ADR 0050 "Recommended decision", "Fail-safe design for level 2" items 1 to 6, "What counts as real work" (last paragraph), "Battery, thermal, duration and display inputs", slice 3

## Goal

A `Level2Controller` that the hub can own (not yet wired: L2-HUB does that) starts, extends, stops and reverts level 2 exactly as the L2-POL reducer decides, writes the lease before it turns sleep off, reads every guard on a heartbeat, blanks the display on a lid close, reverts on shutdown (async and synchronous paths) and at startup reverts a lease it does not own; the only code that can run `sudo` is a `SudoPmsetSwitch` built from W1's constants, and every test drives it through a recording stand-in at that root boundary, never through `sudo`.

## Context

Read first, at your base (the CP-L2 lead re-verified these on the `develop` tip named in the live facts): ADR 0050 lines 83-114 and 124-146; the merged modules `packages/daemon/src/power/level2-commands.ts`, `level2-lease.ts`, `watchdog-script.ts` (W1), `level2-settings.ts`, `level2-policy.ts`, `level2-foreign-holders.ts` (L2-POL), `readings/run-reading.ts`, `readings/assertions.ts`, `readings/thermal.ts`, `readings/root-domain.ts` (G1), `readings/battery.ts` (G2); the note `.context/awake-password-on-wake.md` (G0) and its "Consequences for L2-CORE".

What the code does today (`develop` `bbcec7d6`, checked by the lead on 2026-11-17; the CP-L2 lead re-checks):
- The live-sessions registry: `LiveSessionEntry` has `pid` and `wsPort` (`packages/daemon/src/session/session-registry-file.ts:41-42`), `claudeChildPid` (around line 61) and `pendingQuestions` (line 84); `SessionRegistryFile#listLive()` is at line 278; the hub builds its question census from it (`packages/daemon/src/cli/hub-question-census.ts:19`, used at `cli.ts:2530`).
- Each session daemon writes its status, including `sessionStatus`, to `REMIHOME/status-PORT.json` (`cli.ts:1127` sets the path; `cli/session-phases/message-api-setup.ts:207` writes `sessionStatus`); busy statuses are `thinking`, `executing` and `waiting` (ADR 0050 line 108).
  A turn that only reasons reads `idle` there (ADR 0050 line 109), a known limit of the idle revert.
- The owner-captured MacBook readings are in `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/captures/OG-CAP/` (states: AC idle, battery idle, battery with a Safari video, battery in a call; see `owner-gates.md`).

## Scope

May change:
- new `packages/daemon/src/power/level2-switch.ts`, `level2-controller.ts`, `level2-census.ts`, `level2-readings.ts`, `readings/screen-lock.ts`, `readings/launchd.ts`;
- `packages/daemon/src/power/readings/run-reading.ts` (allowlist entries for the two new readers, each with its argument guard), `readings/assertions.ts` (only if an OG-CAP capture does not parse), `level2-commands.ts` (a `DISPLAYSLEEPNOW` constant only);
- tests under `packages/daemon/tests/power/` (including `watchdog-script.test.ts`, whose assumed laptop battery fixture is replaced by redacted OG-CAP captures), fixtures under `packages/daemon/tests/power/fixtures/` with `SOURCE.md`;
- `docs/agent-reference/keep-awake.md` (the "Level 2 building blocks (not wired)" section);
- the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-CORE/r1/`.
Not in scope: `cli.ts`, `config/config.ts`, the server and adapters (L2-HUB); the CLI command (L2-CLI); the protocol; any test that runs `sudo`, a power-changing `pmset` or a writing `launchctl`.

## Decided design

Settled:

1. **The switch** (`level2-switch.ts`): interface `Level2Switch { enable(); disable(); disableSync(); displaySleepNow() }`, each returning `{ ok: true }` or `{ ok: false, reason }` with `reason` one of `sudo-refused` (nonzero exit), `timeout`, `spawn-failed`, `read-back-mismatch`, `read-back-unknown`.
   `SudoPmsetSwitch` runs `[SUDO_PATH, ...sudoArgv(DISABLESLEEP_ON)]` or `[SUDO_PATH, ...sudoArgv(DISABLESLEEP_OFF)]` with `shell: false`, `stdio: 'ignore'`, environment `{ LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }`, a 5 s deadline (SIGKILL after), then reads `SleepDisabled` back with G1's `readRootDomain`: enable must read `yes` (on `no` or unknown it runs the disable argv once and reports the mismatch), disable must read `no`.
   `disableSync` does the same with `spawnSync` and a 3 s timeout (for the `exit` listener).
   `displaySleepNow` runs `[PMSET_PATH, ...DISPLAYSLEEPNOW]` with no `sudo` (ADR 0050 line 129: UNVERIFIED that it needs no root; OG-L2 checks it).
   The constructor takes optional `spawnRoot` and `spawnRootSync` (default: the real spawns above) and `readRootDomain` (default G1's): this is the root-boundary substitute ADR 0050 slice 3 allows, and tests use only that.
   Nothing outside `level2-switch.ts` spawns `SUDO_PATH`.
2. **Readers added**: `readings/screen-lock.ts` implements G0's settled source and parse rule exactly (only "immediately" is `on`; everything else, including a delay, a failure or a "not settled" G0, is `off` or `unknown` as the note says); `readings/launchd.ts` reads `launchctl print gui/UID/com.yooz.remi.keep-awake-watchdog` (UID from `process.getuid()`): exit 0 is `loaded`, the not-found exit code observed on this Mac is `missing`, anything else `unknown`.
   `runReading` allows `/bin/launchctl` only with first argument exactly `print`, and G0's executable only with G0's exact arguments.
3. **Readings aggregate** (`level2-readings.ts`): `Level2Readings` with `read(remiPids)` returning L2-POL's inputs: battery (G2), thermal and root domain (G1), the foreign holders (G1's assertions classified by L2-POL's `classifyForeignHolders` with the settings' ignore list), password on wake, watchdog; all readers run in parallel, each already bounded.
   `MacLevel2Readings` is the real implementation; tests use the same class over fixture text (the real parsers, a scenario choosing which committed capture each reader returns), so no parser or rule is replaced.
4. **Census** (`level2-census.ts`): `live` is the number of `listLive()` entries; `working` counts entries with a nonempty `pendingQuestions` or a `sessionStatus` of `thinking`, `executing` or `waiting` in their `status-PORT.json` (read with a 64 KiB cap; unreadable counts as not working); `remiPids` is the hub's pid plus every entry's `pid` and `claudeChildPid`.
5. **The controller** (`level2-controller.ts`), constructed with settings, `remiHome`, `hubPid`, a `Level2Switch`, a `Level2Readings`, a census function, a clock (`now()` monotonic milliseconds, `wallNow()` epoch seconds, `setTimer`, `clearTimer`, the `AwakeClock` shape of `awake-session.ts:22-26` plus `wallNow`), a log function and an optional `onStatus` callback.
   Operations are serialized (one at a time).
   Methods:
   - `reconcileAtStartup()`: no lease, nothing; a lease (valid or not; a new hub never owns an earlier lease) with the flag `yes` or unreadable: `disable()`, then delete the lease only when the flag reads `no`; with the flag `no`: delete the lease, no switch call.
     It never turns level 2 on (ADR 0050 line 98).
   - `start(hours?)`, `extend(hours)`, `stop()`, `status()`: through the L2-POL reducer.
     On `enable`: write the lease first (W1's `writeLease`: `hubPid`, `hubStartTime` from `processStartTime(hubPid)`, `startedAt` and `heartbeatAt` now, `expiresAt` from the reducer's expiry converted to wall time, `staleSeconds` from `lease_stale_seconds`, `revertBatteryPercent` from the settings); a failed write is `enable-failed` with `lease-write-failed` and no switch call; then `switch.enable()`; a failure deletes the lease and is `enable-failed` with `switch-failed`.
   - Heartbeat every `heartbeat_seconds` while `starting`, `on` or `reverting`: rewrite the lease's `heartbeatAt` (and `expiresAt` after an extend) atomically, a failure being `heartbeat-failed`; read; step `beat`; apply effects: `disable` runs `switch.disable()` and deletes the lease on success, keeps it on failure (the watchdog retries too); `forget` deletes the lease with no switch call; `notify` logs one line with process names only.
   - Lid: when the root domain's `clamshell` changes to `closed` while `on`, call `displaySleepNow()` once; again only after it was seen `open`.
   - `shutdown()` (for the hub's async cleanup, at most 3 s) and `shutdownSync()` (for the `exit` listener): when not `off`, disable and delete the lease on success; stop the timers.
   - `status()` returns `{ level2: 'off' | 'starting' | 'on' | 'reverting', allowed: settings.level2, reason, startedAt, expiresAt, capAt (ISO 8601 UTC), battery: { source, percent } or the reading's kind, thermal, sleepDisabled, foreignHolders: process names, lastRefusal, lastRevert }`; `onStatus` fires on each change.
   - Logs: prefix `[Awake2]`, one line per transition (start, refusal with reason, revert with reason, foreign-holder notice, lid display sleep, reconcile, switch failure), never per heartbeat, never lease contents beyond reasons, never assertion names.
6. **Fixtures**: redacted OG-CAP captures for the Safari-video and call states feed the classifier through G1's real parser; the laptop `pmset -g batt` captures replace W1's assumed laptop line in `watchdog-script.test.ts`.
The implementer may choose: internal structure of the controller, timer handling details within the clock interface, test names, scenario helper names.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-CORE/r1/`.
1. Switch tests with recording `spawnRoot` and `spawnRootSync`: the argv of enable, disable and `disableSync` equal the constants exactly; enable with read-back `yes` is ok; read-back `no` or unknown reports the mismatch and records exactly one disable argv after the enable argv; a nonzero exit is `sudo-refused` with no read-back taken as success; a deadline overrun is `timeout`; `displaySleepNow` records `[PMSET_PATH, 'displaysleepnow']` and never `SUDO_PATH`.
2. Controller tests in a temporary remi home with a real `SessionRegistryFile` whose entries use the test's own pid, the recording switch, fixture-backed `MacLevel2Readings` and a test clock: (a) at the moment `enable` is recorded the lease file exists with mode 0600 and the expected fields; (b) every refusal leaves no lease and records no switch call; (c) each revert of L2-POL item 7 reached through readings or the census gives exactly one disable, deletes the lease and logs one line; (d) a failing disable keeps the lease and retries on each beat; (e) a flag read `no` while on deletes the lease and records no call; (f) `heartbeatAt` strictly increases across beats, and a lease directory made unwritable reverts with `heartbeat-failed`; (g) `reconcileAtStartup` with a foreign lease and the flag `yes` records one disable and deletes the lease, with the flag `no` records nothing and deletes it, with a failing disable keeps it, and never records an enable; (h) `shutdown` and `shutdownSync` each record one disable when on and nothing when off; (i) a lid closing records one `displaySleepNow`, staying closed records no second one; (j) the OG-CAP Safari-video capture refuses a start with `foreign-holder` naming the redacted process, and appearing mid-period logs one notice and reverts after `foreign_holder_revert_minutes`.
3. Reader tests: the screen-lock parser over G0's recorded outputs (committed as fixtures) gives the note's mapping; `runReading` refuses `/bin/launchctl` with `bootstrap`, `bootout`, `load`, `unload` and `kickstart` without spawning; darwin-only live reads of the watchdog state and the screen-lock setting return a value other than unknown (or, if G0 is "not settled", the screen-lock read returns unknown as the note says).
4. Guard tests: a scan of `packages/daemon/src` finds `'/usr/bin/sudo'`, `'disablesleep'`, `'displaysleepnow'` and `'sleepnow'` string literals only in `power/level2-commands.ts`; a scan of `packages/daemon/tests` finds no `new SudoPmsetSwitch(` without a `spawnRoot` argument; a scan of `packages/daemon/src` finds no `new SudoPmsetSwitch(` at all (L2-HUB adds the one in `cli.ts` and updates this test).
5. `mkdir -p /private/tmp/remi-canon-L2-CORE && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-L2-CORE/ bun test packages/daemon/tests/power` ends with `0 fail` and no skipped test on this Mac.
6. Revert checks, each with its failing log and a `revert-index.md` line: write the lease after `enable` (2a fails); skip the disable in `shutdown` (2h fails); let reconcile re-enable a lease that is still fresh (2g fails); drop the read-back (a test of item 1 fails); call `disable` on `forget` (2e fails).
7. The PR body says that nothing runs this code yet (L2-HUB wires it), lists what is unverified until OG-L2 (the sudoers rule, `displaysleepnow` without root, the lid reading on a MacBook), and says "Part of #1773".

## Gates

`bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; Acceptance 5 passes in the canonical environment; hosted CI's `Test worker 0` to `2`, `Test` and the `local-relay` soak pass on the final head.

## Stop conditions

Anything would run `sudo` or a power-changing command outside the recording stand-in; an OG-CAP capture does not parse and G1's parser cannot take it without loosening its fail-closed rule (report the shape); G0's note is "not settled" and the CP-L2 decision in the live facts does not say how to proceed; the reducer's contract (L2-POL) would have to change.

## Report

The preamble's report; one line per acceptance item goes into `report-details.md` in the evidence folder.
