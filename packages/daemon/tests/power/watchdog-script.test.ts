/**
 * Runs the generated watchdog script for real (issue #1773, ADR 0050 slice 3):
 * `/bin/sh` with an empty environment, a temporary remi home, the real
 * `plutil`, `ps` and `date`, fake `ioreg` and `pmset` executables that print
 * captured output from `fixtures/watchdog/` (one test uses the real `ioreg`),
 * and, in place of `sudo`, a stand-in that records its arguments and writes
 * the new flag into the state file the fake `ioreg` reads. That stand-in sits
 * exactly at the root boundary: the decision logic under test is the
 * production script text, generated with the test's tool paths.
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
  rmSync,
  symlinkSync,
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
import { buildWatchdogScript } from '../../src/power/watchdog-script.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'watchdog');
const LEASE_MODULE = join(import.meta.dir, '..', '..', 'src', 'power', 'level2-lease.ts');
const EXPECTED_REVERT_ARGS = sudoArgv(DISABLESLEEP_OFF);
const SCRIPT_TIMEOUT_MS = 20_000;

type FlagState = 'Yes' | 'No' | 'removed' | 'twice' | 'hang';
type RevertKind = 'ok' | 'fail' | 'replace';

const IOREG_FIXTURES: Record<Exclude<FlagState, 'hang'>, string> = {
  Yes: 'ioreg-root-domain-mac-mini.sleep-disabled-yes.txt',
  No: 'ioreg-root-domain-mac-mini.txt',
  removed: 'ioreg-root-domain-mac-mini.sleep-disabled-removed.txt',
  twice: 'ioreg-root-domain-mac-mini.sleep-disabled-yes-twice.txt',
};

interface Harness {
  root: string;
  remiHome: string;
  scriptPath: string;
  setFlag(state: FlagState): void;
  /** Each revert stand-in call, as its argument list. */
  revertCalls(): string[][];
  /** Calls the fake tools refused (anything other than the one read each allows). */
  unexpectedCalls(): string;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function quote(text: string): string {
  if (text.includes("'")) throw new Error(`test path contains a single quote: ${text}`);
  return `'${text}'`;
}

