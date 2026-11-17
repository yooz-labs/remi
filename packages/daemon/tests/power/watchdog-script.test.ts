/**
 * Runs the generated watchdog script for real (issue #1773, ADR 0050 slice 3):
 * `/bin/sh` with an empty environment, a temporary remi home, the real
 * `plutil` and `ps`, the real `date` unless a test needs a fixed clock, fake
 * `ioreg` and `pmset` executables that print captured output from
 * `fixtures/watchdog/` (one test uses the real `ioreg`), and, in place of
 * `sudo`, a stand-in that records its arguments and writes the new flag into
 * the state file the fake `ioreg` reads. That stand-in sits exactly at the
 * root boundary: the decision logic under test is the production script text,
 * generated with the test's tool paths and options.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DATE_PATH,
  DISABLESLEEP_OFF,
  IOREG_PATH,
  PLUTIL_PATH,
  PS_PATH,
  sudoArgv,
} from '../../src/power/level2-commands.ts';
import {
  type Level2Lease,
  leasePath,
  processStartTime,
  readLease,
  writeLease,
} from '../../src/power/level2-lease.ts';
import {
  DEFAULT_FAILURE_LOG_INTERVAL_SECONDS,
  DEFAULT_FALLBACK_WORK_PARENT,
  DEFAULT_INVALID_LEASE_MAX_AGE_MINUTES,
  DEFAULT_LEASE_INTEGER_MAX_DIGITS,
  DEFAULT_ORPHAN_MAX_AGE_SECONDS,
  DEFAULT_REVERT_ERROR_MAX_CHARS,
  DEFAULT_REVERT_FAILURE_MARKER_THRESHOLD,
  DEFAULT_WATCHDOG_COMMAND_DEADLINE_SECONDS,
  DEFAULT_WATCHDOG_KILL_GRACE_SECONDS,
  DEFAULT_WATCHDOG_POLL_INTERVAL_MS,
  DEFAULT_WATCHDOG_RUN_LIMIT_SECONDS,
  WATCHDOG_MAX_COMMANDS_PER_RUN,
  type WatchdogScriptOptions,
  buildWatchdogScript,
  revertFailedMarkerPath,
  watchdogStatePath,
} from '../../src/power/watchdog-script.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'watchdog');
const LEASE_MODULE = join(import.meta.dir, '..', '..', 'src', 'power', 'level2-lease.ts');
const EXPECTED_REVERT_ARGS = sudoArgv(DISABLESLEEP_OFF);
/** How long one run may take before `spawnSync` kills it: above every bound below. */
const SCRIPT_TIMEOUT_MS = 45_000;
/** A test runs the script up to six times. */
const TEST_TIMEOUT_MS = 120_000;
const FAILED_NOOP = 'revert failed expired (exit 0, flag Yes)';

/**
 * The upper bound of a run whose one hanging command has `deadlineSeconds`,
 * derived from the constants (see `WATCHDOG_MAX_COMMANDS_PER_RUN`): the
 * deadline and the grace, which are sleeping timers and so wall-clock time,
 * plus every other command of the run at one poll interval each, plus a
 * 10 s margin for starting those commands on a loaded machine (each took
 * about 35 ms at a load average of 13 to 15 on the owner's Mac mini, about
 * 1.1 s for all of them, so the margin is about nine times that).
 */
function runBoundMs(deadlineSeconds: number): number {
  return (
    (deadlineSeconds + DEFAULT_WATCHDOG_KILL_GRACE_SECONDS) * 1000 +
    WATCHDOG_MAX_COMMANDS_PER_RUN * DEFAULT_WATCHDOG_POLL_INTERVAL_MS +
    10_000
  );
}

type FlagState = 'Yes' | 'No' | 'removed' | 'twice' | 'hang' | 'stopparent';
type RevertMode = 'ok' | 'fail' | 'noop' | 'replace';
type LnMode = 'real' | 'kill-main' | 'fail';

const IOREG_FIXTURES: Record<'Yes' | 'No' | 'removed' | 'twice', string> = {
  Yes: 'ioreg-root-domain-mac-mini.sleep-disabled-yes.txt',
  No: 'ioreg-root-domain-mac-mini.txt',
  removed: 'ioreg-root-domain-mac-mini.sleep-disabled-removed.txt',
  twice: 'ioreg-root-domain-mac-mini.sleep-disabled-yes-twice.txt',
};

interface HarnessOptions {
  batt?: string;
  revert?: RevertMode;
  realIoreg?: boolean;
  remiHome?: string;
  /** A `date` stand-in that prints the epoch in `ROOT/now` (`setNow`) while that file exists. */
  fakeClock?: boolean;
  /** An `ln` stand-in whose behavior `setLn` switches. */
  lnStandIn?: boolean;
  script?: Omit<WatchdogScriptOptions, 'remiHome' | 'tools' | 'revertArgv'>;
}

interface Harness {
  root: string;
  remiHome: string;
  scriptPath: string;
  setFlag(state: FlagState): void;
  setRevert(mode: RevertMode): void;
  setNow(epoch: number): void;
  setLn(mode: LnMode): void;
  /** Each revert stand-in call, as its argument list. */
  revertCalls(): string[][];
  /** Calls the fake tools refused (anything other than the one read each allows). */
  unexpectedCalls(): string;
}

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

const roots: string[] = [];
const children: ChildProcess[] = [];

