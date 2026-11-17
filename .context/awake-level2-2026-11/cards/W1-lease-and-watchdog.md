# Card W1: root-boundary constants, the level 2 lease and the watchdog (issue #1773, guard-rails slice)

Status: ready
Tier: worker-hard
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: none (no Xcode, no simulator); macOS host (the script runs use `/usr/bin/plutil`, `/bin/ps` and `/usr/sbin/ioreg`)
Depends: none
Branch: `feature/issue-1773-awake-watchdog` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-w1` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (W1); ADR 0050 option (A), "Fail-safe design for level 2" items 1, 4, 5 and 6, slice 2 and slice 3 of "Slices and how each is tested without a lid"

## Goal

One module holds every root-boundary command remi will ever run or print for level 2, a second writes and validates the lease file, and a third generates the watchdog's POSIX script and the two launchd property lists, all tested without privileges: the watchdog script is run for real against a temporary remi home, the real `ioreg`, `ps`, `plutil` and `date`, and a recording stand-in for `sudo`, and nothing installs or runs anything as root.

## Context

Read first: ADR 0050 lines 42-59 (option A, the sudoers line, argument injection, failure modes), 90-104 (fail-safe design), 139-146 (slices), owner decision 1 (line 152, the boot LaunchDaemon), and the table (lines 162-185: `heartbeat_seconds` 30, `watchdog_interval_seconds` 60, `level2_revert_battery_percent` 30).

What the code does today (`develop` `bbcec7d6`, checked by the lead on 2026-11-17):
- Nothing in `packages/daemon/src` mentions `sudo`, `disablesleep`, a lease or a watchdog.
- The hub's own LaunchAgent property list is built in `packages/daemon/src/cli/service-templates.ts:40-62` (`buildLaunchAgentPlist`, label `com.yooz.remi`, `KeepAlive.SuccessfulExit = false`); it is the model for a property list builder.
- `remiHome()` (`packages/daemon/src/config/remi-home.ts`) is the only way to build a state path.

Facts the lead checked on this Mac on 2026-11-17 (read-only, a scratch file only):
- `/usr/bin/plutil -extract KEY raw -o - FILE` reads a field of a JSON file: an integer prints as digits, a string prints as is, a missing key exits 1 with "Could not extract value".
- `LC_ALL=C /bin/ps -o lstart= -p PID` prints the start time as `Tue Nov 17 06:09:43 2026` followed by trailing spaces, and exits 1 for a pid that does not exist.
- `/bin/date +%s` prints epoch seconds; `/usr/bin/jq` also exists on macOS 27.2 but is not used (older macOS releases lack it).
- `ioreg -r -c IOPMrootDomain -d 1` shows `"SleepDisabled" = No` on this Mac; `pmset -g batt` prints only `Now drawing from 'AC Power'` (no battery).
- The laptop line of `pmset -g batt` is UNVERIFIED (ADR 0050 line 126 recalls `-InternalBattery-0 ... 62%; discharging; 1:40 remaining`); OG-CAP captures the real one later and L2-CORE adds it to this card's tests.

## Scope

May change:
- new `packages/daemon/src/power/level2-commands.ts`, `packages/daemon/src/power/level2-lease.ts`, `packages/daemon/src/power/watchdog-script.ts`;
- new tests `packages/daemon/tests/power/level2-commands.test.ts`, `level2-lease.test.ts`, `watchdog-script.test.ts`, and fixtures under `packages/daemon/tests/power/fixtures/watchdog/`;
- `docs/agent-reference/keep-awake.md` (one section, "Level 2 building blocks (not wired)");
- the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/W1/r1/`.
Not in scope: anything that runs `sudo`, `pmset` (other than tests reading `-g`), `launchctl` or writes outside a temporary directory; `config/config.ts`; `cli.ts`; the hub; any caller of these modules.

## Decided design

Settled:

