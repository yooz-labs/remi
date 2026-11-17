/**
 * The keep-awake watchdog script (ADR 0050, "Fail-safe design for level 2"
 * items 4 to 6, #1773): a POSIX `sh` script, run by a user LaunchAgent (see
 * `watchdogPlist`), that reverts the machine-wide sleep flag while a lease
 * exists and the flag cannot be read, or the hub that set it can no longer be
 * trusted to: its lease is invalid, expired or stale, the hub is gone (a dead
 * or reused pid), or the battery is at or under the lease's revert level. It
 * is a script and not the remi binary, so an upgrade, a downgrade or a broken
 * install cannot disable it.
 *
 * The decision logic lives in the generated text below, and tests run that
 * text for real. The tool paths, the revert command and every number are
 * fixed when the script is generated: production uses the defaults (`sudo -n`
 * running Apple's `pmset`, both from `level2-commands.ts`, and the `DEFAULT_*`
 * values below); tests pass their own executables and values. There is no
 * dry-run mode.
 *
 * After `revertFailureMarkerThreshold` consecutive failures (a revert that
 * did not clear the flag, or a run past its time limit) the script leaves a
 * `revert-failed` file next to the lease, holding the last failure line, and
 * removes it at the next successful revert. Nothing reads that file yet: the
 * hub and `remi keep-awake status` (later slices, L2-CORE and L2-CLI) will
 * surface it.
 *
 * Nothing writes or installs this script yet.
 */

import * as path from 'node:path';
import {
  DATE_PATH,
  DISABLESLEEP_OFF,
  IOREG_PATH,
  PLUTIL_PATH,
  PMSET_PATH,
  PS_PATH,
  SUDO_PATH,
  keepAwakeDir,
  positiveIntegerOption,
  sudoArgv,
} from './level2-commands.ts';
import { LEASE_KEYS, leasePath } from './level2-lease.ts';

/** The executables the script reads system state with, and the `ln` it restores a lease with. */
export interface WatchdogTools {
  ioreg: string;
  pmset: string;
  plutil: string;
  ps: string;
  date: string;
  ln: string;
}

export const DEFAULT_WATCHDOG_TOOLS: Readonly<WatchdogTools> = Object.freeze({
  ioreg: IOREG_PATH,
  pmset: PMSET_PATH,
  plutil: PLUTIL_PATH,
  ps: PS_PATH,
  date: DATE_PATH,
  ln: '/bin/ln',
});

// The defaults of the numeric options of `buildWatchdogScript`. Every number
// is an option (owner rule); the configuration keys that set them arrive with
// the hub and command slices (L2-HUB, L2-CLI).
/** `commandDeadlineSeconds`: how long one command may run before it is killed. */
export const DEFAULT_WATCHDOG_COMMAND_DEADLINE_SECONDS = 10;
/** `killGraceSeconds`: how long the script waits for a killed command before giving up on it. */
export const DEFAULT_WATCHDOG_KILL_GRACE_SECONDS = 1;
/** `pollIntervalMs`: how often the script checks whether a command has finished. */
export const DEFAULT_WATCHDOG_POLL_INTERVAL_MS = 20;
/** `runLimitSeconds`: the time one run may spend waiting on commands; a late run is a failure. */
export const DEFAULT_WATCHDOG_RUN_LIMIT_SECONDS = 45;
/** `integerMaxDigits`: the most digits a lease integer may have. */
export const DEFAULT_LEASE_INTEGER_MAX_DIGITS = 16;
/** `revertFailureMarkerThreshold`: consecutive failures before the `revert-failed` marker. */
export const DEFAULT_REVERT_FAILURE_MARKER_THRESHOLD = 3;
/** `failureLogIntervalSeconds`: a repeated identical failure line is logged at most this often. */
export const DEFAULT_FAILURE_LOG_INTERVAL_SECONDS = 3600;
/** `revertErrorMaxChars`: the longest part of the revert's first stderr line that is logged. */
export const DEFAULT_REVERT_ERROR_MAX_CHARS = 200;
/** `orphanMaxAgeSeconds`: work directories and claims left by killed runs are removed after this. */
export const DEFAULT_ORPHAN_MAX_AGE_SECONDS = 300;
/** `invalidLeaseMaxAgeMinutes`: with the flag clear, an invalid lease older than this is deleted. */
export const DEFAULT_INVALID_LEASE_MAX_AGE_MINUTES = 5;
/** `fallbackWorkParent`: where the work directory goes when the lease directory cannot hold one. */
export const DEFAULT_FALLBACK_WORK_PARENT = '/private/tmp';

