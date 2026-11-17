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
  /usr/bin/timeout 10 /usr/sbin/sysadminctl -screenLock status </dev/null > "$d/sysadminctl-screenlock.stdout" 2> "$d/sysadminctl-screenlock.stderr"; echo "$?" > "$d/sysadminctl-screenlock.exit"
  defaults read com.apple.screensaver askForPassword > "$d/defaults-askForPassword.stdout" 2> "$d/defaults-askForPassword.stderr"; echo "$?" > "$d/defaults-askForPassword.exit"
  defaults read com.apple.screensaver askForPasswordDelay > "$d/defaults-askForPasswordDelay.stdout" 2> "$d/defaults-askForPasswordDelay.stderr"; echo "$?" > "$d/defaults-askForPasswordDelay.exit"
  echo "captured $1"
}
```

Then, with nothing else holding the Mac awake (no video, no call, no remi session doing work):
1. Plugged in, lid open: `capture ac-idle`.
2. Unplug, then at once: `capture battery-just-unplugged` (the time estimate is usually missing right after unplugging).
3. Still unplugged, after about 3 minutes: `capture battery-idle`.
4. Still unplugged, a video playing in Safari in the foreground: `capture battery-video`; stop the video.
5. Password on wake (System Settings, Lock Screen, "Require password after screen saver begins or display is turned off"): set it to "Immediately" and run `capture lock-immediately`; set it to "After 5 minutes" and run `capture lock-5-minutes`; if the menu offers "Never", set it and run `capture lock-never` (skip this capture if there is no "Never" option); set it back to the value you use (level 2 will require "Immediately").
6. Still unplugged, in a FaceTime call (or the call app you use): `capture battery-call`; end the call.
7. Copy the folder to the Mac mini, for example from the Mac mini: `mkdir -p /Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/captures/OG-CAP && scp -r mba:remi-awake-captures/. /Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/captures/OG-CAP/`; then you may delete `~/remi-awake-captures` on the MacBook.
The captures can hold application names, a page title, serial numbers and your user name; agents redact them before anything is committed (preamble item 6), and nothing raw leaves the artifacts folder.
Each folder holds one file per command; the screen-lock reads keep standard output, standard error and the exit code in separate files (`.stdout`, `.stderr`, `.exit`), because the parse rule depends on the stream (G0 saw the answer only on standard error).
The `sysadminctl` call is the read-only `-screenLock status` only, never any other verb, and no command changes a setting.
Record: done per state (seven folders, eight with `lock-never`), whether the menu offered "Never", the model and the build.

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

Before starting, make sure nothing else holds the Mac awake: `pmset -g assertions` shows no video, call or other `caffeinate` holder, and your regular remi hub's sessions are idle (they live in another remi home, so this test hub counts their holders as another app's and pauses).
Record `pmset -g | grep -E '^ *(sleep|displaysleep) '` (the idle timers).
With the defaults, an automatic start or resume waits for `level2_resume_dwell_seconds` (2 minutes) with every condition clear and the lid open, and a resume also waits 10 minutes after the last pause (`level2_resume_min_interval_minutes`).

Setup (the commands marked sudo are yours to type; remi prints them and runs none):
1. `ka setup` and follow its printed steps (sudo: a root-owned staging directory from `sudo mktemp -d`, `visudo -cf`, `install` of `/etc/sudoers.d/remi-keep-awake`, `install` and `launchctl bootstrap system` of `/Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist`); compare the printed `sudo cat` and `sudo plutil -p` output with `docs/agent-reference/keep-awake.md`.
2. `sudo -n -l /usr/bin/pmset -a disablesleep 1` and `sudo -n -l /usr/bin/pmset -a disablesleep 0` each print their command (this also shows that macOS reads `/etc/sudoers.d`, which ADR 0050 could not verify).
3. `ka watchdog install`, then `launchctl print "gui/$(id -u)/com.yooz.remi.keep-awake-watchdog" | head -3` shows the agent.
4. `printf '[daemon]\nbase_port = 18801\n[awake]\nlevel2 = true\n' > "$G/config.toml"`; start the test hub in its own terminal with `REMI_HOME="$G" "$REMI" serve`; in a scratch project folder start a session with `REMI_HOME="$G" "$REMI" --port 18810`, and give it no task yet.
5. `ka status` shows `level2: armed`, the sudoers file and the boot daemon present, and the watchdog loaded; `grep '\[Awake2\]' "$G/remi.log"` shows the hub came up armed.

Tests, on battery unless a step says otherwise:
- (a) Automatic on and lid close (Q1 (b)): on battery at 36 percent or more, lid open, ask Claude for a long task (`sleep 3600`); within 3 minutes `ka status` shows `level2: on`, turned on automatically, with a run end about `level2_default_hours` (3) away; close the lid; after 2 minutes `mbaflag` on the Mac mini shows `"SleepDisabled" = Yes` and `"AppleClamshellState" = Yes`, and the phone still reaches your regular hub on the MacBook.
- (a1) A person's stop and arm: open the lid, `ka stop`: `ka status` shows `level2: disarmed` (`stopped`) and `flag` shows `No`; give the session new work: it stays `disarmed`; `ka arm`: within 3 minutes it is `on` again.
- (a2) Pause and resume by a setting, without a loop: with level 2 on and the lid open, set "Require password after screen saver begins or display is turned off" to "After 5 minutes": `ka status` shows `paused` (`password-on-wake-off`) by the next start check and `grep -c 'paused' "$G/remi.log"` grew by one only over 5 minutes of work; set it back to "Immediately": it resumes within about 12 minutes (the dwell and the minimum interval), with one resume line.
- (a3) The lid closed blocks a resume, also in dark wakes (Q13): pause it by playing a video in Safari until `ka status` shows `paused` (`foreign-holder`), stop the video and close the lid at once; the Mac sleeps (`ssh -o ConnectTimeout=5 mba true` stops answering within 4 minutes); leave it closed for 30 minutes, then open it: `pmset -g log | grep -ci darkwake` counts the dark wakes, and `grep '\[Awake2\]' "$G/remi.log"` shows no resume while the lid was closed and a resume about 2 minutes after you opened it.
- (b0) Hub killed, lid open: `kill -9 "$(/usr/bin/jq -r .pid "$G/daemon-status.json")"` while on; within 3 minutes `flag` shows `"SleepDisabled" = No` and `"$G/keep-awake/watchdog.log"` has one revert line; start the hub again: `ka status` shows `disarmed` (`restart`, Q12 (b)); `ka arm`.
- (b1) Hub killed and restarted before the watchdog: while on, `kill -9` the hub as in (b0) and start it again within 30 seconds: `grep '\[Awake2\]' "$G/remi.log" | tail -3` shows one reconcile line that turned the flag off, `flag` shows `No`, and `ka status` shows `disarmed` (`restart`); `ka arm`.
- (b) Hub killed, lid closed, level 1 still holding (the riskiest assumption): restart the test hub, `ka arm`, make sure the session is busy and `pmset -g assertions | grep -A3 caffeinate` shows its holder, wait for `on`, close the lid; on the Mac mini, `ssh mba 'pmset -g assertions | grep -c caffeinate; kill -9 "$(/usr/bin/jq -r .pid "$HOME/.remi-awake-gate/daemon-status.json")"'` (the count must be at least 1).
  Wait 5 minutes, probing at most once a minute with `ssh -o ConnectTimeout=5 mba true`, then open the lid.
  Pass only if `pmset -g log | grep -E " Sleep | Wake " | tail -8` shows a Sleep entry after the revert time in `"$G/keep-awake/watchdog.log"`; record its time and its reason text as printed.
  If the Mac stayed awake with the flag `No`, record that: it triggers L2-SLEEPNOW (owner decision 6).
- (b') The same with no idle assertion: stop the session first, so `pmset -g assertions` shows no `caffeinate`, then repeat (b) with `ka start 1` instead of waiting for work; record whether and when it slept and the reason text (idle sleep after the `sleep` timer would explain a pass here, which is why (b) keeps level 1 holding).
- (c) Reboot with the flag set: while on (AC is fine), (sudo) `sudo shutdown -r now`.
  At the login window, if `mbaflag` answers, it shows `"SleepDisabled" = No`; after logging in, `flag` shows `No` (the boot daemon cleared it).
  Start the test hub again: afterwards `ls "$G/keep-awake/lease.json"` reports no such file, and `ka status` shows `armed` (the hub recorded a clean exit at shutdown) or `disarmed` (`restart`, a lease was left); record which.
- (d) Battery pause and resume: unplugged, with P from `pmset -g batt` (at least 40), add the lines `level2_start_battery_percent = P` and `level2_revert_battery_percent = P-5` (as numbers) under `[awake]` in `"$G/config.toml"`, restart the test hub, `ka arm`, keep the session busy with the lid open; when `pmset -g batt` shows P-5 or less, within one minute `ka status` shows `paused` (`battery-low`) and `flag` shows `No`; it does not resume at P-4 or P-3 on battery; plug in AC: it resumes within about 12 minutes with one resume line.
  Remove the two lines again.
- (e) Another app pauses and its end resumes: with level 2 on, play a video in Safari: after about 2 minutes `ka status` shows `paused` (`foreign-holder`) and `flag` shows `No`; stop the video: it resumes within about 12 minutes.
- (f) Password on wake: with level 2 on, close the lid for a minute and open it: the Mac asks for your password before showing the desktop.
- (g) Display: during (a), the internal display is dark with the lid closed (no light at the hinge), and `grep '\[Awake2\]' "$G/remi.log"` shows the lid-closed display-sleep line without a failure.
- (h) Clean stops: `ka start 1` then `ka stop`: `flag` shows `No` within 5 seconds; `ka start 1` again, then `REMI_HOME="$G" "$REMI" stop`: the hub exits, `flag` shows `No`, and a new hub comes up `armed` (a clean exit); `ka start 1` again, then Control-C in the hub's terminal: `flag` shows `No`.
- (k) A switch failure disarms without a retry (optional): (sudo) `sudo mv /etc/sudoers.d/remi-keep-awake /etc/sudoers.d/remi-keep-awake.off` (sudo ignores a name with a dot), `ka stop`, `ka arm`, keep the session busy for 10 minutes: `ka status` shows `disarmed` (`revert-not-permitted` or `sudo-refused`) and `grep -c 'switch' "$G/remi.log"` shows one attempt only; (sudo) `sudo mv /etc/sudoers.d/remi-keep-awake.off /etc/sudoers.d/remi-keep-awake`, `ka arm`.

Afterwards, either remove everything (`ka stop`, the removal commands `ka setup` printed, `ka watchdog uninstall`, then delete the folder `$G`), or keep level 2 for daily use: `ka stop`, `ka watchdog uninstall`, then from your daily remi home `"$REMI" keep-awake watchdog install` (the watchdog serves one remi home), and delete the folder `$G`.
Record: the idle timers; pass or fail of setup steps 2, 3 and 5 and of (a) to (a3), (b0), (b1), (b), (b'), (c) to (h) and (k) if run; for (b) and (b'), whether the Mac slept, the minutes from the kill, and the reason text; for (a3), the number of dark wakes; for (c), whether the login window answered ssh and the state after the reboot; the number of `[Awake2]` lines per hour during the session; the remi version, the model and the build.
