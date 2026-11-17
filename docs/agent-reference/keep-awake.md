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

### What the owner installs

The sudoers line, for a user whose short name matches `^[a-z_][a-z0-9_-]{0,31}$` (any other name is refused):

```
<user> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0
```

It goes in `/etc/sudoers.d/remi-keep-awake`, mode 0440, owner root, group wheel.
Do not widen it: sudoers matches listed arguments exactly, and a rule naming `/usr/bin/pmset` with no arguments allows any arguments, among them `hibernatefile`, `tcpkeepalive 0` (breaks Find My Mac), `schedule`, `autorestart` and `restoredefaults` (ADR 0050, option A).

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

The setup text (`setupText`) stages both files only in a directory that root creates with `sudo mktemp -d /private/tmp/remi-keep-awake.XXXXXX` (mode 0700 inside the sticky `/private/tmp`), writes them there with `sudo tee` from quoted here-documents, checks them there (`visudo -cf`, `plutil -lint`), installs them from there with `sudo install`, loads the daemon (`launchctl bootstrap system`, which runs it once and only clears the flag), removes the directory, and then has the owner run `sudo -n -l` for both commands; each must print the command, since a rule that allows the enable but not the revert must never stay in place.
The removal text (`removalText`) starts with `remi keep-awake stop` and a check that `ioreg` reads `"SleepDisabled" = No`, removes the sudoers file, the boot daemon, the watchdog agent and its script, and ends with the owner's own `sudo /usr/bin/pmset -a disablesleep 0`.

### The lease

`REMIHOME/keep-awake/lease.json`, the directory mode 0700, the file mode 0600, written through a temporary file in the same directory, `fsync` and `rename`, so a reader sees the previous lease or the new one.
Version 1 has exactly the keys `version`, `hubPid`, `hubStartTime`, `startedAt`, `expiresAt`, `heartbeatAt` (integer epoch seconds), `staleSeconds` and `revertBatteryPercent` (copied from the configuration, so the watchdog parses none).
`hubStartTime` is `LC_ALL=C TZ=UTC0 ps -o lstart= -p PID`, trimmed: `ps` prints local time, and a time-zone change while traveling must not make a live hub look gone.
`readLease` calls a lease invalid for an extra or missing key, a wrong type, a non-integer, a version other than 1, unparsable JSON, more than 4 KiB, a symlink, a file that is not regular, or a file the current user does not own; `writeLease` refuses to write a lease the reader would call invalid.
The lease is crash safety, not a security boundary: any process of the same user can delete or rewrite it.

### The watchdog script

`buildWatchdogScript({ remiHome })` returns the script a user LaunchAgent (`watchdogPlist`, label `com.yooz.remi.keep-awake-watchdog`) will run with `/bin/sh`; the planned paths are `REMIHOME/keep-awake/watchdog.sh` and `REMIHOME/keep-awake/watchdog.log`.
It sets `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `LC_ALL=C` and `TZ=UTC0`, uses no `jq` and no `timeout`, and runs each command that reads state or moves the lease under a 10-second deadline written in `sh` (a hung child would stop every later run, because launchd does not start a job that is still running).
It decides:

- **No lease file:** exit, whatever the flag reads (the flag is not remi's then); this is checked first, so nothing else runs while level 2 is off.
- **`SleepDisabled` unreadable** (not exactly one `"SleepDisabled" = Yes` or `No` line in `ioreg -r -c IOPMrootDomain -d 1`): revert, reason `flag unreadable`.
- **`SleepDisabled` No:** revert nothing; delete a valid lease that is expired, stale or whose hub is gone, so a lease left by a crash before the enable, a failed enable or a reboot can never later revert a flag remi did not set.
  An invalid lease is left for the hub.
- **`SleepDisabled` Yes**, the first that holds: the lease is invalid (`lease invalid`); `now >= expiresAt` (`expired`); the heartbeat is more than `staleSeconds` old or more than `staleSeconds` ahead of the clock (`heartbeat stale`); `ps` does not print `hubStartTime` for `hubPid`, a dead or reused pid (`hub gone`); on battery power, at or under `revertBatteryPercent` (`battery`).
  Two reasons go beyond ADR 0050's list, both toward sleep: `clock unreadable` when `date` fails, and `battery unreadable` when `pmset -g batt` fails, when its first line names neither AC nor battery power, or when it shows no percent on battery power.
- **Revert:** log `UTC-TIMESTAMP revert REASON`, run the revert command (`/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0`, fixed when the script is generated), read the flag again, and delete the lease only when the command exited 0, the flag reads No, and the lease still holds the `hubPid` and `startedAt` this run read; the lease is renamed aside first and linked back if it changed, so a newer lease is never deleted.
  Otherwise the lease stays (the next run retries) and the script logs `UTC-TIMESTAMP revert failed REASON`.
  It logs nothing else and always exits 0.

The script reads each lease field with `plutil -extract KEY raw`, which prints a string of digits, or an array as its count, the same way as an integer; `readLease` catches those types, the script does not.

### How these are tested

`packages/daemon/tests/power/level2-commands.test.ts`, `level2-lease.test.ts` and `watchdog-script.test.ts`, on macOS, without privileges.
The watchdog tests run the generated script with `/bin/sh` and an empty environment against a temporary remi home, the real `plutil`, `ps` and `date`, fake `ioreg` and `pmset` executables that print `fixtures/watchdog/` captures (one test uses the real `ioreg`), and a stand-in at the root boundary in place of `sudo` that records its arguments and writes the new flag where the fake `ioreg` reads it.
The production script's revert line is checked as text and never run.

### Not verified for level 2

The laptop battery line the watchdog parses is UNVERIFIED until owner gate OG-CAP captures a MacBook on battery: the fixtures follow ADR 0050's recollection (`-InternalBattery-0 ... 62%; discharging; 1:40 remaining`).
Whether `sudo -n -l` prints the command for an installed rule, whether `/etc/sudoers` reads `/etc/sudoers.d` on macOS 27.2, and every lid behavior (ADR 0050's hardware checks) are not verified here.

## Not verified

Level 1 does not implement a lid-closed mode and cannot override lid-close or emergency low-battery sleep.
Not verified by this slice: a MacBook on battery, behavior with the lid closed, and behavior across a real system sleep.
Whether `performance.now()` advances during system sleep is not checked; if it does, the first tick after wake can release a held session as the stuck bound, and the next turn or busy status holds again.