/**
 * The most commands one run starts: nine `plutil` reads of the lease, `find`
 * for orphans, the flag read, the clock read, `ps`, `pmset`, the revert, the
 * second flag read, up to four clock reads for log lines and the throttle,
 * `mv`, nine `plutil` reads of the claim, `ln`, `rm`, and the marker's `rm`,
 * rounded up. Where a run's time goes: a command that hangs costs its
 * deadline (a sleeping timer, so wall-clock time whatever the load), plus the
 * grace only when the kill does not end it; every other command costs at
 * least one poll interval plus starting its wrapper, itself, its timer and
 * that timer's sleep. A run whose flag read hangs at the defaults therefore
 * takes 10 s plus about 30 short commands: 10.8 to 10.9 s measured on the
 * owner's Mac mini at a load average of 13 to 15 (2026-11-17).
 */
export const WATCHDOG_MAX_COMMANDS_PER_RUN = 32;

export interface WatchdogScriptOptions {
  remiHome: string;
  tools?: WatchdogTools;
  revertArgv?: readonly string[];
  commandDeadlineSeconds?: number;
  killGraceSeconds?: number;
  pollIntervalMs?: number;
  runLimitSeconds?: number;
  integerMaxDigits?: number;
  revertFailureMarkerThreshold?: number;
  failureLogIntervalSeconds?: number;
  revertErrorMaxChars?: number;
  orphanMaxAgeSeconds?: number;
  invalidLeaseMaxAgeMinutes?: number;
  fallbackWorkParent?: string;
}

type NumericOption = {
  [K in keyof WatchdogScriptOptions]-?: WatchdogScriptOptions[K] extends number | undefined
    ? K
    : never;
}[keyof WatchdogScriptOptions];

/** The revert command the production script runs: `sudo -n pmset` clearing the flag. */
export function defaultRevertArgv(): string[] {
  return [SUDO_PATH, ...sudoArgv(DISABLESLEEP_OFF)];
}

/** Where the script leaves the marker after repeated failures. */
export function revertFailedMarkerPath(remiHome: string): string {
  return path.join(keepAwakeDir(remiHome), 'revert-failed');
}

/** Where the script keeps its failure count and log throttle between runs. */
export function watchdogStatePath(remiHome: string): string {
  return path.join(keepAwakeDir(remiHome), 'watchdog-state');
}

/**
 * `value` as one single-quoted `sh` word. Throws for a single quote or a
 * control character (a newline included) instead of escaping them, so every
 * embedded value is plain text inside its quotes.
 */
function shWord(what: string, value: string): string {
  if (value.includes("'") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${what} must not contain a single quote or a control character`);
  }
  return `'${value}'`;
}

function absoluteWord(what: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${what} must be an absolute path: ${value}`);
  return shWord(what, value);
}

/**
 * The watchdog script for `remiHome`. Every option has a default (the tools,
 * the revert command and the `DEFAULT_*` numbers). Throws when `remiHome`, a
 * tool or `fallbackWorkParent` is not an absolute path, when an embedded value
 * contains a single quote or a control character, or when a numeric option is
 * not a positive integer.
 */
