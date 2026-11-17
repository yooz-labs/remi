# Fixtures: power readings, Mac16,11, macOS 27.2

Captured read-only on 2026-11-17 (macOS 27.2, build 26B123, model Mac16,11, a Mac mini with no lid and no battery) for #1773 (keep-awake, ADR 0050).
These are the parsers' ground truth: the line grammar in `packages/daemon/src/power/readings/` comes from them.

## Captured files (redacted)

| File | Command |
|---|---|
| `pmset-g-assertions.txt` | `/usr/bin/pmset -g assertions` |
| `ioreg-iopmrootdomain.txt` | `/usr/sbin/ioreg -r -c IOPMrootDomain -d 1` |
| `notifyutil-thermalpressurelevel.txt` | `/usr/bin/notifyutil -g com.apple.system.thermalpressurelevel` (unchanged) |

Every line keeps its structure, spacing (trailing spaces included, which is why `.gitattributes` here turns the whitespace check off), assertion types, pids, ages and counts.

## Replacement classes

Each class lists what kind of text was replaced, never the original.

- Third-party application process name: one application's process name in a holder line, replaced by `Sampleapp`.
- Third-party assertion name: a framework-chosen assertion name, replaced by `Sample Framework`.
- Audio device UUID: an audio device identifier inside a holder name and a `Resources:` line (both occurrences, same replacement), replaced by `0A1B2C3D-0000-0000-0000-0123456789AB`.
- Third-party USB device and hub names in the Kernel Assertions block: replaced by `Sample Hub A`, `Sample Hub B`, `Sample Microphone`, `Sample Receiver` and `Sample Webcam`.
- Boot session UUID in the root-domain capture: replaced by an invented UUID of the same shape.

Left as captured: Apple system process names and assertion strings (`powerd`, `WindowServer`, `coreaudiod`, `screensharingd`, `caffeinate`, `com.apple.*`), pids, the capture timestamp line, and the registry numbers in the root-domain capture (none identifies a person or a machine).
A scan for home paths, e-mail addresses and URLs over this folder prints nothing.

## Derived fixtures (edits stated; not captures)

Each is a real fixture with one edit, named for the edit.

| File | Derived from | Edit |
|---|---|---|
| `pmset-g-assertions.truncated-mid-holder.txt` | `pmset-g-assertions.txt` | cut 40 characters into the `caffeinate` holder line of pid 46453, no final newline |
| `pmset-g-assertions.no-final-newline.txt` | `pmset-g-assertions.txt` | final newline removed |
| `pmset-g-assertions.unrecognized-line-in-owners-block.txt` | `pmset-g-assertions.txt` | one unknown tab-indented line inserted after the first holder |
| `pmset-g-assertions.duplicate-system-wide-type.txt` | `pmset-g-assertions.txt` | the `BackgroundTask` line repeated |
| `pmset-g-assertions.detail-before-holder.txt` | `pmset-g-assertions.txt` | a `Details:` line inserted right after the `Listed by owning process:` header |
| `pmset-g-assertions.empty.txt` | none | empty |
| `ioreg-iopmrootdomain.two-sleepdisabled-lines.txt` | `ioreg-iopmrootdomain.txt` | the `"SleepDisabled" = No` line repeated |
| `ioreg-iopmrootdomain.sleepdisabled-other-value.txt` | `ioreg-iopmrootdomain.txt` | `"SleepDisabled" = 1` |
| `ioreg-iopmrootdomain.sleepdisabled-yes.txt` | `ioreg-iopmrootdomain.txt` | `"SleepDisabled" = Yes` |
| `ioreg-iopmrootdomain.clamshell-closed.txt` | `ioreg-iopmrootdomain.txt` | `"AppleClamshellState" = Yes` inserted after `SleepDisabled` |
| `ioreg-iopmrootdomain.clamshell-open.txt` | `ioreg-iopmrootdomain.txt` | `"AppleClamshellState" = No` inserted after `SleepDisabled` |
| `ioreg-iopmrootdomain.two-clamshell-lines.txt` | `ioreg-iopmrootdomain.txt` | both an Yes and a No `AppleClamshellState` line inserted |
| `ioreg-iopmrootdomain.empty.txt` | none | empty |
| `notifyutil-thermalpressurelevel.value-5.txt` | `notifyutil-thermalpressurelevel.txt` | value 5 |
| `notifyutil-thermalpressurelevel.non-numeric.txt` | `notifyutil-thermalpressurelevel.txt` | value `hot` |
| `notifyutil-thermalpressurelevel.two-lines.txt` | `notifyutil-thermalpressurelevel.txt` | the line twice |
| `notifyutil-thermalpressurelevel.empty.txt` | none | empty |

The two `clamshell` fixtures with a single key are inventions: this Mac has no lid, so the real shape of `AppleClamshellState` on a laptop is UNVERIFIED (ADR 0050).