function writeExecutable(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

function makeHarness(
  options: { batt?: string; revert?: RevertKind; realIoreg?: boolean; remiHome?: string } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), 'remi-watchdog-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const remiHome = options.remiHome ? join(root, options.remiHome) : join(root, 'remi-home');
  mkdirSync(remiHome, { recursive: true });
  const state = join(root, 'state');
  const calls = join(root, 'revert-calls');
  const unexpected = join(root, 'unexpected');
  writeFileSync(state, 'No\n');

  const ioregCases = Object.entries(IOREG_FIXTURES)
    .map(([name, file]) => `  ${name}) exec /bin/cat ${quote(join(FIXTURES, file))} ;;`)
    .join('\n');
  writeExecutable(
    join(bin, 'ioreg'),
    `#!/bin/sh
if [ "$*" != '-r -c IOPMrootDomain -d 1' ]; then
  printf 'ioreg %s\\n' "$*" >> ${quote(unexpected)}
  exit 64
fi
state=$(/bin/cat ${quote(state)})
case $state in
${ioregCases}
  hang) exec /bin/sleep 30 ;;
esac
exit 1
`,
  );
  writeExecutable(
    join(bin, 'pmset'),
    `#!/bin/sh
if [ "$*" != '-g batt' ]; then
  printf 'pmset %s\\n' "$*" >> ${quote(unexpected)}
  exit 64
fi
exec /bin/cat ${quote(join(FIXTURES, options.batt ?? 'pmset-batt-mac-mini-ac.txt'))}
`,
  );
  const record = `{ printf 'call\\n'; for arg in "$@"; do printf '%s\\n' "$arg"; done; } >> ${quote(calls)}`;
  const lease = leasePath(remiHome);
  const revertBody = {
    ok: `${record}\nprintf 'No\\n' > ${quote(state)}\nexit 0`,
    fail: `${record}\nexit 1`,
    replace: `${record}\n/bin/cp ${quote(join(root, 'newer-lease.json'))} ${quote(`${lease}.newer`)}\n/bin/mv ${quote(`${lease}.newer`)} ${quote(lease)}\nprintf 'No\\n' > ${quote(state)}\nexit 0`,
  }[options.revert ?? 'ok'];
  const revert = join(bin, 'revert-stand-in');
  writeExecutable(revert, `#!/bin/sh\n${revertBody}\n`);

  const scriptPath = join(root, 'watchdog.sh');
  writeFileSync(
    scriptPath,
    buildWatchdogScript({
      remiHome,
      tools: {
        ioreg: options.realIoreg ? IOREG_PATH : join(bin, 'ioreg'),
        pmset: join(bin, 'pmset'),
        plutil: PLUTIL_PATH,
        ps: PS_PATH,
        date: DATE_PATH,
      },
      revertArgv: [revert, ...EXPECTED_REVERT_ARGS],
    }),
  );

  return {
    root,
    remiHome,
    scriptPath,
    setFlag: (flag) => writeFileSync(state, `${flag}\n`),
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
function runScript(h: Harness, env: Record<string, string> = {}): Run {
  const started = Date.now();
  const result = spawnSync('/bin/sh', [h.scriptPath], {
    cwd: h.root,
    env,
    encoding: 'utf8',
    timeout: SCRIPT_TIMEOUT_MS,
  });
  const run = {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    elapsedMs: Date.now() - started,
  };
  // Every run exits 0, prints nothing on stderr, asks the fakes for nothing
  // but their one read, and leaves no work directory or claimed lease behind.
  expect(run.status).toBe(0);
  expect(run.stderr).toBe('');
  expect(h.unexpectedCalls()).toBe('');
  const dir = dirname(leasePath(h.remiHome));
  const leftovers = existsSync(dir)
    ? readdirSync(dir).filter(
        (name) => name.startsWith('watchdog-run.') || name.includes('.watchdog-'),
      )
    : [];
  expect(leftovers).toEqual([]);
  return run;
}

function logLines(run: Run): string[] {
  return run.stdout.split('\n').filter((line) => line !== '');
}

/** The log reads exactly one revert line per reason, each with a UTC timestamp. */
function expectLog(run: Run, entries: string[]): void {
  const lines = logLines(run);
  expect(lines).toHaveLength(entries.length);
  lines.forEach((line, index) => {
    expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /);
    expect(line.slice(line.indexOf(' ') + 1)).toBe(entries[index] ?? '');
  });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A lease that holds: written for the test process, with a fresh heartbeat. */
function freshLease(overrides: Partial<Level2Lease> = {}): Level2Lease {
  const start = processStartTime(process.pid);
  if (start === null) throw new Error('no start time for the test process');
  const now = nowSeconds();
  return {
    version: 1,
    hubPid: process.pid,
    hubStartTime: start,
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
        const run = runScript(h);
        expectNothing(h, run);
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      SCRIPT_TIMEOUT_MS,
    );

    test(
      'deletes an expired lease and one whose hub is gone, recording nothing',
      async () => {
        const expired = makeHarness();
        expired.setFlag('No');
        writeLease(expired.remiHome, freshLease({ expiresAt: nowSeconds() - 1 }));
        expectNothing(expired, runScript(expired));
        expect(readLease(expired.remiHome)).toEqual({ kind: 'none' });

        const gone = makeHarness();
        gone.setFlag('No');
        const dead = await exitedChildStart();
        writeLease(gone.remiHome, freshLease({ hubPid: dead.pid, hubStartTime: dead.start }));
        expectNothing(gone, runScript(gone));
        expect(readLease(gone.remiHome)).toEqual({ kind: 'none' });
      },
      SCRIPT_TIMEOUT_MS,
    );

    test(
      'leaves an invalid lease in place and records nothing',
      () => {
        const h = makeHarness();
        h.setFlag('No');
        writeRawLease(h.remiHome, '{"version": 2}');
        expectNothing(h, runScript(h));
        expect(existsSync(leasePath(h.remiHome))).toBe(true);
      },
      SCRIPT_TIMEOUT_MS,
    );

    test(
      'with the real ioreg (this Mac reads No) and a lease present, records nothing',
      () => {
        const h = makeHarness({ realIoreg: true });
        const lease = freshLease();
        writeLease(h.remiHome, lease);
        const run = runScript(h);
        expectNothing(h, run);
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      SCRIPT_TIMEOUT_MS,
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
      SCRIPT_TIMEOUT_MS,
    );

    test(
      'with a fresh lease owned by this process on AC power, records nothing',
      () => {
        const h = makeHarness();
        h.setFlag('Yes');
        const lease = freshLease();
        writeLease(h.remiHome, lease);
        expectNothing(h, runScript(h));
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      SCRIPT_TIMEOUT_MS,
    );

    const leaseCases: Array<[string, string, (h: Harness) => void | Promise<void>]> = [
      [
        'an expired lease',
        'expired',
        (h) => writeLease(h.remiHome, freshLease({ expiresAt: nowSeconds() })),
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
        SCRIPT_TIMEOUT_MS,
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
      SCRIPT_TIMEOUT_MS,
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
        SCRIPT_TIMEOUT_MS,
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

        const run = runScript(h, { TZ: 'America/Los_Angeles' });
        expectNothing(h, run);
        expect(readLease(h.remiHome)).toEqual(read);
      },
      SCRIPT_TIMEOUT_MS,
    );

    test(
      'a lease replaced between the read and the revert is not deleted',
      () => {
        const h = makeHarness({ revert: 'replace' });
        h.setFlag('Yes');
        writeLease(h.remiHome, freshLease({ expiresAt: nowSeconds() - 1 }));
        const newer = freshLease({ startedAt: nowSeconds() + 1 });
        writeFileSync(join(h.root, 'newer-lease.json'), JSON.stringify(newer), { mode: 0o600 });
        const run = runScript(h);
        expect(h.revertCalls()).toEqual([EXPECTED_REVERT_ARGS]);
        expectLog(run, ['revert expired']);
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease: newer });
      },
      SCRIPT_TIMEOUT_MS,
    );

    test(
      'a remi home with shell and XML characters is quoted end to end',
      () => {
        const h = makeHarness({ remiHome: 'a&b<c"d $x `y` e' });
        h.setFlag('Yes');
        writeLease(h.remiHome, freshLease({ expiresAt: nowSeconds() - 1 }));
        expectOneRevert(h, runScript(h), 'expired');
      },
      SCRIPT_TIMEOUT_MS,
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
        SCRIPT_TIMEOUT_MS,
      );
    }

    test(
      'a hung ioreg is killed at the deadline and the run ends within 15 s',
      () => {
        const h = makeHarness();
        h.setFlag('hang');
        writeLease(h.remiHome, freshLease());
        const run = runScript(h);
        expect(run.elapsedMs).toBeLessThan(15_000);
        expect(run.elapsedMs).toBeGreaterThanOrEqual(9_000);
        expectOneRevert(h, run, 'flag unreadable');
      },
      SCRIPT_TIMEOUT_MS,
    );
  });

  describe('a revert that fails', () => {
    test(
      'keeps the lease and logs revert failed',
      () => {
        const h = makeHarness({ revert: 'fail' });
        h.setFlag('Yes');
        const lease = freshLease({ expiresAt: nowSeconds() - 1 });
        writeLease(h.remiHome, lease);
        const run = runScript(h);
        expect(h.revertCalls()).toEqual([EXPECTED_REVERT_ARGS]);
        expectLog(run, ['revert expired', 'revert failed expired']);
        expect(readLease(h.remiHome)).toEqual({ kind: 'valid', lease });
      },
      SCRIPT_TIMEOUT_MS,
    );
  });
}