export function buildWatchdogScript(options: WatchdogScriptOptions): string {
  const tools = options.tools ?? DEFAULT_WATCHDOG_TOOLS;
  const revertArgv = options.revertArgv ?? defaultRevertArgv();
  const number = (name: NumericOption, fallback: number): number =>
    positiveIntegerOption(name, options[name], fallback);
  const deadline = number('commandDeadlineSeconds', DEFAULT_WATCHDOG_COMMAND_DEADLINE_SECONDS);
  const grace = number('killGraceSeconds', DEFAULT_WATCHDOG_KILL_GRACE_SECONDS);
  const pollMs = number('pollIntervalMs', DEFAULT_WATCHDOG_POLL_INTERVAL_MS);
  const runLimit = number('runLimitSeconds', DEFAULT_WATCHDOG_RUN_LIMIT_SECONDS);
  const digits = number('integerMaxDigits', DEFAULT_LEASE_INTEGER_MAX_DIGITS);
  const threshold = number('revertFailureMarkerThreshold', DEFAULT_REVERT_FAILURE_MARKER_THRESHOLD);
  const logInterval = number('failureLogIntervalSeconds', DEFAULT_FAILURE_LOG_INTERVAL_SECONDS);
  const errorChars = number('revertErrorMaxChars', DEFAULT_REVERT_ERROR_MAX_CHARS);
  const orphanAge = number('orphanMaxAgeSeconds', DEFAULT_ORPHAN_MAX_AGE_SECONDS);
  const invalidAge = number('invalidLeaseMaxAgeMinutes', DEFAULT_INVALID_LEASE_MAX_AGE_MINUTES);
  const ticks = (ms: number) => Math.ceil(ms / pollMs);

  absoluteWord('the remi home', options.remiHome);
  const lease = leasePath(options.remiHome);
  const [revertCommand, ...revertArgs] = revertArgv;
  if (revertCommand === undefined) throw new Error('the revert command is empty');
  const revertWords = [
    absoluteWord('the revert command', revertCommand),
    ...revertArgs.map((arg) => shWord('a revert argument', arg)),
  ].join(' ');
  const keyPattern = LEASE_KEYS.map((key) => `'<key>${key}</key>'`).join(' | ');

  const header = `#!/bin/sh
# remi keep-awake watchdog (ADR 0050, #1773), generated by remi for one remi
# home; remi rewrites this file, so edits do not last. A user LaunchAgent runs
# it with /bin/sh at load and then at a fixed interval. It never runs as root
# and reads no configuration: the lease carries what it needs.
#
# It acts only when this remi home has a lease file (or a lease a killed run
# left renamed aside). With SleepDisabled unreadable, it runs the revert
# command. With SleepDisabled set, it runs it when the lease is invalid,
# expired or stale, when the hub that wrote it is gone, or on battery power at
# or under the lease's revert level. With SleepDisabled clear it reverts
# nothing; it deletes a lease that is expired, stale or whose hub is gone, and
# an invalid lease older than a few minutes. It logs one line per revert, per
# failed revert (a repeated identical failure at most once per interval), per
# run past its time limit and per deleted invalid lease, and always exits 0.

PATH=/usr/bin:/bin:/usr/sbin:/sbin
LC_ALL=C
TZ=UTC0
export PATH LC_ALL TZ
umask 077
set -f

LEASE_DIR=${shWord('the lease directory', path.dirname(lease))}
LEASE=${shWord('the lease path', lease)}
STATE=${shWord('the state path', watchdogStatePath(options.remiHome))}
MARKER=${shWord('the marker path', revertFailedMarkerPath(options.remiHome))}
FALLBACK_PARENT=${absoluteWord('fallbackWorkParent', options.fallbackWorkParent ?? DEFAULT_FALLBACK_WORK_PARENT)}
IOREG=${absoluteWord('ioreg', tools.ioreg)}
PMSET=${absoluteWord('pmset', tools.pmset)}
PLUTIL=${absoluteWord('plutil', tools.plutil)}
PS=${absoluteWord('ps', tools.ps)}
DATE=${absoluteWord('date', tools.date)}
LN=${absoluteWord('ln', tools.ln)}
DEADLINE=${deadline}
GRACE=${grace}
POLL=${pollMs / 1000}
RUN_LIMIT=${runLimit}
# Only run_without_work counts poll intervals instead of timing with a timer.
DEADLINE_TICKS=${ticks(deadline * 1000)}
GRACE_TICKS=${ticks(grace * 1000)}
DIGITS=${digits}
MARKER_THRESHOLD=${threshold}
LOG_INTERVAL=${logInterval}
ERROR_CHARS=${errorChars}
ORPHAN_AGE='+${orphanAge}s'
INVALID_AGE_MINUTES=${invalidAge}
INVALID_AGE='+${invalidAge * 60}s'
LEASE_KEY_COUNT=${LEASE_KEYS.length}

# The one revert command, fixed when this script was generated; $1 is the runner.
revert_action() {
  "$1" ${revertWords}
}

# lease_key_known LINE: LINE (trimmed) names one of the version 1 lease keys.
lease_key_known() {
  case $1 in
    ${keyPattern}) return 0 ;;
  esac
  return 1
}
`;

  return `${header}${WATCHDOG_BODY}`;
}

/**
 * The fixed part of the script. Every command that reads state or changes the
 * lease runs through `run_bounded`; only `mktemp`, `sleep` (the poll and the
 * timers) and the final cleanup run directly.
 */
