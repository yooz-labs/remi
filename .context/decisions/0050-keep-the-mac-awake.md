# ADR 0050: Keeping the Mac awake while remi has work

**Status:** proposed (issue #1773; the owner approved the two-level direction on 2026-11-14 and called the design good; the open questions below are not yet answered, so no code starts from this ADR yet)
**Date:** 2026-11-14
**Owner:** Yahya

> Evidence marks. VERIFIED: checked on 2026-11-14 on the owner's Mac mini (Mac16,11, macOS 27.2 build 26B123, no battery, no lid), in the macOS 27.2 SDK headers, or in this repository at `3bb7ad9d` on develop.
> UNVERIFIED: Apple documentation or field reports as recalled, not checked here.
> Nothing was checked on a MacBook (`ssh mba` timed out), so every lid and battery behavior below is UNVERIFIED.

## Context

#1773: a person connected from a phone loses their sessions when the Mac idles to sleep or its lid closes.
Owner decisions (two issue comments, 2026-11-14):

- **Level 1, no privileges:** an idle-system-sleep assertion, held only while remi has real work (an agent executing or thinking, or a question waiting for a person); never a display assertion; bound to the process that needs it; released after a short idle grace.
- **Level 2, lid-closed mode on battery,** for a person on the go: opt-in and guarded by a battery floor, a maximum duration, a revert when the last session ends or the hub exits or crashes, a thermal revert, the internal display blanked on lid close, a refusal while another app holds the Mac awake, its state shown on the phone, and phone start and stop only after the owner enabled that on the Mac.

Constraints: macOS sleep is system-wide, so nothing scopes it to remi's processes; with level 2 on, every app keeps running, a browser video included.
No agent edits sudoers; the owner installs any privileged piece.
remi ships as a Homebrew and npm command-line binary, plus sandboxed Mac apps.

Facts the options rest on:

1. VERIFIED (SDK `IOKit/pwr_mgt/IOPMLib.h:274-292`): `PreventUserIdleSystemSleep` stops idle sleep only: "The system may still sleep for lid close, Apple menu, low battery, or other sleep reasons."
2. VERIFIED (`man caffeinate`): `-s` "is valid only when system is running on AC power"; VERIFIED (`IOPMLib.h:1014-1023`): `PreventSystemSleep` is deprecated and documented as unsupported.
3. VERIFIED (`man pmset`, line 35): "pmset must be run as root in order to modify any settings."
   `disablesleep` is absent from the man page but present in the 27.2 binary (`strings /usr/bin/pmset`: `disablesleep`, `SleepDisabled`). It is an undocumented interface.
4. VERIFIED: the value is readable without root: `ioreg -r -c IOPMrootDomain -d 1` shows `"SleepDisabled" = No`, and `/Library/Preferences/com.apple.PowerManagement.plist` is mode 0644 with a `SystemPowerSettings` dictionary.
   UNVERIFIED: that `disablesleep 1` is stored there and so survives a reboot (the owner's report).
5. VERIFIED (two harmless runs, 5 s and 10 s): `caffeinate -i -t 5 -w <pid>` creates `PreventUserIdleSystemSleep` listed as "asserting on behalf of Process ID <pid>" and "Created for PID: <pid>"; it is released when that process exits, and a SIGKILL of the caffeinate process releases it at once.
6. VERIFIED: `/opt/homebrew/bin/remi` is ad hoc signed with no Team ID (`codesign -dv`); `/opt/homebrew` is owned by the user; `release.yml` has no signing step; both Mac apps are sandboxed (`packages/macos/Remi/Remi.entitlements`, `packages/native/AGENTS.md:93`).

## Decision drivers

- The agents remi runs (Claude Code, Codex) run as the same user; anything remi can invoke, a malicious or confused agent can invoke.
- Fail toward sleep: a crash, a lost lease, a parse failure or a missing sudo rule ends with the Mac allowed to sleep.
- The smallest root surface; no remi code runs as root unless that buys something real.
- Never touch another app's assertion or a `SleepDisabled` that remi did not set.
- Most logic testable without a lid; the owner's hands only for what only hardware shows.

## Options for the privileged path to `pmset -a disablesleep 0|1`

### (A) One exact sudoers rule, installed by the owner from a printed command

remi prints, and never installs, a file for `/etc/sudoers.d/remi-keep-awake` (0440 root:wheel, checked with `visudo -cf` first):

```
<user> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0
```

remi runs `/usr/bin/sudo -n /usr/bin/pmset -a disablesleep <0|1>` by absolute path, as an argument array, with no shell; the two arrays are constants, and the wire only ever carries start or stop. `-n` fails closed when the rule is missing.

- **Who can invoke it:** any process of that user, the agent included.
- **What an attacker gains:** the Mac stays awake with the lid closed until a rail reverts it, and a same-user attacker can also kill the rails. That is a battery and heat denial of service, not an escalation: the same user can already hold an idle assertion forever (fact 5). Only Apple's `pmset` runs as root.
- **Argument injection:** none with listed arguments; VERIFIED in sudoers(5) lines 512-523: listed arguments must match, and an entry with no arguments allows any. The danger is the owner widening it: `pmset` with any arguments allows `hibernatefile <path>` (a root write to a chosen path; UNVERIFIED as exploitable), `tcpkeepalive 0` (VERIFIED pmset string: breaks Find My Mac), `schedule`, `autorestart`, `restoredefaults`. The docs print only the exact line and say why.
- **Failure modes:** rule missing or edited (`sudo -n` exits nonzero; level 2 is refused with that reason); a macOS update changes `pmset` (remi reads `SleepDisabled` back after every write and refuses on mismatch). UNVERIFIED: that `/etc/sudoers` includes `/etc/sudoers.d` (the directory exists, VERIFIED; the file is 0440 and unreadable).
- **Distribution fit:** works with the Homebrew binary unchanged; no signing, no app.
- **Cost:** low.

### (B) A signed launchd daemon registered with SMAppService, reached over XPC

A root helper inside a Developer ID signed, notarized app (`SMAppService.daemon`, macOS 13 and later, approved by the user in Login Items), with an XPC (Apple's interprocess messaging) interface such as `begin(lease)` and `end()`.

- **Who can invoke it:** the same set as (A). The helper cannot authenticate remi: with no Team ID and a user-writable prefix (fact 6), a code-signing requirement on the client fails and a path check proves nothing.
- **What it buys:** the rails (lease expiry, battery floor, thermal, revert when the client's connection drops, revert at boot) run in a root process a same-user attacker cannot kill or edit.
- **What it costs in security:** remi-written root code parsing messages from any same-user client; every bug in it is a root bug.
- **Failure modes:** approval revoked in System Settings; helper and binary version skew after an upgrade (the XPC contract needs versioning); re-registration on app update.
- **Distribution fit:** poor. It cannot ship in the sandboxed apps (UNVERIFIED: App Review guideline 2.4.5 forbids root escalation), so it needs a third, unsandboxed Developer ID app and a Homebrew cask.
- **Cost:** high: a Swift helper, an XPC contract with conformance tests, signing, notarization, an approval flow, uninstall.

### (C) No privileged path

Level 1 only, plus Apple's closed-display mode, which needs AC power, an external display and an input device (UNVERIFIED, Apple support article on closed-display mode).
It misses the on-the-go battery target (facts 1, 2). It is what remi does whenever (A) is not installed.

### (D) A different primitive without root

None found. `PreventUserIdleSystemSleep` (fact 1), `PreventSystemSleep` and `caffeinate -s` (fact 2), `ttyskeepawake` (idle only, VERIFIED man) and `NetworkClientActive` (dark wake, UNVERIFIED) do not survive a lid close on battery.
The root-domain clamshell call older tools used is private interface (UNVERIFIED whether it needs root); rejected as private.
`pmset` has a hidden `clamshell 0|1` test command (VERIFIED strings: `IOPMTestClamshellClose`); a root test hook, not a product path, possibly a test aid.

## Recommended decision

**Level 1:** each session daemon holds its own assertion through `/usr/bin/caffeinate -i -w <its own pid> -t <ttl>` while it has real work; no privilege, released by the OS when either process dies (fact 5).
**Level 2:** option (A) with the fail-safe stack below; (C) whenever the rule is absent.
(B) is rejected for now: against a same-user caller it authenticates no better than (A), its one real gain (rails the user's own processes cannot disable) protects against an attacker who already holds the account, and it costs a new root codebase and a new distribution channel.
Revisit (B) if remi ships a Developer ID signed binary.

## Fail-safe design for level 2

The hub (`remi serve`) is the only owner of level 2: it is session-less and outlives sessions, and two owners of one machine-wide flag would race. Session daemons never touch it.

1. **Intent first.** Before `disablesleep 1` the hub writes `~/.remi/keep-awake/lease.json` (0600, atomic rename): `{version, hubPid, hubStartTime, startedAt, expiresAt, heartbeatAt}`. It enables only while `SleepDisabled` reads No; Yes means someone else set it, and level 2 is refused.
2. **Heartbeat and guards.** Every 30 s the hub rewrites `heartbeatAt` and evaluates battery, thermal, foreign holders, live session count and `expiresAt`; any trip runs `disablesleep 0`, deletes the lease and tells the phone.
3. **Clean exits** (the SIGTERM handlers at `packages/daemon/src/cli.ts:3685` and `:4141`, `remi stop`) revert before exit.
4. **Watchdog.** A separate user LaunchAgent (`StartInterval` 60, `RunAtLoad`) runs a small POSIX script that remi writes, not the remi binary, so an upgrade, downgrade or broken install cannot disable it. With `SleepDisabled` Yes, it reverts when the lease is expired, malformed or of an unknown version, its heartbeat is older than 120 s, its `hubPid` is dead or reused (start time differs), or the battery is under the floor. No lease: it does nothing, the flag is not remi's.
5. **Hub crash.** A SIGKILL is caught by the watchdog within 60 to 180 s. The hub's LaunchAgent restarts it (`cli/service-templates.ts:35`, `KeepAlive.SuccessfulExit=false`); the new hub reverts a lease it does not own and never resumes level 2 by itself.
6. **Reboot with the flag set.** The watchdog's `RunAtLoad` run reverts at login. Before login (the login window after an update reboot) only root can act: recommended, the owner also installs a LaunchDaemon whose `ProgramArguments` are exactly `/usr/bin/pmset -a disablesleep 0` with `RunAtLoad`; Apple's binary, no input, no remi code as root (open question 1).
7. **Upgrade.** Homebrew replaces the binary while the running hub keeps its own (`docs/agent-reference/hub-mode.md`); the restart is a clean exit (3) plus a fresh hub (5). A remi without this feature ignores the lease, and the watchdog still runs.

Honest limits: the lease and the watchdog are crash safety, not a security boundary; a same-user process can delete both.
UNVERIFIED and load-bearing: that `disablesleep 0` with the lid already closed makes the Mac sleep. If it does not, every rail clears the flag and leaves the Mac awake in the bag; the fallback is a third exact rule for `/usr/bin/pmset sleepnow` (open question 6).
UNVERIFIED: whether a Mac with sleep disabled still makes its emergency low-battery sleep; the floor must not depend on it.

## What counts as real work (level 1, per session daemon)

- **Status.** Every source funnels through `MessageApi.handleStatusChange` (`packages/daemon/src/api/message-api.ts:282`): the hook bridge (`cli/session-phases/hook-bridge-setup.ts:552`), the PTY fallback when no hook server runs (`harness/claude-session.ts:354-358`) and Codex (`harness/codex/codex-session.ts:344`, aggregated at `:287`). Busy means `thinking`, `executing` or `waiting` (`packages/shared/src/types.ts:43-49`). Hooks set `executing` on PreToolUse and SubagentStart (`hooks/hook-event-bridge.ts:436`, `:632`), `thinking` on PostToolUse and SubagentStop (`:441`, `:636`), `waiting` on prompts (`:486`, `:529`, `:725`), and `idle` on Stop and SessionEnd (`:508`, `:731`).
- **Gap to close.** `UserPromptSubmit` (`hook-bridge-setup.ts:1268`) sets no status, so a turn that only reasons reads `idle`. Level 1 adds a turn-open flag from UserPromptSubmit to Stop, StopFailure or SessionEnd.
- **Pending questions.** `SessionRegistry` `onQuestionsChanged` (`session/session-registry.ts:135`, `:274`), mirrored as `pendingQuestions` in the live-sessions file (`session/session-registry-file.ts:84`, `:270`).
- **Stuck states.** A turn interrupted with Escape fires no Stop (`notifications/turn-timer.ts:55-57`), so busy can stick. Busy with no hook event, PTY output or Codex notification for 15 min releases the hold and logs once. The caffeinate TTL (time to live, 20 min, renewed while busy by spawning the new holder before killing the old) bounds a release that remi's own code misses.
- **Release** after a 2 min idle grace; a pending question holds for at most 30 min (open question 2).

For level 2 the hub reads "last session ended" from the live-sessions registry and, for an optional idle revert, each child's `sessionStatus` in `status-<PORT>.json` (`cli.ts:95-97`).

## Refusing while another app holds the Mac awake

Source: `pmset -g assertions` text, later `IOPMCopyAssertionsByProcess` (public, `IOPMLib.h:694-710`) from a native helper. The text format is undocumented: parse it against a fixture corpus and refuse level 2 on any parse failure.
VERIFIED on this Mac today, and why "any assertion" cannot be the rule: powerd always holds `PreventUserIdleSystemSleep` "Prevent sleep while display is on"; screensharingd holds `PreventSystemSleep` "Remote user is connected"; ChatGPT (Electron) has held `NoIdleSleepAssertion` for 43 h; five `caffeinate` holders of unknown origin; `UserIsActive` from WindowServer and bluetoothd; kernel USB and Thunderbolt assertions.
Proposed rule: a foreign holder is a pid outside remi's process tree (remi's own caffeinate reads "Created for PID: <remi pid>"), other than powerd's display-on assertion, holding a display-sleep type (`PreventUserIdleDisplaySleep`, `NoDisplaySleepAssertion`) or a system-sleep type (`PreventSystemSleep`, `PreventUserIdleSystemSleep`, `NoIdleSleepAssertion`).
Display-sleep holders (video, calls, slides; UNVERIFIED mapping) always refuse; system-sleep holders refuse unless on a Mac-side ignore list the phone cannot edit.
Limits: names are self-chosen; a bare caffeinate's origin is opaque; audio playback may appear under coreaudiod (UNVERIFIED); a holder that starts after level 2 is on is seen at the next 30 s tick (notify, revert after 2 min).

## Battery, thermal, duration and display inputs

- **Battery:** `pmset -g batt` (VERIFIED on AC: `Now drawing from 'AC Power'` and no battery line; the laptop line `-InternalBattery-0 ... 62%; discharging; 1:40 remaining` is UNVERIFIED). Defaults: refuse to start below 35 percent; revert at 25 percent (the owner's figure) or under 20 min remaining; a laptop whose battery cannot be read refuses.
- **Thermal:** notify(3) key `com.apple.system.thermalpressurelevel`, VERIFIED by a compiled read of `kOSThermalNotificationPressureLevelName` (state 0 here); levels nominal 0, moderate 1, heavy 2, trapping 3, sleeping 4 (`libkern/OSThermalNotification.h:47-52`); `notifyutil -g` reads it without root. Defaults: refuse to start at moderate; revert at heavy, or moderate held for 5 min. `pmset -g therm` is a second source (VERIFIED: "No thermal warning level has been recorded").
- **Duration:** default 3 h, hard cap 12 h, extended only by an explicit action of the person.
- **Display:** on lid close (`AppleClamshellState` in ioreg; absent on the Mac mini, VERIFIED; UNVERIFIED on a laptop) run `pmset displaysleepnow` (UNVERIFIED that it needs no root).

## Consequences

Level 1 is cheap and crash-safe; on a Mac whose `sleep` timer is 0 (this Mac mini, VERIFIED) it changes nothing.
Level 2 rests on an undocumented `pmset` keyword a macOS update may remove; the read-back after every write turns that into a visible refusal.
With level 2 on, every app keeps running; remi bounds that window and shows who else holds the Mac, nothing more.
The owner carries a sudoers file and optionally a root LaunchDaemon; `remi keep-awake` prints how to remove both.
Linux (ADR 0040) is out of scope here; `systemd-inhibit --what=idle` is the level 1 analog (UNVERIFIED).

## Slices and how each is tested without a lid

The repository forbids mocks of business logic. The policy is a pure function of (events, clock, readings) to a desired state and is tested directly; the OS boundary is tested with the real tools.

1. **Level 1.** Pure tests of the busy-state machine (turn-open, stuck bound, grace, question cap). Real-process tests on macOS: start caffeinate for a test child, find it in real `pmset -g assertions` as "Created for PID", SIGKILL the child and see it gone (both done by hand here). No owner hands needed.
2. **Guard rails.** Parsers for `pmset -g assertions`, `pmset -g batt`, thermal and ioreg against fixtures captured from real Macs (this Mac's capture of today; the owner captures a MacBook on battery, with a Safari video, and in a call). The watchdog script runs against a temporary `REMI_HOME`, real `ioreg` and a lease whose pid is dead, with a dry-run flag that prints the `pmset` arguments instead of calling sudo. Owner hands: the captures.
3. **Privileged switch.** The one substitute sits at the root boundary: a test asserts that the arguments remi runs and the sudoers line it prints come from one constant. Owner's hands on the MacBook, on battery: (a) enable, close the lid, confirm from the phone; (b) SIGKILL the hub with the lid closed and confirm sleep within 3 min (`pmset -g log`), which tests the riskiest assumption; (c) reboot with the flag set, read `SleepDisabled` at the login window and after login; (d) set the floor just under the current level; (e) a Safari video playing is refused; (f) the screen is locked after the lid closes. `pmset clamshell 1` (hidden, root) might stand in for the lid; UNVERIFIED that sleep policy treats it as a real close.
4. **App surface.** `keep_awake_status` and start and stop messages in the registry (ADR 0012), a `keep_awake` capability (ADR 0035), conformance with both endpoints constructed (ADR 0014); a phone start needs `allow_phone = true` set on the Mac and an authorized device (ADR 0024, 0037). Web first, native after.

## Open questions for the owner

1. Install the boot LaunchDaemon (recommended), knowing it also clears a `SleepDisabled` you set by hand?
2. Pending-question hold cap of 30 min, and a level 2 idle revert after 30 min with no real work in any session (proposed yes)?
3. Level 1 on battery: on with a 30 percent floor (proposed), or off?
4. Level 2 defaults: start at 35 percent or more, revert at 25 percent, 3 h default, 12 h cap, thermal as above?
5. Foreign holders: always refuse on display assertions, and on system-sleep holders unless ignored on the Mac (ChatGPT would need an entry on this Mac)? A holder that appears mid-session: notify, then revert after 2 min?
6. If test 3(b) shows the Mac stays awake after the revert with the lid closed, add `/usr/bin/pmset sleepnow` as a third exact rule?
7. If closing the lid with sleep disabled does not lock the screen, should level 2 refuse unless "require password immediately" is set?

## Receipts

- #1773 and its two owner comments of 2026-11-14.
- macOS 27.2 (26B123): `man pmset`, `man caffeinate`, sudoers(5), `strings /usr/bin/pmset`, `pmset -g`, `-g assertions`, `-g batt`, `-g therm`, `-g cap`, `ioreg -r -c IOPMrootDomain`, the two caffeinate checks, `codesign -dv /opt/homebrew/bin/remi`.
- macOS 27.2 SDK: `IOKit/pwr_mgt/IOPMLib.h`, `libkern/OSThermalNotification.h`.
- Source at `3bb7ad9d` (develop): the file and line citations above.