/** Kills a process a fake recorded, only when it is still the process the fake was. */
function killRecorded(pidFile: string, scriptPath: string): void {
  if (!existsSync(pidFile)) return;
  for (const text of readFileSync(pidFile, 'utf8').split('\n')) {
    const pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const command = spawnSync(PS_PATH, ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    }).stdout.trim();
    if (command === '/bin/sleep 30' || command === `/bin/sh ${scriptPath}`) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const root of roots.splice(0)) {
    killRecorded(join(root, 'pids'), join(root, 'watchdog.sh'));
    spawnSync('/bin/chmod', ['-R', 'u+rwx', root]);
    rmSync(root, { recursive: true, force: true });
  }
});

function quote(text: string): string {
  if (text.includes("'")) throw new Error(`test path contains a single quote: ${text}`);
  return `'${text}'`;
}

function writeExecutable(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'remi-watchdog-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const remiHome = options.remiHome ? join(root, options.remiHome) : join(root, 'remi-home');
  mkdirSync(remiHome, { recursive: true });
  const at = (name: string) => quote(join(root, name));
  writeFileSync(join(root, 'state'), 'No\n');
  writeFileSync(join(root, 'revert-mode'), `${options.revert ?? 'ok'}\n`);
  writeFileSync(join(root, 'ln-mode'), 'real\n');
  const lease = leasePath(remiHome);

  const ioregCases = Object.entries(IOREG_FIXTURES)
    .map(([name, file]) => `  ${name}) exec /bin/cat ${quote(join(FIXTURES, file))} ;;`)
    .join('\n');
  writeExecutable(
    join(bin, 'ioreg'),
    `#!/bin/sh
if [ "$*" != '-r -c IOPMrootDomain -d 1' ]; then
  printf 'ioreg %s\\n' "$*" >> ${at('unexpected')}
  exit 64
fi
state=$(/bin/cat ${at('state')})
case $state in
${ioregCases}
  hang) printf '%s\\n' "$$" >> ${at('pids')}; exec /bin/sleep 30 ;;
  stopparent)
    printf '%s\\n%s\\n' "$$" "$PPID" >> ${at('pids')}
    kill -STOP "$PPID"
    exec /bin/sleep 30 ;;
esac
exit 1
`,
  );
  writeExecutable(
    join(bin, 'pmset'),
    `#!/bin/sh
if [ "$*" != '-g batt' ]; then
  printf 'pmset %s\\n' "$*" >> ${at('unexpected')}
  exit 64
fi
exec /bin/cat ${quote(join(FIXTURES, options.batt ?? 'pmset-batt-mac-mini-ac.txt'))}
`,
  );
  writeExecutable(
    join(bin, 'date'),
    `#!/bin/sh
if [ -f ${at('now')} ]; then
  now=$(/bin/cat ${at('now')})
  case "$1" in
    +%s) printf '%s\\n' "$now"; exit 0 ;;
    -u) exec /bin/date -u -r "$now" "$2" ;;
  esac
fi
exec /bin/date "$@"
`,
  );
  writeExecutable(
    join(bin, 'ln'),
    `#!/bin/sh
mode=$(/bin/cat ${at('ln-mode')})
case $mode in
  kill-main)
    printf 'real\\n' > ${at('ln-mode')}
    main=$(/bin/ps -o ppid= -p "$PPID")
    kill -9 $main
    exit 1 ;;
  fail)
    printf 'real\\n' > ${at('ln-mode')}
    exit 1 ;;
esac
exec /bin/ln "$@"
`,
  );
  writeExecutable(
    join(bin, 'revert-stand-in'),
    `#!/bin/sh
{ printf 'call\\n'; for arg in "$@"; do printf '%s\\n' "$arg"; done; } >> ${at('revert-calls')}
mode=$(/bin/cat ${at('revert-mode')})
case $mode in
  ok) printf 'No\\n' > ${at('state')}; exit 0 ;;
  noop) exit 0 ;;
  fail) printf 'sudo: a password is required\\n' >&2; exit 1 ;;
  replace)
    /bin/cp ${at('newer-lease.json')} ${quote(`${lease}.newer`)}
    /bin/mv ${quote(`${lease}.newer`)} ${quote(lease)}
    printf 'No\\n' > ${at('state')}
    exit 0 ;;
esac
exit 2
`,
  );

  const scriptPath = join(root, 'watchdog.sh');
  writeFileSync(
    scriptPath,
    buildWatchdogScript({
      ...options.script,
      remiHome,
      tools: {
        ioreg: options.realIoreg ? IOREG_PATH : join(bin, 'ioreg'),
        pmset: join(bin, 'pmset'),
        plutil: PLUTIL_PATH,
        ps: PS_PATH,
        date: options.fakeClock ? join(bin, 'date') : DATE_PATH,
        ln: options.lnStandIn ? join(bin, 'ln') : '/bin/ln',
      },
      revertArgv: [join(bin, 'revert-stand-in'), ...EXPECTED_REVERT_ARGS],
    }),
  );

  const calls = join(root, 'revert-calls');
  const unexpected = join(root, 'unexpected');
  return {
    root,
    remiHome,
    scriptPath,
    setFlag: (flag) => writeFileSync(join(root, 'state'), `${flag}\n`),
    setRevert: (mode) => writeFileSync(join(root, 'revert-mode'), `${mode}\n`),
    setNow: (epoch) => writeFileSync(join(root, 'now'), `${epoch}\n`),
    setLn: (mode) => writeFileSync(join(root, 'ln-mode'), `${mode}\n`),
    revertCalls: () => {
      if (!existsSync(calls)) return [];
      return readFileSync(calls, 'utf8')
        .split('call\n')
        .slice(1)
        .map((chunk) => chunk.split('\n').slice(0, -1));
    },
    unexpectedCalls: () => (existsSync(unexpected) ? readFileSync(unexpected, 'utf8') : ''),
  };
}