const WATCHDOG_BODY = `
TAB=$(printf '\\t')
RB_SEQ=0
RUN_OVER=no
RUN_LATE=
RUN_TIMER=
WORK=
NOW=

# is_uint TEXT: TEXT is a decimal integer of at most DIGITS digits, no leading zero.
is_uint() {
  case $1 in
    '' | *[!0-9]* | 0?*) return 1 ;;
  esac
  [ "\${#1}" -le "$DIGITS" ]
}

# trim TEXT: sets TRIMMED to TEXT without leading and trailing white space.
trim() {
  TRIMMED=$1
  TRIMMED=\${TRIMMED#"\${TRIMMED%%[![:space:]]*}"}
  TRIMMED=\${TRIMMED%"\${TRIMMED##*[![:space:]]}"}
}

# single_line FILE: sets LINE to the only line of FILE; fails for none or several.
single_line() {
  LINE=
  sl_count=0
  while IFS= read -r sl_line || [ -n "$sl_line" ]; do
    sl_count=$((sl_count + 1))
    LINE=$sl_line
  done <"$1"
  [ "$sl_count" -eq 1 ]
}

# kill_child PIDFILE: kills the command whose pid the file holds, if any.
kill_child() {
  if [ -s "$1" ] && IFS= read -r kc_pid <"$1" && is_uint "$kc_pid"; then
    kill -9 "$kc_pid" 2>/dev/null
  fi
}

# start_timer FILE SECONDS [FILE2 SECONDS2]: a background timer that sleeps
# SECONDS of wall-clock time and then creates FILE (and, SECONDS2 later,
# FILE2); TIMER is its pid, and a TERM ends it and its sleep. It signals
# nothing itself: the script polls for its files. One sleeping timer keeps a
# deadline at its length whatever the load, where counting poll intervals
# would stretch it by the time each poll takes to start sleep (about 9 ms per
# 20 ms interval on the owner's Mac mini under load, 45 percent).
start_timer() {
  (
    trap 'kill "$st_sleep" 2>/dev/null; exit 0' TERM
    sleep "$2" &
    st_sleep=$!
    wait "$st_sleep"
    : >"$1"
    if [ -n "$3" ]; then
      sleep "$4" &
      st_sleep=$!
      wait "$st_sleep"
      : >"$3"
    fi
  ) </dev/null >/dev/null 2>&1 &
  TIMER=$!
}

# check_run_limit: ends the run once its timer says it used up RUN_LIMIT.
check_run_limit() {
  if [ "$RUN_OVER" = no ] && [ -n "$RUN_LATE" ] && [ -e "$RUN_LATE" ]; then
    run_over
  fi
}

# run_bounded COMMAND [ARG...]: runs COMMAND with its output in RB_OUT and its
# errors in RB_ERR and sets RB_STATUS to its exit status. At the deadline (a
# wall-clock timer) it kills the command, waits at most the grace for it, and
# then gives up with RB_STATUS 124 and RB_TIMED_OUT=yes. It never blocks on a
# child: a wrapper subshell runs the command and writes its status to a file,
# which this shell polls every POLL seconds, so a child stuck in the kernel is
# left behind as an orphan and the run goes on. Output goes to files, not
# pipes, so nothing a killed child leaves behind can hold the script. Without
# a work directory nothing runs and RB_STATUS is 125.
#
# Its cost: a command that finishes costs at least one poll interval plus
# starting the wrapper, the command, the timer and its sleep; one that hangs
# costs the deadline, plus the grace only when the kill does not end it.
run_bounded() {
  RB_STATUS=125
  RB_TIMED_OUT=no
  RB_OUT=/dev/null
  RB_ERR=/dev/null
  [ -n "$WORK" ] || return 125
  check_run_limit
  RB_SEQ=$((RB_SEQ + 1))
  RB_OUT="$WORK/out.$RB_SEQ"
  RB_ERR="$WORK/err.$RB_SEQ"
  rb_pid="$WORK/pid.$RB_SEQ"
  rb_done="$WORK/done.$RB_SEQ"
  rb_late="$WORK/late.$RB_SEQ"
  rb_gone="$WORK/gone.$RB_SEQ"
  (
    "$@" >"$RB_OUT" 2>"$RB_ERR" </dev/null &
    echo "$!" >"$rb_pid"
    wait "$!"
    echo "$?" >"$rb_done"
  ) </dev/null >/dev/null 2>&1 &
  start_timer "$rb_late" "$DEADLINE" "$rb_gone" "$GRACE"
  rb_timer=$TIMER
  while [ ! -s "$rb_done" ]; do
    if [ -e "$rb_gone" ]; then
      break
    fi
    if [ "$RB_TIMED_OUT" = no ] && [ -e "$rb_late" ]; then
      RB_TIMED_OUT=yes
      kill_child "$rb_pid"
    fi
    if [ "$RUN_OVER" = no ] && [ -n "$RUN_LATE" ] && [ -e "$RUN_LATE" ]; then
      kill "$rb_timer" 2>/dev/null
      kill_child "$rb_pid"
      run_over
    fi
    sleep "$POLL"
  done
  kill "$rb_timer" 2>/dev/null
  if [ "$RB_TIMED_OUT" = yes ]; then
    RB_STATUS=124
  elif IFS= read -r rb_status <"$rb_done" && is_uint "$rb_status"; then
    RB_STATUS=$rb_status
  fi
  return "$RB_STATUS"
}

# run_without_work COMMAND [ARG...]: the revert when no work directory could be
# made: no output is kept, the command is killed at the deadline, and the script
# gives up on it after the grace without waiting. With no file for a timer to
# create, the deadline and the grace are counted in poll intervals, so they
# stretch under load (by about half on the owner's Mac mini). RB_STATUS is the
# exit status when the shell has already collected it (bash does so by itself),
# else 124.
run_without_work() {
  RB_STATUS=124
  RB_TIMED_OUT=no
  RB_OUT=/dev/null
  RB_ERR=/dev/null
  "$@" >/dev/null 2>&1 </dev/null &
  rw_pid=$!
  rw_ticks=0
  rw_limit=$DEADLINE_TICKS
  while kill -0 "$rw_pid" 2>/dev/null; do
    if [ "$rw_ticks" -ge "$rw_limit" ]; then
      if [ "$RB_TIMED_OUT" = yes ]; then
        return 124
      fi
      RB_TIMED_OUT=yes
      kill -9 "$rw_pid" 2>/dev/null
      rw_ticks=0
      rw_limit=$GRACE_TICKS
    fi
    sleep "$POLL"
    rw_ticks=$((rw_ticks + 1))
  done
  if [ "$RB_TIMED_OUT" = no ]; then
    wait "$rw_pid" 2>/dev/null
    RB_STATUS=$?
  fi
  return "$RB_STATUS"
}

# stamp: sets STAMP to the UTC time for a log line.
stamp() {
  STAMP=unknown-time
  if run_bounded "$DATE" -u +%Y-%m-%dT%H:%M:%SZ && single_line "$RB_OUT"; then
    STAMP=$LINE
  fi
}

# log_line TEXT: one line of the log, with its UTC time.
log_line() {
  stamp
  printf '%s %s\\n' "$STAMP" "$1"
}

# read_now: sets NOW to the epoch seconds; fails when the clock cannot be read.
read_now() {
  NOW=
  run_bounded "$DATE" +%s && single_line "$RB_OUT" && is_uint "$LINE" || return 1
  NOW=$LINE
}

# load_state: ST_FAILURES (consecutive failures), ST_LOGGED_AT (when the last
# failure line was logged) and ST_LAST (the last failure line) from the state
# file; 0, 0 and nothing when it is missing or unreadable.
load_state() {
  ST_FAILURES=0
  ST_LOGGED_AT=0
  ST_LAST=
  if [ ! -f "$STATE" ] || [ -L "$STATE" ]; then
    return 0
  fi
  while IFS= read -r ls_line || [ -n "$ls_line" ]; do
    case $ls_line in
      failures=*)
        ls_value=\${ls_line#failures=}
        if is_uint "$ls_value"; then ST_FAILURES=$ls_value; fi
        ;;
      logged_at=*)
        ls_value=\${ls_line#logged_at=}
        if is_uint "$ls_value"; then ST_LOGGED_AT=$ls_value; fi
        ;;
      last=*) ST_LAST=\${ls_line#last=} ;;
    esac
  done <"$STATE"
}

save_state() {
  { printf 'failures=%s\\nlogged_at=%s\\nlast=%s\\n' "$ST_FAILURES" "$ST_LOGGED_AT" "$ST_LAST" >"$STATE"; } 2>/dev/null
}

# record_failure TEXT [FIRST]: one more consecutive failure. TEXT (after FIRST,
# when given) is logged unless the previous failure had the same TEXT and was
# logged less than LOG_INTERVAL seconds ago; from MARKER_THRESHOLD consecutive
# failures on, the marker file holds TEXT.
record_failure() {
  load_state
  ST_FAILURES=$((ST_FAILURES + 1))
  rf_log=yes
  if [ "$1" = "$ST_LAST" ] && { [ -n "$NOW" ] || read_now; }; then
    if [ "$NOW" -ge "$ST_LOGGED_AT" ] && [ $((NOW - ST_LOGGED_AT)) -lt "$LOG_INTERVAL" ]; then
      rf_log=no
    fi
  fi
  if [ "$rf_log" = yes ]; then
    if [ -n "$2" ]; then log_line "$2"; fi
    log_line "$1"
    if [ -n "$NOW" ] || read_now; then ST_LOGGED_AT=$NOW; else ST_LOGGED_AT=0; fi
  fi
  ST_LAST=$1
  save_state
  if [ "$ST_FAILURES" -ge "$MARKER_THRESHOLD" ]; then
    { printf '%s\\n' "$1" >"$MARKER"; } 2>/dev/null
  fi
}

# record_success: a revert worked, so the failure count and the marker go.
record_success() {
  load_state
  if [ "$ST_FAILURES" != 0 ] || [ -n "$ST_LAST" ]; then
    ST_FAILURES=0
    ST_LOGGED_AT=0
    ST_LAST=
    save_state
  fi
  if [ -e "$MARKER" ] || [ -L "$MARKER" ]; then
    run_bounded rm -f "$MARKER"
  fi
}

# run_over: the run used up its time limit; a late run counts as a failure.
run_over() {
  RUN_OVER=yes
  record_failure "run exceeded $RUN_LIMIT s"
  exit 0
}

# lease_integer FILE KEY: sets LINE to the integer at KEY; fails when KEY is
# missing, not of the integer type, or not a canonical decimal of at most
# DIGITS digits.
lease_integer() {
  run_bounded "$PLUTIL" -extract "$2" raw -expect integer -o - "$1" && single_line "$RB_OUT" && is_uint "$LINE"
}

# lease_keys FILE: the lease has exactly the version 1 keys and no other.
lease_keys() {
  run_bounded "$PLUTIL" -convert xml1 -o - "$1" || return 1
  lk_count=0
  while IFS= read -r lk_line || [ -n "$lk_line" ]; do
    trim "$lk_line"
    case $TRIMMED in
      '<key>'*)
        lease_key_known "$TRIMMED" || return 1
        lk_count=$((lk_count + 1))
        ;;
    esac
  done <"$RB_OUT"
  [ "$lk_count" -eq "$LEASE_KEY_COUNT" ]
}

# read_lease FILE: reads the lease into the L_ variables and succeeds only for
# a regular file (not a symlink) with exactly the version 1 keys, version 1, a
# one-line hubStartTime string and integers of the integer type where integers
# belong. L_PID and L_STARTED keep what was read, empty when it could not be,
# so a later claim can tell this lease from a newer one.
read_lease() {
  L_VERSION= L_PID= L_HUBSTART= L_STARTED= L_EXPIRES= L_HEARTBEAT= L_STALE= L_BATTERY=
  if [ -z "$WORK" ] || [ ! -f "$1" ] || [ -L "$1" ]; then
    return 1
  fi
  rl_ok=yes
  if lease_integer "$1" hubPid; then L_PID=$LINE; else rl_ok=no; fi
  if lease_integer "$1" startedAt; then L_STARTED=$LINE; else rl_ok=no; fi
  [ "$rl_ok" = yes ] && lease_keys "$1" || return 1
  lease_integer "$1" version && [ "$LINE" = 1 ] || return 1
  L_VERSION=1
  run_bounded "$PLUTIL" -extract hubStartTime raw -expect string -o - "$1" &&
    single_line "$RB_OUT" && [ -n "$LINE" ] || return 1
  L_HUBSTART=$LINE
  lease_integer "$1" expiresAt || return 1
  L_EXPIRES=$LINE
  lease_integer "$1" heartbeatAt || return 1
  L_HEARTBEAT=$LINE
  lease_integer "$1" staleSeconds || return 1
  L_STALE=$LINE
  lease_integer "$1" revertBatteryPercent || return 1
  L_BATTERY=$LINE
  [ "$L_PID" -ge 1 ]
}

# read_flag: sets FLAG to Yes or No when exactly one line of the root domain
# names SleepDisabled, with one of those values; else to unreadable, with
# FLAG_WHY set when the reason is that no work file could be made.
read_flag() {
  FLAG=unreadable
  FLAG_WHY=
  if [ -z "$WORK" ]; then
    FLAG_WHY='no work directory'
    return 0
  fi
  run_bounded "$IOREG" -r -c IOPMrootDomain -d 1 || return 0
  rf_count=0
  rf_value=unreadable
  while IFS= read -r rf_line || [ -n "$rf_line" ]; do
    case $rf_line in
      *'"SleepDisabled"'*)
        rf_count=$((rf_count + 1))
        trim "$rf_line"
        case $TRIMMED in
          '"SleepDisabled" = Yes') rf_value=Yes ;;
          '"SleepDisabled" = No') rf_value=No ;;
          *) rf_value=unreadable ;;
        esac
        ;;
    esac
  done <"$RB_OUT"
  if [ "$rf_count" -eq 1 ]; then FLAG=$rf_value; fi
  return 0
}

# hub_alive: the lease's hubPid is a live process that started at hubStartTime.
# ps prints local time, and TZ=UTC0 above pins it as the hub's writer does.
hub_alive() {
  run_bounded "$PS" -o lstart= -p "$L_PID" && single_line "$RB_OUT" || return 1
  trim "$LINE"
  [ "$TRIMMED" = "$L_HUBSTART" ]
}

# lease_trip: sets REASON to expired, heartbeat stale (too old, or ahead of a
# clock stepped back) or hub gone, the first that holds; to clock unreadable
# when the clock cannot be read; else to nothing.
lease_trip() {
  REASON=
  if ! read_now; then
    REASON='clock unreadable'
  elif [ "$NOW" -ge "$L_EXPIRES" ]; then
    REASON=expired
  elif [ $((NOW - L_HEARTBEAT)) -gt "$L_STALE" ] || [ "$L_HEARTBEAT" -gt $((NOW + L_STALE)) ]; then
    REASON='heartbeat stale'
  elif ! hub_alive; then
    REASON='hub gone'
  fi
}

# first_percent TEXT: sets PERCENT to the first N% token of TEXT, if any.
first_percent() {
  fp_ifs=$IFS
  IFS=" $TAB;"
  for fp_token in $1; do
    case $fp_token in
      *%)
        fp_number=\${fp_token%"%"}
        if is_uint "$fp_number"; then
          PERCENT=$fp_number
          break
        fi
        ;;
    esac
  done
  IFS=$fp_ifs
}

# battery_trip: sets REASON to battery on battery power at or under the
# lease's revert level, to battery unreadable when the source or, on battery
# power, the level cannot be read; on AC power to nothing.
battery_trip() {
  REASON=
  PERCENT=
  if ! run_bounded "$PMSET" -g batt; then
    REASON='battery unreadable'
    return 0
  fi
  bt_source=
  bt_first=yes
  while IFS= read -r bt_line || [ -n "$bt_line" ]; do
    if [ "$bt_first" = yes ]; then
      bt_first=no
      trim "$bt_line"
      bt_source=$TRIMMED
    elif [ -z "$PERCENT" ]; then
      first_percent "$bt_line"
    fi
  done <"$RB_OUT"
  case $bt_source in
    "Now drawing from 'AC Power'") ;;
    "Now drawing from 'Battery Power'")
      if [ -z "$PERCENT" ]; then
        REASON='battery unreadable'
      elif [ "$PERCENT" -le "$L_BATTERY" ]; then
        REASON=battery
      fi
      ;;
    *) REASON='battery unreadable' ;;
  esac
}

# lease_is_old: the lease file was last changed more than INVALID_AGE_MINUTES ago.
lease_is_old() {
  run_bounded find "$LEASE" -prune -mtime "$INVALID_AGE" && [ -s "$RB_OUT" ]
}

# claim_and_delete: deletes the lease only while it still holds the hubPid and
# startedAt this run read, so a lease written since is never deleted, and
# succeeds only when it deleted it. The lease is renamed aside first (one
# atomic step) and checked there; a lease that changed is linked back, unless
# an even newer one is already in place, and the claim is removed only once a
# lease is in place again (otherwise the next run restores it).
claim_and_delete() {
  CLAIM="$LEASE.watchdog-$$"
  run_bounded mv -f "$LEASE" "$CLAIM" || return 1
  read_lease "$CLAIM"
  if [ "$L_PID" != "$SEEN_PID" ] || [ "$L_STARTED" != "$SEEN_STARTED" ]; then
    run_bounded "$LN" -P "$CLAIM" "$LEASE"
    if [ -e "$LEASE" ] || [ -L "$LEASE" ]; then
      run_bounded rm -f "$CLAIM"
    fi
    return 1
  fi
  run_bounded rm -f "$CLAIM"
  return 0
}

# restore_claims: a run killed between renaming the lease aside and deleting
# or relinking it leaves only a claim. With no lease in place, the newest claim
# becomes the lease again (a link, so an even newer lease written meanwhile is
# never replaced), and the claim is removed once a lease is in place.
restore_claims() {
  if [ -e "$LEASE" ] || [ -L "$LEASE" ]; then
    return 0
  fi
  rc_newest=
  set +f
  for rc_claim in "$LEASE".watchdog-*; do
    if [ -e "$rc_claim" ] || [ -L "$rc_claim" ]; then
      if [ -z "$rc_newest" ] || [ "$rc_claim" -nt "$rc_newest" ]; then
        rc_newest=$rc_claim
      fi
    fi
  done
  set -f
  [ -n "$rc_newest" ] || return 0
  run_bounded "$LN" -P "$rc_newest" "$LEASE"
  if [ -e "$LEASE" ] || [ -L "$LEASE" ]; then
    run_bounded rm -f "$rc_newest"
  fi
}

# remove_orphans: work directories and claims that killed runs left behind,
# once they are older than ORPHAN_AGE.
remove_orphans() {
  run_bounded find "$LEASE_DIR" -mindepth 1 -maxdepth 1 \\( -name 'watchdog-run.*' -o -name 'lease.json.watchdog-*' \\) -mtime "$ORPHAN_AGE" -exec rm -rf {} +
}

# has_lease_or_claim: a lease, or a lease a killed run renamed aside, exists
# (shell builtins only).
has_lease_or_claim() {
  if [ -e "$LEASE" ] || [ -L "$LEASE" ]; then
    return 0
  fi
  set +f
  for hc_claim in "$LEASE".watchdog-*; do
    if [ -e "$hc_claim" ] || [ -L "$hc_claim" ]; then
      set -f
      return 0
    fi
  done
  set -f
  return 1
}

# make_work: a private work directory next to the lease, or under
# FALLBACK_PARENT when the lease directory cannot hold one; without either it
# logs once and leaves WORK empty, which every read then reports as such.
make_work() {
  WORK=$(mktemp -d "$LEASE_DIR/watchdog-run.XXXXXX" 2>/dev/null) || WORK=
  if [ -z "$WORK" ]; then
    WORK=$(mktemp -d "$FALLBACK_PARENT/remi-watchdog.XXXXXX" 2>/dev/null) || WORK=
  fi
  if [ -z "$WORK" ]; then
    log_line 'work directory unavailable'
    return 0
  fi
  # The run's own wall-clock limit, polled by run_bounded.
  RUN_LATE="$WORK/run-late"
  start_timer "$RUN_LATE" "$RUN_LIMIT"
  RUN_TIMER=$TIMER
}

cleanup() {
  if [ -n "$RUN_TIMER" ]; then
    kill "$RUN_TIMER" 2>/dev/null
  fi
  if [ -n "$WORK" ]; then
    rm -rf "$WORK"
  fi
}

# revert REASON: runs the revert command and reads the flag again. On success
# (exit 0 and the flag reads No) it logs the revert, clears the failure count
# and the marker, and deletes the lease if it is still the one this run read.
# Otherwise it keeps the lease, so the next run tries again, and records the
# failure with the exit status (or the deadline), the flag and the start of
# the first line the command wrote on stderr (never lease contents).
revert() {
  if [ -n "$WORK" ]; then
    revert_action run_bounded
  else
    revert_action run_without_work
  fi
  rv_status=$RB_STATUS
  rv_timed_out=$RB_TIMED_OUT
  rv_error=
  if [ -s "$RB_ERR" ]; then
    { IFS= read -r rv_error || :; } <"$RB_ERR"
  fi
  read_flag
  if [ "$rv_status" -eq 0 ] && [ "$FLAG" = No ]; then
    log_line "revert $1"
    record_success
    claim_and_delete
    return 0
  fi
  if [ "$rv_timed_out" = yes ]; then
    rv_detail="timed out after $DEADLINE s"
  else
    rv_detail="exit $rv_status"
  fi
  rv_detail="$rv_detail, flag $FLAG"
  if [ -n "$rv_error" ]; then
    rv_detail="$rv_detail, stderr: $(printf "%.\${ERROR_CHARS}s" "$rv_error")"
  fi
  record_failure "revert failed $1 ($rv_detail)" "revert $1"
}

# No lease and no lease renamed aside: nothing to do, whatever the flag reads,
# since the flag is not remi's then. Checked first with shell builtins only, so
# a Mac with level 2 off runs no other command.
has_lease_or_claim || exit 0

trap cleanup EXIT
make_work
if [ -n "$WORK" ]; then
  restore_claims
  remove_orphans
fi
if [ ! -e "$LEASE" ] && [ ! -L "$LEASE" ]; then
  exit 0
fi

if read_lease "$LEASE"; then LEASE_VALID=yes; else LEASE_VALID=no; fi
SEEN_PID=$L_PID
SEEN_STARTED=$L_STARTED
read_flag

case $FLAG in
  unreadable)
    if [ -n "$FLAG_WHY" ]; then
      revert "flag unreadable ($FLAG_WHY)"
    else
      revert 'flag unreadable'
    fi
    ;;
  No)
    # Nothing is reverted. A lease left by a crash before the enable, a failed
    # enable or a reboot is deleted, so it can never later turn into a revert
    # of a flag remi did not set. An invalid lease is given a few minutes (a
    # hub may be replacing it) and then deleted for the same reason.
    if [ "$LEASE_VALID" = yes ]; then
      lease_trip
      case $REASON in
        expired | 'heartbeat stale' | 'hub gone') claim_and_delete ;;
      esac
    elif lease_is_old && claim_and_delete; then
      log_line "deleted an invalid lease older than $INVALID_AGE_MINUTES min"
    fi
    ;;
  Yes)
    if [ "$LEASE_VALID" = no ]; then
      revert 'lease invalid'
    else
      lease_trip
      if [ -z "$REASON" ]; then battery_trip; fi
      if [ -n "$REASON" ]; then revert "$REASON"; fi
    fi
    ;;
esac
exit 0
`;