1. **`level2-commands.ts` is the one place** for the root boundary.
   It exports, as frozen constants: `SUDO_PATH = '/usr/bin/sudo'`, `PMSET_PATH = '/usr/bin/pmset'`, `IOREG_PATH = '/usr/sbin/ioreg'`, `PLUTIL_PATH = '/usr/bin/plutil'`, `PS_PATH = '/bin/ps'`, `DATE_PATH = '/bin/date'`, `LAUNCHCTL_PATH = '/bin/launchctl'`; `DISABLESLEEP_ON = ['-a', 'disablesleep', '1']` and `DISABLESLEEP_OFF = ['-a', 'disablesleep', '0']`; `sudoArgv(pmsetArgs)` returning `['-n', PMSET_PATH, ...pmsetArgs]`; `sudoListArgv(pmsetArgs)` returning `['-n', '-l', PMSET_PATH, ...pmsetArgs]` (sudo only lists whether the rule allows that exact command; nothing runs as root); `SUDOERS_FILE = '/etc/sudoers.d/remi-keep-awake'`; `BOOT_DAEMON_LABEL = 'com.yooz.remi.keep-awake-boot'` and `BOOT_DAEMON_PLIST = '/Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist'`; `WATCHDOG_LABEL = 'com.yooz.remi.keep-awake-watchdog'`.
   Builders: `sudoersLine(user)` returns exactly `USER ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0` built from `PMSET_PATH`, `DISABLESLEEP_ON` and `DISABLESLEEP_OFF` (never typed twice); `isSafeShortName(user)` accepts only `^[a-z_][a-z0-9_-]{0,31}$` and `sudoersLine` throws for anything else; `bootDaemonPlist()` returns a property list with `Label` `BOOT_DAEMON_LABEL`, `ProgramArguments` exactly `[PMSET_PATH, ...DISABLESLEEP_OFF]`, `RunAtLoad` true and no `KeepAlive`; `watchdogPlist({ scriptPath, intervalSeconds, logPath })` returns a property list with `Label` `WATCHDOG_LABEL`, `ProgramArguments` `['/bin/sh', scriptPath]`, `StartInterval` the integer, `RunAtLoad` true, and `StandardOutPath` and `StandardErrorPath` both `logPath`, with every string XML-escaped.
   `setupText({ user, remiHome })` returns the owner's printed instructions, which run nothing by themselves and never stage root content in a file the user can write (a same-user process could swap it between the check and the install): `D="$(sudo mktemp -d)"` (a directory owned by root, mode 0700); the sudoers line written with `sudo tee "$D/remi-keep-awake" >/dev/null` from a quoted here-document; `sudo visudo -cf "$D/remi-keep-awake"`; `sudo install -m 0440 -o root -g wheel "$D/remi-keep-awake" /etc/sudoers.d/remi-keep-awake`; `bootDaemonPlist()` written the same way to `"$D/boot.plist"`, `sudo plutil -lint "$D/boot.plist"`, `sudo install -m 0644 -o root -g wheel "$D/boot.plist" /Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist`, `sudo launchctl bootstrap system /Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist`; the removal of the staging directory with `sudo`; then the checks `sudo -n -l /usr/bin/pmset -a disablesleep 1` and `sudo -n -l /usr/bin/pmset -a disablesleep 0` (both must print the command: a rule that allows the enable but not the revert must never be in place), and `sudo cat /etc/sudoers.d/remi-keep-awake` and `sudo plutil -p /Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist` for the owner to compare with `docs/agent-reference/keep-awake.md`; one paragraph on why the rule must not be widened (ADR 0050 line 56: `pmset` with any arguments allows `hibernatefile`, `tcpkeepalive 0`, `schedule`, `autorestart`, `restoredefaults`); and `removalText({ remiHome })`, which starts with `REMI_HOME=... remi keep-awake stop` and a check that `ioreg -r -c IOPMrootDomain -d 1` shows `"SleepDisabled" = No`, then removes the sudoers file, boots out and removes the boot daemon, boots out and removes the watchdog agent and its script, and ends with the owner's own `sudo /usr/bin/pmset -a disablesleep 0` (it only clears the flag).
   The commands are produced from the constants, so the printed text and what remi runs cannot drift.
   No `sleepnow` constant (owner decision 6 applies only if owner gate OG-L2 (b) needs it; a later card adds it).
2. **The lease** (`level2-lease.ts`): path `REMIHOME/keep-awake/lease.json`, the directory created with mode 0700, the file written with mode 0600 through a temporary file in the same directory, `fsync`, then `rename` (never a partial file).
   Schema version 1, exactly these keys: `version` (1), `hubPid`, `hubStartTime` (the trimmed `LC_ALL=C TZ=UTC0 ps -o lstart= -p PID` string; `ps` prints local time, which a time-zone change while traveling would alter), `startedAt`, `expiresAt`, `heartbeatAt` (all integer epoch seconds), `staleSeconds`, `revertBatteryPercent` (integers; copied from configuration so the watchdog needs no configuration parser).
   `readLease(remiHome)` returns `{ kind: 'none' }`, `{ kind: 'valid', lease }` or `{ kind: 'invalid', reason }` (an extra or missing key, a wrong type, a non-integer, version other than 1, unparsable JSON, a file larger than 4 KiB, a symlink or a file not owned by the current user are all invalid); `deleteLease`; `processStartTime(pid)` (spawns `PS_PATH` with `LC_ALL=C` and `TZ=UTC0`, 2 s deadline, returns the trimmed string or null); `leaseOwnedBy(lease, pid, startTime)`.