/** Runs the script as launchd would: `/bin/sh SCRIPT` with no inherited environment. */
function runRaw(h: Harness, env: Record<string, string> = {}): Run {
  const started = Date.now();
  const result = spawnSync('/bin/sh', [h.scriptPath], {
    cwd: h.root,
    env,
    encoding: 'utf8',
    timeout: SCRIPT_TIMEOUT_MS,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    elapsedMs: Date.now() - started,
  };
}

/** Leftovers of a run next to the lease: work directories and claimed leases. */
function leftovers(h: Harness): string[] {
  const dir = dirname(leasePath(h.remiHome));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(
    (name) => name.startsWith('watchdog-run.') || name.includes('.watchdog-'),
  );
}

/**
 * Runs the script and checks what every run must do: exit 0, print nothing on
 * stderr, ask the fakes for nothing but their one read, and (unless the test
 * expects some) leave no work directory or claimed lease behind.
 */
function runScript(
  h: Harness,
  options: { env?: Record<string, string>; allowLeftovers?: boolean } = {},
): Run {
  const run = runRaw(h, options.env);
  expect(run.status).toBe(0);
  expect(run.stderr).toBe('');
  expect(h.unexpectedCalls()).toBe('');
  if (!options.allowLeftovers) expect(leftovers(h)).toEqual([]);
  return run;
}

function logLines(run: Run): string[] {
  return run.stdout.split('\n').filter((line) => line !== '');
}

/** The log reads exactly these lines, each after a UTC timestamp (or `unknown-time`). */
function expectLog(run: Run, entries: string[], stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /): void {
  const lines = logLines(run);
  expect(lines.map((line) => line.slice(line.indexOf(' ') + 1))).toEqual(entries);
  for (const line of lines) expect(line).toMatch(stamp);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function ownStartTime(): string {
  const start = processStartTime(process.pid);
  if (start === null) throw new Error('no start time for the test process');
  return start;
}

/** A lease that holds at `now`: written for the test process, with a fresh heartbeat. */
function freshLease(overrides: Partial<Level2Lease> = {}, now = nowSeconds()): Level2Lease {
  return {
    version: 1,
    hubPid: process.pid,
    hubStartTime: ownStartTime(),
    startedAt: now - 60,
    expiresAt: now + 3600,
    heartbeatAt: now - 5,
    staleSeconds: 120,
    revertBatteryPercent: 30,
    ...overrides,
  };
}

function writeRawLease(remiHome: string, text: string): void {
  mkdirSync(dirname(leasePath(remiHome)), { recursive: true, mode: 0o700 });
  writeFileSync(leasePath(remiHome), text, { mode: 0o600 });
}

async function exitedChildStart(): Promise<{ pid: number; start: string }> {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('sleep child has no pid');
  const start = processStartTime(pid);
  if (start === null) throw new Error('no start time for the sleep child');
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
  return { pid, start };
}

/** One revert ran with exactly the production arguments, logged `reason`, and removed the lease. */
function expectOneRevert(h: Harness, run: Run, reason: string): void {
  expect(h.revertCalls()).toEqual([EXPECTED_REVERT_ARGS]);
  expectLog(run, [`revert ${reason}`]);
  expect(readLease(h.remiHome)).toEqual({ kind: 'none' });
}

function expectNothing(h: Harness, run: Run): void {
  expect(h.revertCalls()).toEqual([]);
  expect(run.stdout).toBe('');
}

function readState(h: Harness): string {
  const file = watchdogStatePath(h.remiHome);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('the generated script takes every number as an option', () => {
  const numeric = [
    'commandDeadlineSeconds',
    'killGraceSeconds',
    'pollIntervalMs',
    'runLimitSeconds',
    'integerMaxDigits',
    'revertFailureMarkerThreshold',
    'failureLogIntervalSeconds',
    'revertErrorMaxChars',
    'orphanMaxAgeSeconds',
    'invalidLeaseMaxAgeMinutes',
  ] as const;

  test('a non-positive or fractional value is refused, with no maximum', () => {
    for (const name of numeric) {
      for (const value of [0, -1, 1.5]) {
        expect(() => buildWatchdogScript({ remiHome: '/private/tmp/h', [name]: value })).toThrow(
          name,
        );
      }
      expect(() =>
        buildWatchdogScript({ remiHome: '/private/tmp/h', [name]: 1_000_000 }),
      ).not.toThrow();
    }
    expect(() =>
      buildWatchdogScript({ remiHome: '/private/tmp/h', fallbackWorkParent: 'tmp' }),
    ).toThrow();
  });

  test('the defaults and given values are what the script carries', () => {
    const defaults = buildWatchdogScript({ remiHome: '/private/tmp/h' });
    for (const line of [
      `DEADLINE=${DEFAULT_WATCHDOG_COMMAND_DEADLINE_SECONDS}`,
      `GRACE=${DEFAULT_WATCHDOG_KILL_GRACE_SECONDS}`,
      `POLL=${DEFAULT_WATCHDOG_POLL_INTERVAL_MS / 1000}`,
      `DEADLINE_TICKS=${(DEFAULT_WATCHDOG_COMMAND_DEADLINE_SECONDS * 1000) / DEFAULT_WATCHDOG_POLL_INTERVAL_MS}`,
      `GRACE_TICKS=${(DEFAULT_WATCHDOG_KILL_GRACE_SECONDS * 1000) / DEFAULT_WATCHDOG_POLL_INTERVAL_MS}`,
      `RUN_LIMIT=${DEFAULT_WATCHDOG_RUN_LIMIT_SECONDS}`,
      `DIGITS=${DEFAULT_LEASE_INTEGER_MAX_DIGITS}`,
      `MARKER_THRESHOLD=${DEFAULT_REVERT_FAILURE_MARKER_THRESHOLD}`,
      `LOG_INTERVAL=${DEFAULT_FAILURE_LOG_INTERVAL_SECONDS}`,
      `ERROR_CHARS=${DEFAULT_REVERT_ERROR_MAX_CHARS}`,
      `ORPHAN_AGE='+${DEFAULT_ORPHAN_MAX_AGE_SECONDS}s'`,
      `INVALID_AGE='+${DEFAULT_INVALID_LEASE_MAX_AGE_MINUTES * 60}s'`,
      `FALLBACK_PARENT='${DEFAULT_FALLBACK_WORK_PARENT}'`,
    ]) {
      expect(defaults.split('\n')).toContain(line);
    }
    const given = buildWatchdogScript({
      remiHome: '/private/tmp/h',
      commandDeadlineSeconds: 7,
      killGraceSeconds: 2,
      pollIntervalMs: 100,
      runLimitSeconds: 33,
      orphanMaxAgeSeconds: 42,
      invalidLeaseMaxAgeMinutes: 3,
    }).split('\n');
    for (const line of [
      'DEADLINE=7',
      'GRACE=2',
      'POLL=0.1',
      'DEADLINE_TICKS=70',
      'GRACE_TICKS=20',
      'RUN_LIMIT=33',
      "ORPHAN_AGE='+42s'",
      "INVALID_AGE='+180s'",
    ]) {
      expect(given).toContain(line);
    }
  });
});

if (process.platform !== 'darwin') {
  test.skip('macOS-only: the watchdog script runs against plutil, ps and ioreg', () => {});
} else {
  describe('the watchdog with SleepDisabled clear', () => {
    test(
      'records nothing and keeps a fresh lease',
      () => {
        const h = makeHarness();
        h.setFlag('No');
        const lease = freshLease();
        writeLease(h.remiHome, lease);
        expectNothing(h, runScript(h));
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'deletes an expired lease and one whose hub is gone, recording nothing',
      async () => {
        const expired = makeHarness();
        expired.setFlag('No');
        writeLease(expired.remiHome, freshLease({ expiresAt: nowSeconds() - 2 }));
        expectNothing(expired, runScript(expired));
        expect(readLease(expired.remiHome)).toEqual({ kind: 'none' });

        const gone = makeHarness();
        gone.setFlag('No');
        const dead = await exitedChildStart();
        writeLease(gone.remiHome, freshLease({ hubPid: dead.pid, hubStartTime: dead.start }));
        expectNothing(gone, runScript(gone));
        expect(readLease(gone.remiHome)).toEqual({ kind: 'none' });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'keeps an invalid lease younger than invalidLeaseMaxAgeMinutes and deletes an older one',
      () => {
        const young = makeHarness();
        young.setFlag('No');
        writeRawLease(young.remiHome, '{"version": 2}');
        expectNothing(young, runScript(young));
        expect(existsSync(leasePath(young.remiHome))).toBe(true);

        const old = makeHarness();
        old.setFlag('No');
        writeRawLease(old.remiHome, '{"version": 2}');
        const sixMinutesAgo = new Date(Date.now() - 6 * 60_000);
        utimesSync(leasePath(old.remiHome), sixMinutesAgo, sixMinutesAgo);
        const run = runScript(old);
        expect(old.revertCalls()).toEqual([]);
        expectLog(run, ['deleted an invalid lease older than 5 min']);
        expect(existsSync(leasePath(old.remiHome))).toBe(false);

        // The option moves the gate: ten minutes keeps the six-minute-old lease.
        const longer = makeHarness({ script: { invalidLeaseMaxAgeMinutes: 10 } });
        longer.setFlag('No');
        writeRawLease(longer.remiHome, '{"version": 2}');
        utimesSync(leasePath(longer.remiHome), sixMinutesAgo, sixMinutesAgo);
        expectNothing(longer, runScript(longer));
        expect(existsSync(leasePath(longer.remiHome))).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'with the real ioreg (this Mac reads No) and a lease present, records nothing',
      () => {
        const h = makeHarness({ realIoreg: true });
        const lease = freshLease();
        writeLease(h.remiHome, lease);
        expectNothing(h, runScript(h));
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the watchdog with SleepDisabled set', () => {
    test(
      'with no lease, records nothing',
      () => {
        const h = makeHarness();
        h.setFlag('Yes');
        expectNothing(h, runScript(h));
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'with a fresh lease owned by this process on AC power, records nothing',
      () => {
        const h = makeHarness();
        h.setFlag('Yes');
        // expiresAt 5 s ahead: still fresh at whichever second the script reads.
        const lease = freshLease({ expiresAt: nowSeconds() + 5 });
        writeLease(h.remiHome, lease);
        expectNothing(h, runScript(h));
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      TEST_TIMEOUT_MS,
    );

    const leaseCases: Array<[string, string, (h: Harness) => void | Promise<void>]> = [
      [
        // now - 2, not now: the result must not depend on which second the
        // script reads; exact equality is pinned below with a fixed clock.
        'an expired lease',
        'expired',
        (h) => writeLease(h.remiHome, freshLease({ expiresAt: nowSeconds() - 2 })),
      ],
      [
        'a stale heartbeat',
        'heartbeat stale',
        (h) => writeLease(h.remiHome, freshLease({ heartbeatAt: nowSeconds() - 500 })),
      ],
      [
        'a heartbeat more than staleSeconds in the future',
        'heartbeat stale',
        (h) => writeLease(h.remiHome, freshLease({ heartbeatAt: nowSeconds() + 500 })),
      ],
      ['a malformed lease', 'lease invalid', (h) => writeRawLease(h.remiHome, '{"version": 1,')],
      [
        'a version 2 lease',
        'lease invalid',
        (h) => writeRawLease(h.remiHome, JSON.stringify({ ...freshLease(), version: 2 })),
      ],
      [
        'a lease missing hubPid',
        'lease invalid',
        (h) => {
          const { hubPid: _dropped, ...rest } = freshLease();
          writeRawLease(h.remiHome, JSON.stringify(rest));
        },
      ],
      [
        'a lease whose integer field is a float',
        'lease invalid',
        (h) => writeRawLease(h.remiHome, JSON.stringify({ ...freshLease(), staleSeconds: 1.5 })),
      ],
      [
        'a lease whose expiresAt is a string of digits',
        'lease invalid',
        (h) =>
          writeRawLease(
            h.remiHome,
            JSON.stringify({ ...freshLease(), expiresAt: String(nowSeconds() + 3600) }),
          ),
      ],
      [
        'a lease whose version is an array',
        'lease invalid',
        (h) => writeRawLease(h.remiHome, JSON.stringify({ ...freshLease(), version: [1] })),
      ],
      [
        'a lease with an extra key',
        'lease invalid',
        (h) => writeRawLease(h.remiHome, JSON.stringify({ ...freshLease(), extra: 1 })),
      ],
      [
        'a symlinked lease',
        'lease invalid',
        (h) => {
          const target = join(h.root, 'elsewhere.json');
          writeFileSync(target, JSON.stringify(freshLease()), { mode: 0o600 });
          mkdirSync(dirname(leasePath(h.remiHome)), { recursive: true, mode: 0o700 });
          symlinkSync(target, leasePath(h.remiHome));
        },
      ],
      [
        'a lease owned by a dead pid',
        'hub gone',
        async (h) => {
          const dead = await exitedChildStart();
          writeLease(h.remiHome, freshLease({ hubPid: dead.pid, hubStartTime: dead.start }));
        },
      ],
      [
        'a lease owned by a live pid whose start time differs (a reused pid)',
        'hub gone',
        (h) => writeLease(h.remiHome, freshLease({ hubStartTime: 'Thu Jan  1 00:00:00 1970' })),
      ],
    ];

    for (const [name, reason, make] of leaseCases) {
      test(
        `${name} reverts once (${reason}) and deletes the lease`,
        async () => {
          const h = makeHarness();
          h.setFlag('Yes');
          await make(h);
          expectOneRevert(h, runScript(h), reason);
        },
        TEST_TIMEOUT_MS,
      );
    }

    test(
      'the symlink target of a symlinked lease is left alone',
      () => {
        const h = makeHarness();
        h.setFlag('Yes');
        const target = join(h.root, 'elsewhere.json');
        writeFileSync(target, JSON.stringify(freshLease()), { mode: 0o600 });
        mkdirSync(dirname(leasePath(h.remiHome)), { recursive: true, mode: 0o700 });
        symlinkSync(target, leasePath(h.remiHome));
        expectOneRevert(h, runScript(h), 'lease invalid');
        expect(existsSync(target)).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    const batteryCases: Array<[string, string, number, string | null]> = [
      ['under revertBatteryPercent', 'pmset-batt-assumed-laptop-battery-25.txt', 30, 'battery'],
      ['at revertBatteryPercent', 'pmset-batt-assumed-laptop-battery-25.txt', 25, 'battery'],
      ['above revertBatteryPercent', 'pmset-batt-assumed-laptop-battery-62.txt', 30, null],
      [
        'with no percent token',
        'pmset-batt-assumed-laptop-battery-no-percent.txt',
        30,
        'battery unreadable',
      ],
      ['from an unknown source', 'pmset-batt-invented-ups-power.txt', 30, 'battery unreadable'],
      ['on AC power at any revertBatteryPercent', 'pmset-batt-mac-mini-ac.txt', 100, null],
    ];

    for (const [name, batt, revertBatteryPercent, reason] of batteryCases) {
      test(
        `a fresh lease, battery ${name}: ${reason ?? 'nothing recorded'}`,
        () => {
          const h = makeHarness({ batt });
          h.setFlag('Yes');
          const lease = freshLease({ revertBatteryPercent });
          writeLease(h.remiHome, lease);
          const run = runScript(h);
          if (reason === null) {
            expectNothing(h, run);
            expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
          } else {
            expectOneRevert(h, run, reason);
          }
        },
        TEST_TIMEOUT_MS,
      );
    }

    test(
      'a lease written under TZ=Asia/Tokyo and checked under TZ=America/Los_Angeles does not revert',
      async () => {
        const h = makeHarness();
        h.setFlag('Yes');
        const code = `
          const { processStartTime, writeLease } = await import(${JSON.stringify(LEASE_MODULE)});
          const now = Math.floor(Date.now() / 1000);
          writeLease(process.env.LEASE_HOME, {
            version: 1,
            hubPid: process.pid,
            hubStartTime: processStartTime(process.pid),
            startedAt: now,
            expiresAt: now + 3600,
            heartbeatAt: now,
            staleSeconds: 120,
            revertBatteryPercent: 30,
          });
          process.stdout.write('ready ' + new Date().getTimezoneOffset() + '\\n');
          setInterval(() => {}, 1000);
        `;
        const hub = spawn(process.execPath, ['-e', code], {
          env: { TZ: 'Asia/Tokyo', HOME: h.root, PATH: '/usr/bin:/bin', LEASE_HOME: h.remiHome },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        children.push(hub);
        const ready = await new Promise<string>((resolve, reject) => {
          let out = '';
          hub.stdout?.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8');
            if (out.includes('\n')) resolve(out.trim());
          });
          hub.once('exit', (code) => reject(new Error(`the hub exited early (${code})`)));
        });
        expect(ready).toBe('ready -540');
        const read = readLease(h.remiHome);
        if (read.kind !== 'valid') throw new Error(`lease not valid: ${JSON.stringify(read)}`);
        expect(read.lease.hubPid).toBe(hub.pid ?? -1);
        // Without the pinned UTC, ps under the watchdog's zone prints another time.
        const local = spawnSync(PS_PATH, ['-o', 'lstart=', '-p', String(hub.pid)], {
          env: { LC_ALL: 'C', TZ: 'America/Los_Angeles' },
          encoding: 'utf8',
        });
        expect(local.stdout.trim()).not.toBe(read.lease.hubStartTime);

        const run = runScript(h, { env: { TZ: 'America/Los_Angeles' } });
        expectNothing(h, run);
        expect(readLease(h.remiHome)).toEqual(read);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'a lease replaced between the read and the revert is not deleted',
      () => {
        const h = makeHarness({ revert: 'replace' });
        h.setFlag('Yes');
        writeLease(h.remiHome, freshLease({ expiresAt: nowSeconds() - 2 }));
        const newer = freshLease({ startedAt: nowSeconds() + 1 });
        writeFileSync(join(h.root, 'newer-lease.json'), JSON.stringify(newer), { mode: 0o600 });
        const run = runScript(h);
        expect(h.revertCalls()).toEqual([EXPECTED_REVERT_ARGS]);
        expectLog(run, ['revert expired']);
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease: newer });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'a remi home with shell and XML characters is quoted end to end',
      () => {
        const h = makeHarness({ remiHome: 'a&b<c"d $x `y` e' });
        h.setFlag('Yes');
        writeLease(h.remiHome, freshLease({ expiresAt: nowSeconds() - 2 }));
        expectOneRevert(h, runScript(h), 'expired');
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the boundaries, pinned with a fixed clock', () => {
    const NOW = 2_000_000;
    const cases: Array<[string, Partial<Level2Lease>, string | null]> = [
      ['a heartbeat exactly staleSeconds old', { heartbeatAt: NOW - 120 }, null],
      ['a heartbeat staleSeconds + 1 old', { heartbeatAt: NOW - 121 }, 'heartbeat stale'],
      ['a heartbeat exactly staleSeconds ahead', { heartbeatAt: NOW + 120 }, null],
      ['a heartbeat staleSeconds + 1 ahead', { heartbeatAt: NOW + 121 }, 'heartbeat stale'],
      ['expiresAt equal to now', { expiresAt: NOW }, 'expired'],
      ['expiresAt one second ahead', { expiresAt: NOW + 1 }, null],
    ];

    for (const [name, override, reason] of cases) {
      test(
        `${name}: ${reason ?? 'nothing recorded'}`,
        () => {
          const h = makeHarness({ fakeClock: true });
          h.setFlag('Yes');
          h.setNow(NOW);
          const lease = freshLease({ staleSeconds: 120, ...override }, NOW);
          writeLease(h.remiHome, lease);
          const run = runScript(h);
          if (reason === null) {
            expectNothing(h, run);
            expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
          } else {
            expectOneRevert(h, run, reason);
          }
        },
        TEST_TIMEOUT_MS,
      );
    }

    test(
      'integerMaxDigits: 4 turns a 5-digit heartbeatAt into lease invalid',
      () => {
        // pid 1 (launchd) is a one-digit live hub, so only heartbeatAt has 5 digits.
        const launchdStart = processStartTime(1);
        if (launchdStart === null) throw new Error('no start time for pid 1');
        const lease: Level2Lease = {
          version: 1,
          hubPid: 1,
          hubStartTime: launchdStart,
          startedAt: 900,
          expiresAt: 9999,
          heartbeatAt: 12_345,
          staleSeconds: 120,
          revertBatteryPercent: 30,
        };
        const byDefault = makeHarness({ fakeClock: true });
        byDefault.setFlag('Yes');
        byDefault.setNow(1000);
        writeLease(byDefault.remiHome, lease);
        expectOneRevert(byDefault, runScript(byDefault), 'heartbeat stale');

        const fourDigits = makeHarness({ fakeClock: true, script: { integerMaxDigits: 4 } });
        fourDigits.setFlag('Yes');
        fourDigits.setNow(1000);
        writeLease(fourDigits.remiHome, lease);
        expectOneRevert(fourDigits, runScript(fourDigits), 'lease invalid');
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the watchdog when the flag cannot be read', () => {
    for (const state of ['removed', 'twice'] as const) {
      test(
        `a root domain with the SleepDisabled line ${state}, with a lease present, reverts once`,
        () => {
          const h = makeHarness();
          h.setFlag(state);
          writeLease(h.remiHome, freshLease());
          expectOneRevert(h, runScript(h), 'flag unreadable');
        },
        TEST_TIMEOUT_MS,
      );
    }

    test(
      'at the default deadline, a hung ioreg is killed and the run ends within its derived bound',
      () => {
        const h = makeHarness();
        h.setFlag('hang');
        writeLease(h.remiHome, freshLease());
        const run = runScript(h);
        // The deadline is a sleeping timer, so the run cannot end before it.
        expect(run.elapsedMs).toBeGreaterThanOrEqual(9_000);
        expect(run.elapsedMs).toBeLessThan(runBoundMs(DEFAULT_WATCHDOG_COMMAND_DEADLINE_SECONDS));
        expectOneRevert(h, run, 'flag unreadable');
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'commandDeadlineSeconds: 1 kills an ioreg that would sleep 30 s, well before its sleep ends',
      () => {
        const h = makeHarness({ script: { commandDeadlineSeconds: 1 } });
        h.setFlag('hang');
        writeLease(h.remiHome, freshLease());
        const run = runScript(h);
        expect(run.elapsedMs).toBeLessThan(runBoundMs(1));
        expectOneRevert(h, run, 'flag unreadable');
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'a child that cannot be collected is abandoned at the deadline and the run ends',
      () => {
        // The fake stops its own parent, the wrapper that would report its
        // exit, so no status ever arrives; a blocking wait would hang here
        // until the run's own timeout.
        const h = makeHarness({ script: { commandDeadlineSeconds: 1 } });
        h.setFlag('stopparent');
        writeLease(h.remiHome, freshLease());
        const run = runScript(h);
        expect(run.elapsedMs).toBeLessThan(runBoundMs(1));
        expectOneRevert(h, run, 'flag unreadable');
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'runLimitSeconds: a run past its limit stops and counts as a failure',
      () => {
        // A 20 s deadline, so a run limit that did not work would show in the
        // time as well as in the log.
        const h = makeHarness({ script: { runLimitSeconds: 2, commandDeadlineSeconds: 20 } });
        h.setFlag('hang');
        writeLease(h.remiHome, freshLease());
        const run = runScript(h);
        expect(run.elapsedMs).toBeLessThan(runBoundMs(2));
        expect(runBoundMs(2)).toBeLessThan(20_000);
        expect(h.revertCalls()).toEqual([]);
        expectLog(run, ['run exceeded 2 s']);
        expect(readState(h)).toContain('failures=1\n');
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('a revert that does not clear the flag', () => {
    test(
      'keeps the lease, logs the status and stderr, throttles repeats, marks repeated failures and clears on success',
      () => {
        const T = 3_000_000;
        const h = makeHarness({ fakeClock: true, revert: 'noop' });
        h.setFlag('Yes');
        h.setNow(T);
        const lease = freshLease({ expiresAt: T - 10 }, T);
        writeLease(h.remiHome, lease);
        const marker = revertFailedMarkerPath(h.remiHome);

        // 1: exit 0 but the flag still reads Yes: logged, lease kept.
        expectLog(runScript(h), ['revert expired', FAILED_NOOP]);
        expect(h.revertCalls()).toHaveLength(1);
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
        expect(readState(h)).toContain('failures=1\n');
        expect(existsSync(marker)).toBe(false);

        // 2 and 3: the next runs retry; the identical line is not repeated.
        h.setNow(T + 60);
        expectLog(runScript(h), []);
        h.setNow(T + 120);
        expectLog(runScript(h), []);
        expect(h.revertCalls()).toHaveLength(3);
        expect(readState(h)).toContain('failures=3\n');
        expect(readFileSync(marker, 'utf8')).toBe(`${FAILED_NOOP}\n`);

        // 4: an hour after it was logged, the same line is logged again.
        h.setNow(T + 3601);
        expectLog(runScript(h), ['revert expired', FAILED_NOOP]);

        // 5: a different failure is logged at once, with its status and stderr.
        h.setRevert('fail');
        h.setNow(T + 3660);
        expectLog(runScript(h), [
          'revert expired',
          'revert failed expired (exit 1, flag Yes, stderr: sudo: a password is required)',
        ]);
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });

        // 6: a revert that works clears the count and the marker and deletes the lease.
        h.setRevert('ok');
        h.setNow(T + 3720);
        expectLog(runScript(h), ['revert expired']);
        expect(h.revertCalls()).toHaveLength(6);
        expect(existsSync(marker)).toBe(false);
        expect(readState(h)).toContain('failures=0\n');
        expect(readLease(h.remiHome)).toEqual({ kind: 'none' });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'revertFailureMarkerThreshold, failureLogIntervalSeconds and revertErrorMaxChars are honored',
      () => {
        const T = 3_000_000;
        const h = makeHarness({
          fakeClock: true,
          revert: 'fail',
          script: {
            revertFailureMarkerThreshold: 1,
            failureLogIntervalSeconds: 30,
            revertErrorMaxChars: 10,
          },
        });
        h.setFlag('Yes');
        h.setNow(T);
        writeLease(h.remiHome, freshLease({ expiresAt: T - 10 }, T));
        const failed = 'revert failed expired (exit 1, flag Yes, stderr: sudo: a pa)';
        expectLog(runScript(h), ['revert expired', failed]);
        expect(readFileSync(revertFailedMarkerPath(h.remiHome), 'utf8')).toBe(`${failed}\n`);
        h.setNow(T + 31);
        expectLog(runScript(h), ['revert expired', failed]);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('a lease left renamed aside', () => {
    test(
      'is restored when it is the only copy, and its claim is removed',
      () => {
        const h = makeHarness();
        h.setFlag('Yes');
        const lease = freshLease();
        writeLease(h.remiHome, lease);
        renameSync(leasePath(h.remiHome), `${leasePath(h.remiHome)}.watchdog-999`);
        expectNothing(h, runScript(h));
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'a run killed at the relink leaves a claim that the next run restores',
      () => {
        const h = makeHarness({ revert: 'replace', lnStandIn: true });
        h.setFlag('Yes');
        writeLease(h.remiHome, freshLease({ expiresAt: nowSeconds() - 2 }));
        const newer = freshLease({ startedAt: nowSeconds() + 1 });
        writeFileSync(join(h.root, 'newer-lease.json'), JSON.stringify(newer), { mode: 0o600 });
        h.setLn('kill-main');
        const killed = runRaw(h);
        expect(killed.signal).toBe('SIGKILL');
        expect(existsSync(leasePath(h.remiHome))).toBe(false);
        expect(leftovers(h).filter((name) => name.includes('.watchdog-'))).toHaveLength(1);

        h.setFlag('Yes');
        const run = runScript(h, { allowLeftovers: true });
        // No new revert: the restored lease is fresh.
        expect(h.revertCalls()).toHaveLength(1);
        expect(run.stdout).toBe('');
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease: newer });
        expect(leftovers(h).filter((name) => name.includes('.watchdog-'))).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'a failed relink keeps the claim, and the next run restores it',
      () => {
        const h = makeHarness({ revert: 'replace', lnStandIn: true });
        h.setFlag('Yes');
        writeLease(h.remiHome, freshLease({ expiresAt: nowSeconds() - 2 }));
        const newer = freshLease({ startedAt: nowSeconds() + 1 });
        writeFileSync(join(h.root, 'newer-lease.json'), JSON.stringify(newer), { mode: 0o600 });
        h.setLn('fail');
        const first = runScript(h, { allowLeftovers: true });
        expectLog(first, ['revert expired']);
        expect(existsSync(leasePath(h.remiHome))).toBe(false);
        expect(leftovers(h).filter((name) => name.includes('.watchdog-'))).toHaveLength(1);

        const second = runScript(h);
        expect(h.revertCalls()).toHaveLength(1);
        expect(second.stdout).toBe('');
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease: newer });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'work directories and claims older than orphanMaxAgeSeconds are removed, younger ones kept',
      () => {
        const h = makeHarness({ script: { orphanMaxAgeSeconds: 60 } });
        h.setFlag('No');
        const lease = freshLease();
        writeLease(h.remiHome, lease);
        const dir = dirname(leasePath(h.remiHome));
        const old = new Date(Date.now() - 120_000);
        for (const name of ['watchdog-run.oldone', 'watchdog-run.newone']) {
          mkdirSync(join(dir, name));
          writeFileSync(join(dir, name, 'out.1'), 'x');
        }
        writeFileSync(join(dir, 'lease.json.watchdog-111'), '{}');
        writeFileSync(join(dir, 'lease.json.watchdog-222'), '{}');
        utimesSync(join(dir, 'watchdog-run.oldone'), old, old);
        utimesSync(join(dir, 'lease.json.watchdog-111'), old, old);
        expectNothing(h, runScript(h, { allowLeftovers: true }));
        expect(leftovers(h).sort()).toEqual(['lease.json.watchdog-222', 'watchdog-run.newone']);
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('when the keep-awake directory cannot hold a work directory', () => {
    test(
      'the fallback directory is used, a healthy lease is left alone, and the fallback is emptied',
      () => {
        const fallback = mkdtempSync(join(tmpdir(), 'remi-watchdog-fallback-'));
        roots.push(fallback);
        const h = makeHarness({ script: { fallbackWorkParent: fallback } });
        h.setFlag('Yes');
        const lease = freshLease();
        writeLease(h.remiHome, lease);
        chmodSync(dirname(leasePath(h.remiHome)), 0o500);
        try {
          expectNothing(h, runScript(h));
          expect(readdirSync(fallback)).toEqual([]);
        } finally {
          chmodSync(dirname(leasePath(h.remiHome)), 0o700);
        }
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'with no work directory anywhere, it says so once, still reverts, and keeps the lease',
      () => {
        const blockedRoot = mkdtempSync(join(tmpdir(), 'remi-watchdog-blocked-'));
        roots.push(blockedRoot);
        const blocked = join(blockedRoot, 'blocked');
        mkdirSync(blocked, { mode: 0o500 });
        const nowhere = makeHarness({ script: { fallbackWorkParent: blocked } });
        nowhere.setFlag('Yes');
        const lease = freshLease();
        writeLease(nowhere.remiHome, lease);
        chmodSync(dirname(leasePath(nowhere.remiHome)), 0o500);
        try {
          const run = runScript(nowhere);
          expect(nowhere.revertCalls()).toEqual([EXPECTED_REVERT_ARGS]);
          expectLog(
            run,
            [
              'work directory unavailable',
              'revert flag unreadable (no work directory)',
              'revert failed flag unreadable (no work directory) (exit 0, flag unreadable)',
            ],
            /^unknown-time /,
          );
        } finally {
          chmodSync(dirname(leasePath(nowhere.remiHome)), 0o700);
        }
        expect(readLease(nowhere.remiHome)).toEqual({ kind: 'valid', lease });
      },
      TEST_TIMEOUT_MS,
    );
  });
}
