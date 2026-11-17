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

ADR 0050's level 2 (lid-closed mode, option A) has three modules under `packages/daemon/src/power/`, and **nothing runs, prints or installs any of them yet**: no code calls them, remi runs no `sudo`, changes no power setting, writes no lease, and installs no sudoers file, LaunchDaemon, LaunchAgent or watchdog script.
Later slices wire them (the hub's controller, then the `remi keep-awake` command, which does not exist yet).

- `level2-commands.ts`, the root boundary: the absolute paths (`/usr/bin/sudo`, `/usr/bin/pmset`, `/usr/sbin/ioreg`, `/usr/bin/plutil`, `/bin/ps`, `/bin/date`, `/bin/launchctl`), the `pmset` arguments that set and clear the flag, the `sudo -n` and `sudo -n -l` argument builders, the sudoers line, the boot LaunchDaemon and watchdog LaunchAgent property lists, and the owner's setup and removal texts.
  It is the only file under `packages/daemon/src` that names `/usr/bin/sudo` or the `pmset` keyword for the flag (a source-scan test), and the printed texts are built from the same constants as the commands remi will run.
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
The rule follows as `visudo -cf ... && install ...`; the text tells the person to stop and run the removal steps if `visudo` prints anything but "parsed OK", or if any step fails.
Then it removes the staging directory and checks the rule: `sudo -k` (so no cached password helps), plain `sudo -n -l`, which must list `(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0`, `sudo -n -l` for each command, `sudo -k` again and `sudo -n /usr/bin/pmset -a disablesleep 0`, which must finish without a password prompt.
What these checks show: the rule is installed, sudo reads it, and the revert runs as root with no password.
What they do not show: that the enable runs without a password (running it would set the flag), anything about the lid or the battery, or what other rules on the Mac allow (the listing shows them; the person reads it).
Last, it prints the installed files and `sudo launchctl print system/com.yooz.remi.keep-awake-boot` for the person to compare with this page.
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
  Work directories and claims older than `orphanMaxAgeSeconds` are removed.
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
