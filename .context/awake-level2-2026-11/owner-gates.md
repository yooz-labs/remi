# Owner gates: keep-awake level 2 and its guard rails

Each gate needs the owner's MacBook, physical actions (unplugging, closing the lid, rebooting) or root, so no agent runs it.
The manager sets the gate `owner` when its Depends are done, sends the owner this section once, and records the owner's result with `decide ... --by owner`.
Record only what each gate asks for: pass or fail per step, the MacBook's model (`sysctl -n hw.model`), the macOS build (`sw_vers -buildVersion`) and the remi version; never a user name, a path, a process list or a log excerpt in anything committed or posted (the board and the log are pushed to a public repository).
Every command below is read-only unless it says otherwise; the ones that need `sudo` are marked and are typed by the owner only.

## OG-CAP: MacBook captures (can run now; needed by G2 and L2-CORE)

On the MacBook, in Terminal (not through remi), define this once (read-only commands only):

```sh
capture() {
  d="$HOME/remi-awake-captures/$1"; mkdir -p "$d"
  sysctl -n hw.model > "$d/hw-model.txt"
  sw_vers -buildVersion > "$d/build.txt"
  /usr/bin/pmset -g batt > "$d/pmset-g-batt.txt" 2>&1
  /usr/bin/pmset -g assertions > "$d/pmset-g-assertions.txt" 2>&1
  /usr/bin/pmset -g therm > "$d/pmset-g-therm.txt" 2>&1
  /usr/bin/notifyutil -g com.apple.system.thermalpressurelevel > "$d/notifyutil-thermal.txt" 2>&1
  /usr/sbin/ioreg -r -c IOPMrootDomain -d 1 > "$d/ioreg-rootdomain.txt" 2>&1
  /usr/sbin/ioreg -r -c AppleSmartBattery -d 1 > "$d/ioreg-applesmartbattery.txt" 2>&1
  { /usr/bin/timeout 10 /usr/sbin/sysadminctl -screenLock status </dev/null; echo "exit=$?"; } > "$d/sysadminctl-screenlock.txt" 2>&1
  { defaults read com.apple.screensaver askForPassword; defaults read com.apple.screensaver askForPasswordDelay; } > "$d/defaults-screensaver.txt" 2>&1
  echo "captured $1"
}
```

Then, with nothing else holding the Mac awake (no video, no call, no remi session doing work):
1. Plugged in, lid open: `capture ac-idle`.
2. Unplug, then at once: `capture battery-just-unplugged` (the time estimate is usually missing right after unplugging).
3. Still unplugged, after about 3 minutes: `capture battery-idle`.
4. Still unplugged, a video playing in Safari in the foreground: `capture battery-video`; stop the video.
5. Password on wake (System Settings, Lock Screen, "Require password after screen saver begins or display is turned off"): set it to "Immediately" and run `capture lock-immediately`; set it to "After 5 minutes" and run `capture lock-5-minutes`; set it back to the value you use (level 2 will require "Immediately").
6. Still unplugged, in a FaceTime call (or the call app you use): `capture battery-call`; end the call.
7. Copy the folder to the Mac mini, for example from the Mac mini: `mkdir -p /Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/captures/OG-CAP && scp -r mba:remi-awake-captures/. /Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/captures/OG-CAP/`; then you may delete `~/remi-awake-captures` on the MacBook.
The captures can hold application names, a page title, serial numbers and your user name; agents redact them before anything is committed (preamble item 6), and nothing raw leaves the artifacts folder.
Record: done per state (seven folders), the model and the build.

## OG-G2: the level 1 battery floor on the MacBook (after G2 merged)

On the MacBook, build the `develop` tip that contains G2 in a remi checkout of your choice (clone `https://github.com/yooz-labs/remi` if there is none), and use a separate remi home so the running hub is untouched:

```sh
git fetch origin && git checkout --detach origin/develop && bun install && bun run build:binary
REMI="$PWD/dist/remi"; "$REMI" --version
export G="$HOME/.remi-awake-gate"; mkdir -p "$G"
```

1. Unplug; `pmset -g batt` and note the percentage as P (it must be at least 30).
2. Floor above P: `printf '[awake]\nlevel1_battery_floor_percent = %d\nbattery_check_seconds = 10\nidle_grace_seconds = 5\n' $((P + 5)) > "$G/config.toml"`.
3. In a scratch project folder: `REMI_HOME="$G" "$REMI" --port 18801`, and ask Claude to run `sleep 120` in its shell.
   While it runs, in a second terminal: `pmset -g assertions | grep -A3 caffeinate` shows no holder with `Created for PID:` equal to `/usr/bin/jq -r .pid "$G/status-18801.json"`, and `grep '\[Awake\]' "$G/remi.log" | tail -3` shows a "Hold refused ... battery floor" line.
   Exit the session.
4. Floor below P: rerun step 2 with `$((P - 5))`, start the session again, ask for `sleep 120`: now a `caffeinate` holder is created for that pid and the log shows "Hold started".
   Exit.
5. Plug in, rerun step 2 with `$((P + 5))`, start the session, ask for `sleep 120`: the holder appears (the floor does not apply on AC power).
   Exit.
6. `rm -rf "$G"`.
Record: P, pass or fail of steps 3, 4 and 5, the remi version, the model and the build.

## OG-L2: level 2 setup and hardware tests on the MacBook (after L2-CLI merged)

