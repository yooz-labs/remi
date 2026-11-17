import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_LEASE_MAX_BYTES,
  DEFAULT_PROCESS_START_TIME_TIMEOUT_MS,
  DEFAULT_START_TIME_MAX_LENGTH,
  type Level2Lease,
  deleteLease,
  leaseOwnedBy,
  leasePath,
  processStartTime,
  readLease,
  writeLease,
} from '../../src/power/level2-lease.ts';

const homes: string[] = [];

function tempRemiHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'remi-lease-'));
  homes.push(root);
  return join(root, 'remi-home');
}

afterEach(() => {
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sampleLease(overrides: Partial<Level2Lease> = {}): Level2Lease {
  return {
    version: 1,
    hubPid: 4242,
    hubStartTime: 'Tue Nov 17 14:09:43 2026',
    startedAt: 1_794_900_000,
    expiresAt: 1_794_910_800,
    heartbeatAt: 1_794_900_030,
    staleSeconds: 120,
    revertBatteryPercent: 30,
    ...overrides,
  };
}

/** Writes `text` where the lease lives, with the modes the writer uses. */
function writeRawLease(remiHome: string, text: string): void {
  mkdirSync(dirname(leasePath(remiHome)), { recursive: true, mode: 0o700 });
  writeFileSync(leasePath(remiHome), text, { mode: 0o600 });
}

function sampleRecord(): Record<string, unknown> {
  return { ...sampleLease() };
}

describe('writing and reading the lease', () => {
  test('a written lease reads back valid with equal fields', () => {
    const remiHome = tempRemiHome();
    const lease = sampleLease();
    writeLease(remiHome, lease);
    expect(readLease(remiHome)).toEqual({ kind: 'valid', lease });
    expect(leasePath(remiHome)).toBe(join(remiHome, 'keep-awake', 'lease.json'));
  });

  test('the file is mode 0600 and its directory 0700', () => {
    const remiHome = tempRemiHome();
    writeLease(remiHome, sampleLease());
    expect(statSync(leasePath(remiHome)).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(leasePath(remiHome))).mode & 0o777).toBe(0o700);
    // Only the lease is left; the temporary file was renamed into place.
    expect(readdirSync(dirname(leasePath(remiHome)))).toEqual(['lease.json']);
  });

  test('no file reads as none, and deleting twice is not an error', () => {
    const remiHome = tempRemiHome();
    expect(readLease(remiHome)).toEqual({ kind: 'none' });
    writeLease(remiHome, sampleLease());
    deleteLease(remiHome);
    expect(readLease(remiHome)).toEqual({ kind: 'none' });
    deleteLease(remiHome);
    expect(readLease(remiHome)).toEqual({ kind: 'none' });
  });

  test('the writer refuses a lease the reader would call invalid, with the reason, and writes nothing', () => {
    const remiHome = tempRemiHome();
    const cases: Array<[Level2Lease, string]> = [
      [sampleLease({ hubPid: 0 }), 'hubPid is below 1'],
      [sampleLease({ expiresAt: 1.5 }), 'expiresAt is not an integer'],
      [sampleLease({ hubStartTime: ' padded ' }), 'hubStartTime is not a trimmed one-line string'],
      [sampleLease({ revertBatteryPercent: 101 }), 'revertBatteryPercent is above 100'],
      [{ ...sampleLease(), version: 2 } as unknown as Level2Lease, 'version is not 1'],
    ];
    for (const [bad, reason] of cases) {
      expect(() => writeLease(remiHome, bad)).toThrow(
        `refusing to write an invalid lease: ${reason}`,
      );
    }
    expect(readLease(remiHome)).toEqual({ kind: 'none' });
    expect(() => writeLease('relative/home', sampleLease())).toThrow();
  });
});

describe('out-of-range lease values read as invalid with their exact reason', () => {
  const tooLong = 'T'.repeat(65);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['hubPid 0', { hubPid: 0 }, 'hubPid is below 1'],
    ['staleSeconds 0', { staleSeconds: 0 }, 'staleSeconds is below 1'],
    ['a negative expiresAt', { expiresAt: -1 }, 'expiresAt is below 0'],
    [
      'revertBatteryPercent 101',
      { revertBatteryPercent: 101 },
      'revertBatteryPercent is above 100',
    ],
    [
      'an empty hubStartTime',
      { hubStartTime: '' },
      'hubStartTime is not a trimmed one-line string',
    ],
    [
      'a padded hubStartTime',
      { hubStartTime: ' Tue Nov 17 14:09:43 2026' },
      'hubStartTime is not a trimmed one-line string',
    ],
    [
      'a 65-character hubStartTime',
      { hubStartTime: tooLong },
      'hubStartTime is not a trimmed one-line string',
    ],
    [
      'a hubStartTime with a newline',
      { hubStartTime: 'Tue Nov 17\n14:09:43 2026' },
      'hubStartTime is not a trimmed one-line string',
    ],
    [
      'a hubStartTime with a control character',
      { hubStartTime: 'Tue Nov 17\u000714:09:43 2026' },
      'hubStartTime is not a trimmed one-line string',
    ],
    [
      'a numeric hubStartTime',
      { hubStartTime: 1_794_900_000 },
      'hubStartTime is not a trimmed one-line string',
    ],
  ];

  for (const [name, override, reason] of cases) {
    test(name, () => {
      const remiHome = tempRemiHome();
      writeRawLease(remiHome, JSON.stringify({ ...sampleRecord(), ...override }));
      expect(readLease(remiHome)).toEqual({ kind: 'invalid', reason });
    });
  }

  test('a 64-character hubStartTime is still valid', () => {
    const remiHome = tempRemiHome();
    writeRawLease(remiHome, JSON.stringify({ ...sampleRecord(), hubStartTime: 'T'.repeat(64) }));
    expect(readLease(remiHome).kind).toBe('valid');
  });
});

