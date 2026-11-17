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
Each run has no shell, no stdin, an environment of `LC_ALL=C` and `PATH` only, a 2 s deadline and a 256 KiB stdout cap, and a failure never throws.
The child leads its own process group, and a timeout or oversize kill reaches the group (a wrapper shell's children too).
The parsers are tested against redacted captures of a Mac16,11 (`packages/daemon/tests/power/fixtures/mac16-11-macos-27.2/`, with its `SOURCE.md`).
Both text parsers need the end of the output: the assertions reading is unknown unless the `Kernel Assertions:` header was seen, and the root-domain reading is unknown unless the property block's closing brace was.
`absent` for the lid means the key is not listed in a complete read; it is not proof that the Mac has no lid.
A thermal `nominal` is not proof of health: `notifyutil -g` prints 0 for a notification nobody posted, and `pmset -g therm` cannot cross-check it (a healthy Mac and a dead key both read "No thermal warning level has been recorded"; the text of a recorded warning is UNVERIFIED), so a caller treats `nominal` as "no pressure reported" and only a level above it as a signal.
Not verified: the lid reading on a laptop (the capture is a Mac mini; the `clamshell` fixtures are edited, not captured), that every Mac prints the `Kernel Assertions:` header, and the assertions text on other macOS builds.
Battery (`pmset -g batt`) and the password-on-wake reading are later slices.

## Not verified

Level 1 does not implement a lid-closed mode and cannot override lid-close or emergency low-battery sleep.
Not verified by this slice: a MacBook on battery, behavior with the lid closed, and behavior across a real system sleep.
Whether `performance.now()` advances during system sleep is not checked; if it does, the first tick after wake can release a held session as the stuck bound, and the next turn or busy status holds again.
