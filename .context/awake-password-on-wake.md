# Password-on-wake reader (G0, #1773)

## Sources tried

### `man sysadminctl`

Exit code: `1`. Standard output was empty. Standard error was:

> `No manual entry for sysadminctl`

### `man defaults`

Exit code: `0`. Standard error was empty. Standard output was the `defaults(1)` manual. Its relevant passage says:

> `read`: `Prints all of the user's defaults, for every domain, to standard output.`

The complete command output is captured in `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/G0/r1/runs.txt`.

### `/usr/bin/timeout 10 /usr/sbin/sysadminctl -screenLock status </dev/null`

Exit code: `0`. Standard output was empty. Standard error was:

> `2026-11-17 06:59:48.236 sysadminctl[49146:109395960] screenLock delay is immediate`

The reported value is in standard error. The command returned before the timeout and did not ask for a password.

### `defaults read com.apple.screensaver`

Exit code: `1`. Standard output was empty. Standard error was:

> `Error: Domain 'com.apple.screensaver' not found.`

### `defaults read com.apple.screensaver askForPassword`

Exit code: `1`. Standard output was empty. Standard error was:

> `Error: Domain 'com.apple.screensaver' not found.`

### `defaults read com.apple.screensaver askForPasswordDelay`

Exit code: `1`. Standard output was empty. Standard error was:

> `Error: Domain 'com.apple.screensaver' not found.`

### `defaults -currentHost read com.apple.screensaver`

Exit code: `1`. Standard output was empty. Standard error was:

> `Error: Domain 'com.apple.screensaver' not found.`

### `test -e "/Library/Managed Preferences/com.apple.screensaver.plist"`

Exit code: `1`. Standard output and standard error were empty; the file was not present.

### `test -e "/Library/Managed Preferences/$USER/com.apple.screensaver.plist"`

Exit code: `1`. Standard output and standard error were empty; the file was not present.

### `sw_vers`

Exit code: `0`. Standard error was empty. Standard output was:

```text
ProductName:		macOS
ProductVersion:		27.2
BuildVersion:		26B123
```

The exact streams and exit codes for every command are in `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/G0/r1/runs.txt`.

## Conclusion

not settled

The evidence was produced on a desktop Mac (model class only; no serial, name or user is recorded here).
The password-on-wake setting was not independently confirmed there, so `observed immediate` must not be read as "this Mac requires a password immediately".
The MacBook's output may differ.

`sysadminctl -screenLock status` is the only attempted source that returned a current setting. The observed value was `immediate`, but no output for a delayed or off setting was observed, and this current-value read alone does not show that its result follows the setting. The screensaver defaults domain and its managed preference files were absent. No source is ready to be treated as authoritative until the owner check below confirms the toggle behavior and the exact output forms.

## Parse rule

No rule is evidenced yet. For now, L2-CORE must return `unknown` for every output, including the observed `screenLock delay is immediate` line. A timeout, nonzero exit, empty output, unreadable stream or unrecognized output also returns `unknown`.

The intended rule, not yet evidenced and not to be implemented until the owner check below passes: only an observed `immediate` result maps to on; delayed, off, unreadable, unrecognized or failed results map to not on.

Any later rule must anchor on the `screenLock delay is ` suffix, because the standard error line carries a timestamp, the process name and a process id before it.

A screensaver domain `Domain ... not found` error means no data and maps to `unknown`, never to off.

## Consequences for L2-CORE

There is no settled reader. The candidate command is `/usr/sbin/sysadminctl`; its usage text lists the same verb as a writer: `-screenLock <status || immediate || off || seconds> -password <password>` (read by running `sysadminctl` with no arguments on 2026-11-17; the text is quoted in the saved evidence pack's `prompt.md`). The same `-screenLock` verb with `immediate`, `off` or a number of seconds therefore changes the setting. The argument array must be exactly [`-screenLock`, `status`], constant, never `-password` and never another verb, and no caller-supplied value may reach it. This Mac wrote its current-value line to standard error. Until OG-CAP step 5 settles the source and output forms, L2-CORE must always return `unknown`. With `require_password_on_wake = true`, level 2 refuses to start on `unknown`. The owner may explicitly set `require_password_on_wake = false`, as allowed by ADR 0050.

## What the owner checks

At OG-CAP step 5, the owner checks on the MacBook that the candidate read is read-only, needs no root or password, and follows the password-on-wake setting. Run these read-only commands in each state: password required immediately, a nonzero delay, and off (Never, if the setting offers it):

```sh
/usr/bin/timeout 10 /usr/sbin/sysadminctl -screenLock status </dev/null
defaults read com.apple.screensaver askForPassword
defaults read com.apple.screensaver askForPasswordDelay
```

For each command and state, capture standard output and standard error to separate files and record the exit code. OG-CAP step 5 in `owner-gates.md` must capture the streams separately and include the off state; the pack's file is to be corrected accordingly. Only an observed immediate result may map to on; delayed, off, unreadable, unrecognized or failed results must map to not on. This toggle check supplies the evidence that the current-value report alone cannot provide.