describe('every number of the lease module is an option', () => {
  test('maxBytes: a lease larger than 100 bytes is invalid, while the default accepts it', () => {
    const remiHome = tempRemiHome();
    writeLease(remiHome, sampleLease());
    expect(statSync(leasePath(remiHome)).size).toBeGreaterThan(100);
    expect(readLease(remiHome).kind).toBe('valid');
    expect(readLease(remiHome, undefined, { maxBytes: 100 })).toEqual({
      kind: 'invalid',
      reason: 'the lease is larger than 100 bytes',
    });
    expect(DEFAULT_LEASE_MAX_BYTES).toBe(4096);
  });

  test('startTimeMaxLength: a start time longer than 10 characters is invalid', () => {
    const remiHome = tempRemiHome();
    writeLease(remiHome, sampleLease());
    expect(readLease(remiHome, undefined, { startTimeMaxLength: 10 })).toEqual({
      kind: 'invalid',
      reason: 'hubStartTime is not a trimmed one-line string',
    });
    expect(() => writeLease(tempRemiHome(), sampleLease(), { startTimeMaxLength: 10 })).toThrow();
    expect(DEFAULT_START_TIME_MAX_LENGTH).toBe(64);
  });

  test('a non-positive or fractional option is refused', () => {
    const remiHome = tempRemiHome();
    for (const value of [0, -1, 1.5]) {
      expect(() => readLease(remiHome, undefined, { maxBytes: value })).toThrow();
      expect(() => readLease(remiHome, undefined, { startTimeMaxLength: value })).toThrow();
      expect(() => processStartTime(process.pid, { timeoutMs: value })).toThrow();
    }
    expect(DEFAULT_PROCESS_START_TIME_TIMEOUT_MS).toBe(2000);
  });
});