3. **The watchdog script** (`watchdog-script.ts`): `buildWatchdogScript({ remiHome, tools, revertArgv })` returns POSIX `sh` text; `tools` defaults to `{ ioreg: IOREG_PATH, pmset: PMSET_PATH, plutil: PLUTIL_PATH, ps: PS_PATH, date: DATE_PATH }` and `revertArgv` defaults to `[SUDO_PATH, ...sudoArgv(DISABLESLEEP_OFF)]`; tests pass absolute paths of their own executables for both, production never does (L2-CLI writes the script with the defaults).
   `remiHome` must be absolute and contain no single quote, newline or other control character (throw otherwise); every embedded value is single-quoted.
   The script sets `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `LC_ALL=C` and `TZ=UTC0`, runs every child command under a 10 s deadline written in `sh` (start it in the background, wait, kill it at the deadline; a hung child would otherwise stop every later run, since launchd does not start a job that is still running; `/usr/bin/timeout` is not used because older macOS releases lack it), uses no `jq`, and decides in this order:
   a. Read `SleepDisabled` with `ioreg -r -c IOPMrootDomain -d 1`: `Yes` or `No` only when exactly one line matches, else unreadable.
   b. `No`: if a lease exists and is expired or its hub is gone (the tests of e and f), delete that lease with no action, since a lease left by a crash before the enable, a failed enable or a reboot must not later turn into a revert of a flag remi did not set; then exit 0.
      No lease file: exit 0, whatever the flag (ADR 0050 line 97: the flag is not remi's).
   c. Unreadable with a lease present: revert (reason `flag unreadable`).
   d. Read each lease field with `plutil -extract KEY raw -o - LEASE`; any failure, a non-integer where an integer is required, or `version` other than 1: revert (`lease invalid`).
   e. `now` from `date +%s`: `now >= expiresAt` reverts (`expired`); `now - heartbeatAt > staleSeconds` reverts (`heartbeat stale`), and so does `heartbeatAt > now + staleSeconds` (a backward clock step must not hide a hung hub).
   f. `ps -o lstart= -p hubPid`, trimmed, not equal to `hubStartTime` (including a dead pid) reverts (`hub gone`).
   g. `pmset -g batt`: when its first line says `Now drawing from 'Battery Power'`, the first `N%` token is read; `N <= revertBatteryPercent` reverts (`battery`), and no percent token on battery power reverts (`battery unreadable`); on AC power the battery rule does not apply.
   h. Revert: append one line `UTC-TIMESTAMP revert REASON` to standard output (the property list sends it to the watchdog log), run `revertArgv` exactly, re-read `SleepDisabled`, and delete the lease only when the action exited 0, the flag now reads `No`, and the lease file still holds the `hubPid` and `startedAt` it read (it never deletes a newer lease); otherwise keep the lease (the next run retries) and log `revert failed REASON`.
      The script logs nothing else (no lease contents).
   The script always exits 0.
4. **Tests run the real script** with `/bin/sh` under `env -i` in a temporary directory, with the real `plutil`, `ps` and `date`; `ioreg` and `pmset` are small executables in the test's temporary directory that print a fixture (the Mac mini's real `ioreg` and `pmset -g batt` output captured into `fixtures/watchdog/`, plus copies with `No` replaced by `Yes` or with an assumed laptop battery line, each named for its edit and marked in `fixtures/watchdog/SOURCE.md` as derived, the laptop shape as ADR 0050's unverified recollection), and the `revertArgv` stand-in is an executable that records its argv to a file and writes `No` into the state file the fake `ioreg` reads (a variant exits 1 and leaves `Yes`).
   One test uses the real `/usr/sbin/ioreg` (this Mac reads `No`) with a lease present and asserts that nothing is recorded.
   This stand-in sits exactly at the root boundary, which ADR 0050 slice 3 names as the one substitute; the decision logic under test is the production script text.
   This replaces slice 2's "dry-run flag" with tool paths and a revert argv fixed when the script is generated, plus fake `ioreg` and `pmset` executables that print captured output; the production script has no dry-run mode.
The implementer may choose: helper names, the script's internal function names and comments, the fixture file names, test names.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/W1/r1/`.
1. One-constant tests: the two commands in `sudoersLine('owner')` equal `PMSET_PATH` joined with `DISABLESLEEP_ON` and with `DISABLESLEEP_OFF`; `bootDaemonPlist()`'s `ProgramArguments` equal `[PMSET_PATH, ...DISABLESLEEP_OFF]`; the production watchdog script's revert line runs exactly `[SUDO_PATH, '-n', PMSET_PATH, '-a', 'disablesleep', '0']`; `setupText` contains `sudoersLine(user)` verbatim; a test that parses `setupText` finds every `sudo install` source and every `sudo tee` target inside the `sudo mktemp -d` directory and no root content written through any other path, and both `sudo -n -l` checks; `removalText` starts with the stop and the flag check and ends with `sudo /usr/bin/pmset -a disablesleep 0`; and a source scan of `packages/daemon/src` finds the string literals `'/usr/bin/sudo'` and `'disablesleep'` only in `power/level2-commands.ts`.
2. `isSafeShortName` refuses `root ALL`, `a,b`, `a b`, `ALL`, an empty string, a 33-character name, a name with a newline and one starting with a digit, and `sudoersLine` throws for each; `owner` and `_test-user` pass.
3. On macOS, `plutil -lint` accepts both generated property lists written to a temporary directory, and a `remiHome` containing `&`, `<` or `"` is escaped in the watchdog property list and refused (single quote, newline) or quoted in the script as item 3 says.
4. Lease tests: a written lease reads back `valid` with equal fields; the file mode is 0600 and the directory 0700 (`statSync`); each invalid case of item 2 gives `invalid`; a crash between the temporary write and the rename (simulated by writing only the temporary file) leaves `readLease` at `none` or the previous valid lease; `processStartTime(process.pid)` is non-null and stable across two calls, and `processStartTime` of a reaped child's pid is null.
5. Script runs (darwin): with the flag `No`, nothing is recorded and the lease stays; `Yes` with no lease: nothing recorded; `Yes` with a lease that is expired, stale, malformed, version 2, missing `hubPid`, owned by a dead pid, owned by a live pid whose start time differs, or on battery power at or below `revertBatteryPercent` (derived fixture): exactly one recorded revert with the expected argv, one log line with the expected reason, and the lease deleted; `Yes` with a fresh lease owned by the test process (its real `processStartTime`) on AC power: nothing recorded; an unreadable flag with a lease present: one revert; the failing stand-in: the lease is kept and `revert failed` is logged; the real-`ioreg` run: nothing recorded; with the flag `No`, an expired lease and one whose hub is gone are deleted with nothing recorded and a fresh one stays; a lease whose `heartbeatAt` lies more than `staleSeconds` in the future reverts; a lease written by a process with `TZ=Asia/Tokyo` and checked by the script started with `TZ=America/Los_Angeles` does not revert; a fake `ioreg` that sleeps 30 s ends the run within 15 s with the flag treated as unreadable; a lease replaced between the read and the revert is not deleted.
6. `mkdir -p /private/tmp/remi-canon-W1 && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-W1/ bun test packages/daemon/tests/power/level2-commands.test.ts packages/daemon/tests/power/level2-lease.test.ts packages/daemon/tests/power/watchdog-script.test.ts` ends with `0 fail` and no skipped test on this Mac.
7. Revert checks, each with its failing log and a `revert-index.md` line: type the sudoers line's second command by hand with `disablesleep 2` (item 1 fails); drop the `hubStartTime` comparison from the script (the reused-pid case fails); delete the lease before checking the action's result (the failing stand-in case fails); accept version 2 (its case fails); run `ps` without `TZ=UTC0` in the script (the time-zone case fails).
8. `docs/agent-reference/keep-awake.md` says what these modules are, that nothing runs or installs them yet, and that the laptop battery line in the watchdog is unverified until OG-CAP; the PR body says the same, with "Part of #1773".

## Gates

`bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; Acceptance 6 passes in the canonical environment; hosted CI's `Test worker 0` to `2` and `Test` pass on the final head.

## Stop conditions

A test or helper would run `sudo`, a power-changing `pmset`, or `launchctl` against a real domain (stop; that is preamble item 5); `plutil` or `ps` behave differently from the Context facts (report the difference); the script cannot be made to fail closed for one of item 3's cases without a design change (report which).

## Report

The preamble's report; one line per acceptance item goes into `report-details.md` in the evidence folder.
