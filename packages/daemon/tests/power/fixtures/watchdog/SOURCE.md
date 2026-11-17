# Watchdog fixtures (issue #1773)

The watchdog script tests (`../../watchdog-script.test.ts`) print these files from fake `ioreg` and `pmset` executables.

## Captured

Captured on 2026-11-17 on the owner's Mac mini (macOS 27.2, no battery, no lid), read-only:

- `ioreg-root-domain-mac-mini.txt`: `/usr/sbin/ioreg -r -c IOPMrootDomain -d 1`, which shows `"SleepDisabled" = No`.
- `pmset-batt-mac-mini-ac.txt`: `/usr/bin/pmset -g batt`, which prints only `Now drawing from 'AC Power'`.

Redaction, by class (the original text is not recorded here):

- boot session UUID (`BootSessionUUID`): replaced with an invented UUID of the same shape.

One edit that is not a redaction: `ioreg` ends its output with a line of four spaces and an empty line, which the repository's whitespace check (`git diff --check`) refuses; both are removed, so every `ioreg` file ends at the closing brace.
The watchdog reads only the `"SleepDisabled"` line, so the trailing lines do not change what it decides.

The capture holds no user name, home path, host name, email, URL, document or page title, third-party application name, serial number or hardware UUID.

## Derived

Each derived file is a copy of a captured file with one edit, named for that edit:

- `ioreg-root-domain-mac-mini.sleep-disabled-yes.txt`: `"SleepDisabled" = No` replaced with `"SleepDisabled" = Yes`.
- `ioreg-root-domain-mac-mini.sleep-disabled-yes-twice.txt`: that line replaced with two `"SleepDisabled" = Yes` lines (the script reads the flag only from exactly one line).
- `ioreg-root-domain-mac-mini.sleep-disabled-removed.txt`: the `"SleepDisabled"` line removed.

## Assumed (unverified)

No battery output has been captured from a MacBook yet.
These files follow ADR 0050's unverified recollection of the laptop line (`-InternalBattery-0 ... 62%; discharging; 1:40 remaining`), with an invented id; owner gate OG-CAP captures the real one, and a later card adds it to the tests:

- `pmset-batt-assumed-laptop-battery-25.txt`: on battery power at 25 percent.
- `pmset-batt-assumed-laptop-battery-62.txt`: on battery power at 62 percent.
- `pmset-batt-assumed-laptop-battery-no-percent.txt`: on battery power with the percent token removed.
- `pmset-batt-invented-ups-power.txt`: an invented first line naming a power source that is neither AC nor battery.
