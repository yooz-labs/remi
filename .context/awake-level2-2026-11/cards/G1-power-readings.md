# Card G1: macOS power readings without privileges (issue #1773, guard-rails slice)

Status: ready
Tier: worker
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: none (no Xcode, no simulator); macOS host (the readers' live tests run only on macOS)
Depends: none
Branch: `feature/issue-1773-power-readings` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-g1` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (G1); ADR 0050 sections "Refusing while another app holds the Mac awake", "Battery, thermal, duration and display inputs" and slice 2 of "Slices and how each is tested without a lid"

## Goal

The daemon has pure parsers and bounded, read-only readers for `pmset -g assertions`, the thermal pressure level and the power root domain (`SleepDisabled`, `AppleClamshellState`), tested against redacted captures of this Mac and against the live tools, with no caller yet; battery is G2's.

## Context

Read first: ADR 0050 (`.context/decisions/0050-keep-the-mac-awake.md`), facts 4 and 5 (lines 29-31), the foreign-holder section (lines 116-122) and the inputs section (lines 124-129); `docs/agent-reference/keep-awake.md`.

What the code does today (`develop` `bbcec7d6`, checked by the lead on 2026-11-17):
- Level 1 lives in `packages/daemon/src/power/` (`awake-policy.ts`, `awake-session.ts`, `awake-holder.ts`, `awake-wiring.ts`); nothing reads `pmset`, `ioreg` or `notifyutil` in `packages/daemon/src` (the only `pmset` use is in tests).
- `awake-holder.ts:207-211` is the model for a spawn: an absolute executable, an argument array, `shell: false`.
- The tests already parse `pmset -g assertions` with two regular expressions (`packages/daemon/tests/integration/keep-awake-daemon-smoke.test.ts:27-44`: `^\s*pid (\d+)\(([^)]*)\):` and `Created for PID: (\d+)\b`), and `packages/daemon/tests/power/awake-holder.test.ts:217-290` shows how a darwin-only test starts a real `caffeinate -i -w PID -t N` for a child it owns and waits for it to go.

Facts the lead read on this Mac (Mac16,11, macOS 27.2 build 26B123) on 2026-11-17, read-only:
- `/usr/bin/notifyutil -g com.apple.system.thermalpressurelevel` prints `com.apple.system.thermalpressurelevel 0` and exits 0.
- The SDK maps the level on macOS as nominal 0, moderate 1, heavy 2, trapping 3, sleeping 4 (`/Volumes/S1/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/usr/include/libkern/OSThermalNotification.h:45-60`, the `TARGET_OS_OSX` branch at lines 47-52; the other branch, 10 to 50, is not macOS).
- `/usr/sbin/ioreg -r -c IOPMrootDomain -d 1` contains the line `"SleepDisabled" = No` and no `AppleClamshellState` key (a Mac mini has no lid).
- `/usr/bin/pmset -g therm` prints three "Note: No ... has been recorded" lines (a second thermal source the ADR names; not used by this card).
- `/usr/bin/pmset`, `/usr/sbin/ioreg` and `/usr/bin/notifyutil` exist, owned by root, mode 0755.

## Scope

May change:
- new `packages/daemon/src/power/readings/run-reading.ts`, `assertions.ts`, `thermal.ts`, `root-domain.ts`;
- new tests `packages/daemon/tests/power/readings/*.test.ts`;
- new fixtures under `packages/daemon/tests/power/fixtures/mac16-11-macos-27.2/` with a `SOURCE.md`;
- `docs/agent-reference/keep-awake.md` (one short section, "Readings for later slices");
- the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/G1/r1/`.
Not in scope: battery (G2), the password-on-wake reading and `launchctl` (L2-CORE), any caller, `config/config.ts`, `cli.ts`, the existing power files and tests (a refactor of the smoke test's regular expressions onto the new parser is a patch note, not this card).

## Decided design

Settled:

1. **One bounded runner.** `run-reading.ts` exports `spawnBounded(executable, args, options)` and `runReading(executable, args, options)`.
   `spawnBounded` spawns with `shell: false`, `stdio: ['ignore', 'pipe', 'pipe']`, the environment exactly `{ LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }`, a deadline (default 2000 ms) after which it sends SIGKILL, and a stdout cap (default 262144 bytes) past which it sends SIGKILL; it never throws and returns `{ ok: true, stdout }` or `{ ok: false, reason }` with `reason` one of `missing` (ENOENT), `not executable` (EACCES), `timeout`, `oversize`, `exit N` (nonzero exit code N), `signal NAME`, `spawn CODE`. stderr is drained and discarded, never returned or logged.
   `runReading` adds a guard before any spawn: the executable must be one of `READING_EXECUTABLES` (`/usr/bin/pmset`, `/usr/sbin/ioreg`, `/usr/bin/notifyutil`), and for `/usr/bin/pmset` the first argument must be exactly `-g`; anything else returns `{ ok: false, reason: 'refused' }` without spawning.
   This guard is what keeps a reading from ever changing power state.
2. **Parsers are pure** (text in, value out), never throw, never put input text into a reason string (assertion names can carry application or document names), and fail closed: anything they cannot parse with certainty is `{ kind: 'unknown', reason }`.
3. **Assertions** (`assertions.ts`): `parseAssertions(text)` returns `{ kind: 'ok', systemWide, holders }` or unknown, where `systemWide` maps each assertion type in the "Assertion status system-wide" block to its integer, and `holders` lists, from the "Listed by owning process" block, `{ pid, process, type, name, createdForPid }` (`createdForPid` from a following `Created for PID: N.` detail line, else null).
   Any line inside the owning-process block that is neither a holder line nor a recognized detail line makes the whole reading unknown (ADR 0050 line 118: refuse level 2 on any parse failure).
   Other blocks (kernel assertions, idle sleep preventers) are skipped by their headers.
   The exact line grammar comes from the captured fixture; anchored regular expressions only.
   `readAssertions()` runs `runReading('/usr/bin/pmset', ['-g', 'assertions'])` and parses.
4. **Thermal** (`thermal.ts`): `parseThermal(text)` accepts exactly one line `com.apple.system.thermalpressurelevel N` (after trimming), N an integer 0 to 4, and returns `{ kind: 'ok', level: 'nominal' | 'moderate' | 'heavy' | 'trapping' | 'sleeping' }` per the SDK mapping above; anything else is unknown.
   `readThermal()` runs `notifyutil -g com.apple.system.thermalpressurelevel`.
5. **Root domain** (`root-domain.ts`): `parseRootDomain(text)` returns `{ sleepDisabled: 'yes' | 'no' | 'unknown', clamshell: 'open' | 'closed' | 'absent' | 'unknown' }`: `sleepDisabled` is yes or no only when exactly one line matches `^\s*"SleepDisabled" = (Yes|No)$`; `clamshell` is closed for `"AppleClamshellState" = Yes`, open for `No`, absent when the key does not appear, unknown when it appears more than once or with another value.
   `readRootDomain()` runs `ioreg -r -c IOPMrootDomain -d 1`; a failed run makes both fields unknown.
6. **Fixtures.** Capture this Mac's live output of the three commands (raw copies stay in the evidence folder), redact per preamble item 6 (keep every line's structure, spacing, types, pids and counts; replace third-party process names and assertion names that are not Apple system strings with invented ones), and commit them with `SOURCE.md` (machine model, macOS build, capture date, the command, and each replacement class).
   Negative fixtures for the unknown paths are derived from the real ones by a stated edit (truncated mid-holder, an unrecognized line inserted in the owning-process block, two `SleepDisabled` lines, a thermal value of 5, a non-numeric thermal value, empty output) and named for the edit.
7. **Docs.** `docs/agent-reference/keep-awake.md` gains a short "Readings for later slices" section: what each reader reads, that nothing calls them yet, and that they never change power state (the `-g` guard).
The implementer may choose: type and function names other than those above, file layout inside `power/readings/`, test names.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/G1/r1/`.
1. Pure tests over the committed fixtures assert exact values: the Mac mini assertions fixture parses to `kind: 'ok'` with its exact holder count, includes `powerd`'s `PreventUserIdleSystemSleep` named "Prevent sleep while display is on" (if the capture shows it; otherwise the first holder's exact fields), and the root-domain fixture gives `sleepDisabled: 'no'` and `clamshell: 'absent'`; every negative fixture gives unknown; a thermal value of each of 0 to 4 maps to its name.
2. `runReading('/usr/bin/pmset', ['-a', 'disablesleep', '0'])`, `runReading('/usr/bin/pmset', ['sleepnow'])`, `runReading('/usr/bin/pmset', ['displaysleepnow'])` and `runReading('/usr/bin/sudo', ['-n', 'true'])` each return `refused`, and a test proves no process was spawned (for example a spawn counter the module exports for tests, or timing plus no child in `ps`; the implementer chooses, the reviewer checks it can fail).
3. `spawnBounded` against fake executables written to a temporary directory: a script that sleeps 5 s with a 300 ms deadline returns `timeout` and its pid is gone (`ps -p PID` exits 1); one that prints 1 MiB returns `oversize`; a missing path returns `missing`; a non-executable file returns `not executable`; `exit 3` returns `exit 3`.
4. Darwin-only live tests: `readRootDomain()` gives `sleepDisabled` other than unknown; `readThermal()` gives a level other than unknown; `readAssertions()` gives `kind: 'ok'` with at least one holder; and a test that spawns a child it owns, starts `/usr/bin/caffeinate -i -t 10 -w CHILDPID`, then finds through `readAssertions()` a holder with process `caffeinate`, type `PreventUserIdleSystemSleep` and `createdForPid` equal to the child's pid, and kills both in `finally` (model: `awake-holder.test.ts:220-255`).
5. `mkdir -p /private/tmp/remi-canon-G1 && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-G1/ bun test packages/daemon/tests/power/readings` ends with `0 fail` and no skipped test on this Mac.
6. Revert checks, each with its failing log in the evidence folder and a line in `revert-index.md` (file, the changed lines as a short diff, the command): drop the `-g` guard (item 2 fails); make the assertions parser skip an unrecognized line in the owning-process block (the matching negative fixture fails); accept `SleepDisabled` when two lines match (its fixture fails).
7. Fixture privacy: `rg -n -i '/Users/|@[a-z0-9.-]+\.[a-z]{2,}|https?://' packages/daemon/tests/power/fixtures` prints nothing, and `SOURCE.md` lists the replacement classes.
8. The PR body says what ships (three readers and parsers with no caller) and what does not (battery, password-on-wake, any use of the readings), with "Part of #1773".

## Gates

`bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; Acceptance 5's command passes in the canonical environment; hosted CI's `Test worker 0` to `2` and `Test` pass on the final head.

## Stop conditions

The live `pmset -g assertions` output has a structure the fixture cannot represent without guessing (report the shape, not the text); a reading would need root, a password or any command outside preamble item 5's read-only list; a darwin-only test cannot run without a skip on this Mac; the capture holds personal data you cannot redact while keeping the line shape.

## Report

The preamble's report; one line per acceptance item with its test or command goes into `report-details.md` in the evidence folder.