describe('an invalid lease', () => {
  const cases: Array<[string, (remiHome: string) => void, string]> = [
    [
      'an extra key',
      (h) => writeRawLease(h, JSON.stringify({ ...sampleRecord(), extra: 1 })),
      'unexpected key "extra"',
    ],
    [
      'a missing key',
      (h) => {
        const { hubPid: _dropped, ...record } = sampleRecord();
        writeRawLease(h, JSON.stringify(record));
      },
      'missing key hubPid',
    ],
    [
      'a wrong type',
      (h) => writeRawLease(h, JSON.stringify({ ...sampleRecord(), hubPid: '4242' })),
      'hubPid is not an integer',
    ],
    [
      'a non-integer',
      (h) => writeRawLease(h, JSON.stringify({ ...sampleRecord(), expiresAt: 1_794_910_800.5 })),
      'expiresAt is not an integer',
    ],
    [
      'version 2',
      (h) => writeRawLease(h, JSON.stringify({ ...sampleRecord(), version: 2 })),
      'version is not 1',
    ],
    ['unparsable JSON', (h) => writeRawLease(h, '{"version": 1,'), 'the lease is not valid JSON'],
    ['a JSON array', (h) => writeRawLease(h, '[]'), 'not a JSON object'],
    [
      'a file larger than 4 KiB',
      (h) =>
        writeRawLease(h, `${JSON.stringify(sampleRecord())}${' '.repeat(DEFAULT_LEASE_MAX_BYTES)}`),
      'the lease is larger than 4096 bytes',
    ],
    [
      'a symlink',
      (h) => {
        const target = join(dirname(h), 'elsewhere.json');
        writeFileSync(target, JSON.stringify(sampleRecord()), { mode: 0o600 });
        mkdirSync(dirname(leasePath(h)), { recursive: true, mode: 0o700 });
        symlinkSync(target, leasePath(h));
      },
      'the lease is a symlink',
    ],
    [
      'a directory',
      (h) => mkdirSync(leasePath(h), { recursive: true, mode: 0o700 }),
      'the lease is not a regular file',
    ],
  ];

  for (const [name, make, reason] of cases) {
    test(`${name} reads as invalid`, () => {
      const remiHome = tempRemiHome();
      make(remiHome);
      expect(readLease(remiHome)).toEqual({ kind: 'invalid', reason });
    });
  }

  test('a file not owned by the expected user reads as invalid', () => {
    // Making a file another user owns needs root, so the reader is asked to
    // expect another uid instead; the same file reads valid for its owner.
    const remiHome = tempRemiHome();
    writeLease(remiHome, sampleLease());
    const uid = process.getuid?.() ?? -1;
    expect(readLease(remiHome, uid).kind).toBe('valid');
    expect(readLease(remiHome, uid + 1)).toEqual({
      kind: 'invalid',
      reason: 'the lease is not owned by the current user',
    });
  });

  test('a lease at exactly 4 KiB is still read', () => {
    const remiHome = tempRemiHome();
    const json = JSON.stringify(sampleRecord());
    writeRawLease(remiHome, `${json}${' '.repeat(DEFAULT_LEASE_MAX_BYTES - json.length)}`);
    expect(statSync(leasePath(remiHome)).size).toBe(DEFAULT_LEASE_MAX_BYTES);
    expect(readLease(remiHome).kind).toBe('valid');
  });
});

describe('a crash between the temporary write and the rename', () => {
  // The writer's temporary file sits next to the lease; writing only that
  // file is what a crash before the rename leaves behind.
  function writeTemporaryOnly(remiHome: string, lease: Level2Lease): void {
    mkdirSync(dirname(leasePath(remiHome)), { recursive: true, mode: 0o700 });
    writeFileSync(`${leasePath(remiHome)}.0b7e5c1a-crash.tmp`, JSON.stringify(lease), {
      mode: 0o600,
    });
  }

  test('with no previous lease, it reads as none', () => {
    const remiHome = tempRemiHome();
    writeTemporaryOnly(remiHome, sampleLease());
    expect(readLease(remiHome)).toEqual({ kind: 'none' });
  });

  test('with a previous lease, it reads as the previous lease', () => {
    const remiHome = tempRemiHome();
    const previous = sampleLease();
    writeLease(remiHome, previous);
    writeTemporaryOnly(remiHome, sampleLease({ heartbeatAt: previous.heartbeatAt + 30 }));
    expect(readLease(remiHome)).toEqual({ kind: 'valid', lease: previous });
  });
});

describe('lease ownership', () => {
  test('leaseOwnedBy needs the same pid and start time', () => {
    const lease = sampleLease();
    expect(leaseOwnedBy(lease, lease.hubPid, lease.hubStartTime)).toBe(true);
    expect(leaseOwnedBy(lease, lease.hubPid + 1, lease.hubStartTime)).toBe(false);
    expect(leaseOwnedBy(lease, lease.hubPid, 'Wed Nov 18 00:00:00 2026')).toBe(false);
    expect(leaseOwnedBy(lease, lease.hubPid, null)).toBe(false);
  });

  test('processStartTime refuses a pid that is not a positive integer', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(processStartTime(pid)).toBeNull();
  });
});

if (process.platform !== 'darwin') {
  test.skip('macOS-only: processStartTime against real processes', () => {});
} else {
  describe('processStartTime against real processes', () => {
    test('the current process has a start time, stable across two calls', () => {
      const first = processStartTime(process.pid);
      expect(first).not.toBeNull();
      expect(first).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
      expect(processStartTime(process.pid)).toBe(first);
    });

    test("a reaped child's pid has none", async () => {
      const child = spawn('/usr/bin/true', [], { stdio: 'ignore' });
      const pid = child.pid;
      expect(pid).toBeDefined();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(processStartTime(pid ?? 0)).toBeNull();
    });

    test('timeoutMs: a 1 ms deadline is shorter than any ps run, so the answer is null', () => {
      expect(processStartTime(process.pid)).not.toBeNull();
      expect(processStartTime(process.pid, { timeoutMs: 1 })).toBeNull();
    });
  });
}
