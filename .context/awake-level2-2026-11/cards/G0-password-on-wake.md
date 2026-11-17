# Card G0: how remi reads the password-on-wake setting (issue #1773)

Status: ready
Tier: worker
Timebox: S, 3 hours; escalate at 6 hours or two failed approaches
Needs: none (no network beyond `git fetch` and `gh`); macOS host
Depends: none
Branch: `docs/issue-1773-password-on-wake` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-g0` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (G0); ADR 0050 owner decision 7

## Goal

A committed note, `.context/awake-password-on-wake.md`, says which read-only source on macOS 27.2 reports whether a password is required immediately after sleep or the screen saver, without root and without a password, with its exact output and the parse rule L2-CORE will use, or says "not settled" with every source tried.

## Context

- ADR 0050 owner decision 7 (`.context/decisions/0050-keep-the-mac-awake.md:158`): level 2 refuses to start unless the password-on-wake setting is on ("require password immediately" after sleep or the screen saver); "How the setting is read (for example `sysadminctl -screenLock status`, or the screensaver preference) is UNVERIFIED and is settled in the guard-rails slice."
- The usage text of `/usr/sbin/sysadminctl` on this Mac (read by the lead on 2026-11-17 by running `sysadminctl` with no arguments) lists `-screenLock <status || immediate || off || seconds> -password <password>`; whether `status` needs the password is not known.
- Candidate sources: `sysadminctl -screenLock status`; the `com.apple.screensaver` preference keys `askForPassword` and `askForPasswordDelay` (older macOS releases; possibly no longer authoritative); a managed preference from a configuration profile under `/Library/Managed Preferences/` (existence only).
- The Mac is the owner's Mac mini (Mac16,11, macOS 27.2, build 26B123).
  The setting must not be changed by an agent; the owner checks on the MacBook that the chosen reading follows the setting (owner gate OG-CAP, step 5).
- `/usr/bin/timeout` exists on this Mac (checked by the lead on 2026-11-17).

## Scope

May change: one new file `.context/awake-password-on-wake.md`, and the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/G0/r1/`.

## Decided design

Settled: the only commands you may run are, exactly:
`man sysadminctl`, `man defaults`;
`/usr/bin/timeout 10 /usr/sbin/sysadminctl -screenLock status </dev/null` (never with `-password`, never any other `sysadminctl` verb);
`defaults read com.apple.screensaver`, `defaults read com.apple.screensaver askForPassword`, `defaults read com.apple.screensaver askForPasswordDelay`, `defaults -currentHost read com.apple.screensaver`;
`test -e "/Library/Managed Preferences/com.apple.screensaver.plist"` and `test -e "/Library/Managed Preferences/$USER/com.apple.screensaver.plist"` (existence only, never read);
`sw_vers`.
For each, record in the evidence folder the exact command, exit code, stdout and stderr (which stream carries the answer matters: `sysadminctl` may write to stderr).
The note has these sections, in this order: "Sources tried" (one subsection per command above, with what it printed, quoted, and its exit code), "Conclusion" (one of: "settled: SOURCE" or "not settled"), "Parse rule" (for a settled source: the exact output shapes for on-immediately, on-with-a-delay and off, the regular expression or line rule, and the mapping: only "immediately" counts as on; any delay greater than zero, off, an unreadable output or a nonzero exit counts as not on, per decision 7's "require password immediately"), "Consequences for L2-CORE" (the reader's executable, arguments and stream, and what it returns on every failure), and "What the owner checks" (the toggle check of OG-CAP step 5).
A source that only reports the current value cannot prove it follows the setting: say so, and leave the proof to OG-CAP step 5.
The worker may choose: the note's wording.

## Acceptance

1. `.context/awake-password-on-wake.md` exists with the five sections, every command of the decided design in "Sources tried" with its quoted output and exit code, and the evidence folder holds `runs.txt` with the same.
2. If "settled", "Parse rule" names the stream and gives a rule that the quoted output of this Mac satisfies; if "not settled", "Consequences for L2-CORE" says the reader always returns unknown and level 2 then refuses unless `require_password_on_wake = false` (ADR 0050 table).
3. `typos .context/awake-password-on-wake.md` is clean, `rg '\x{2014}' .context/awake-password-on-wake.md` prints nothing, and `rg -i '/Users/|@[a-z0-9.-]+\.[a-z]{2,}' .context/awake-password-on-wake.md` prints nothing (no home path, no email).
4. The PR into `develop` is open with "Part of #1773" and no closing word.

## Gates

`typos .context/awake-password-on-wake.md`; `git diff --check origin/develop...HEAD` prints nothing; `git diff --name-only origin/develop...HEAD` lists only `.context/awake-password-on-wake.md`.

## Stop conditions

Any command asks for a password, opens a dialog, or blocks until the timeout (record it and stop that source; continue with the others); a source would need a command not listed above, root, or a change to the setting; the output contains anything personal beyond the setting itself (stop, delete it from the evidence, report).

## Report

The preamble's report, plus the conclusion in one line and the parse rule in one line.