Build the `develop` tip that contains L2-CLI as in OG-G2, then define these helpers.
On the MacBook:

```sh
REMI="$PWD/dist/remi"; export G="$HOME/.remi-awake-gate"; mkdir -p "$G"
ka() { REMI_HOME="$G" "$REMI" keep-awake "$@"; }
flag() { /usr/sbin/ioreg -r -c IOPMrootDomain -d 1 | grep -E '"(SleepDisabled|AppleClamshellState)"'; }
```

On the Mac mini:

```sh
mbaflag() { ssh -o ConnectTimeout=5 mba "/usr/sbin/ioreg -r -c IOPMrootDomain -d 1 | grep -E '\"(SleepDisabled|AppleClamshellState)\"'"; }
```

Before starting, make sure nothing else holds the Mac awake: `pmset -g assertions` shows no video, call or other `caffeinate` holder, and your regular remi hub's sessions are idle (they live in another remi home, so this test hub counts their holders as another app's and refuses).

Setup (the commands marked sudo are yours to type; remi prints them and runs none):
1. `ka setup` and follow its printed steps (sudo: `visudo -cf`, `install` of `/etc/sudoers.d/remi-keep-awake`, `install` and `launchctl bootstrap system` of `/Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist`).
2. `sudo -n -l /usr/bin/pmset -a disablesleep 1` prints that command (this also shows that macOS reads `/etc/sudoers.d`, which ADR 0050 could not verify).
3. `ka watchdog install`, then `launchctl print "gui/$(id -u)/com.yooz.remi.keep-awake-watchdog" | head -3` shows the agent.
4. `printf '[daemon]\nbase_port = 18801\n[awake]\nlevel2 = true\n' > "$G/config.toml"`; start the test hub in its own terminal with `REMI_HOME="$G" "$REMI" serve`; in a scratch project folder start a session with `REMI_HOME="$G" "$REMI" --port 18810` and ask Claude for a long task (for example `sleep 1800`).
5. `ka status` shows `level2: off`, the sudoers file and the boot daemon present, and the watchdog loaded.

Tests, on battery unless a step says otherwise:
- (a) Start and close the lid: `ka start 1` prints `on` and the expiry; close the lid; after 2 minutes `mbaflag` on the Mac mini shows `"SleepDisabled" = Yes` and `"AppleClamshellState" = Yes`, and the phone still reaches your regular hub on the MacBook.
- (b0) Hub killed, lid open: open the lid, `kill -9 "$(/usr/bin/jq -r .pid "$G/daemon-status.json")"`; within 3 minutes `flag` shows `"SleepDisabled" = No` and `"$G/keep-awake/watchdog.log"` has one revert line.
- (b) Hub killed, lid closed (the riskiest assumption): restart the test hub, `ka start 1`, close the lid; on the Mac mini, `ssh mba 'kill -9 "$(/usr/bin/jq -r .pid "$HOME/.remi-awake-gate/daemon-status.json")"'`; within 4 minutes the MacBook stops answering `ssh -o ConnectTimeout=5 mba true` (it slept).
  After opening the lid, `pmset -g log | grep -E " Sleep | Wake " | tail -5` shows a sleep within 4 minutes of the kill.
  If it stayed awake with the flag `No`, record that: it triggers L2-SLEEPNOW (owner decision 6).
- (c) Reboot with the flag set: `ka start 1` (on AC is fine), then (sudo) `sudo shutdown -r now`.
  At the login window, if `mbaflag` answers, it shows `"SleepDisabled" = No`; after logging in, `flag` shows `No` (the boot daemon cleared it).
  Start the test hub again: afterwards `ls "$G/keep-awake/lease.json"` reports no such file.
- (d) Battery revert: with P from `pmset -g batt` (at least 37), add the lines `level2_start_battery_percent = P-1` and `level2_revert_battery_percent = P-2` (as numbers) under `[awake]` in `"$G/config.toml"`, restart the test hub, `ka start 1` with the lid open; when `pmset -g batt` shows P-2 or less, within one minute `ka status` shows `off` with `battery-low` and `flag` shows `No`.
  Remove the two lines again.
- (e) Another app: play a video in Safari, `ka start 1` is refused with `foreign-holder`; stop the video, `ka start 1`, play the video again: after about 2 minutes level 2 reverts with `foreign-holder`.
- (f) Password on wake: with level 2 on, close the lid for a minute and open it: the Mac asks for your password before showing the desktop; then set "Require password" to "After 5 minutes": `ka start 1` is refused with `password-on-wake-off`; set it back to "Immediately".
- (g) Display: during (a), the internal display is dark with the lid closed (no light at the hinge), and `grep '\[Awake2\]' "$G/remi.log"` shows the lid-closed display-sleep line without a failure.
- (h) Clean stops: `ka start 1` then `ka stop`: `flag` shows `No` within 5 seconds; `ka start 1` again, then `REMI_HOME="$G" "$REMI" stop`: the hub exits and `flag` shows `No`; restart the hub, `ka start 1` again, then Control-C in the hub's terminal: `flag` shows `No`.

Afterwards: keep the setup for daily use, or undo it with the removal commands `ka setup` printed, then `ka watchdog uninstall`, and delete the folder `$G`.
Record: pass or fail of setup steps 2, 3 and 5 and of (a) to (h); for (b), whether the Mac slept and within how many minutes; for (c), whether the login window answered ssh; the remi version, the model and the build.
