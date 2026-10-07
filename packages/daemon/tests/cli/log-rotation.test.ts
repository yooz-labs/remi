import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LOG_GUARD_INTERVAL_MS,
  LOG_KEEP,
  LOG_MAX_BYTES,
  STALE_ROTATION_LOCK_MS,
  appendBounded,
  fdAppends,
  guardLogFiles,
  planStdioLogGuard,
  rotateIfNeeded,
} from '../../src/cli/log-rotation.ts';

describe('rotateIfNeeded', () => {
  let sandbox: string;
  let target: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-log-rotation-'));
    target = path.join(sandbox, 'remi.log');
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('exports the documented defaults', () => {
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(LOG_KEEP).toBe(2);
  });

  test('nonexistent path returns false and does nothing', () => {
    expect(rotateIfNeeded(target)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.1`)).toBe(false);
  });

  test('file under the threshold is left untouched', () => {
    fs.writeFileSync(target, 'small content');
    expect(rotateIfNeeded(target, { maxBytes: 1024 })).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('small content');
    expect(fs.existsSync(`${target}.1`)).toBe(false);
  });

  // #729: copy, then truncate in place. The live file keeps its inode, so a
  // process that holds it open (the hub's stdout, launchd's descriptor, a
  // sibling daemon's) keeps writing to the live file, never to a backup.
  test('oversized file is copied to .1 and the live file is emptied in place', () => {
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    const inode = fs.statSync(target).ino;
    const result = rotateIfNeeded(target, { maxBytes: 1024 });
    expect(result).toBe(true);
    expect(fs.statSync(target).ino).toBe(inode);
    expect(fs.statSync(target).size).toBe(0);
    expect(fs.readFileSync(`${target}.1`).length).toBe(2048);
  });

  test('a writer that holds the file open keeps writing to the live file after a rotation (#729)', () => {
    const fd = fs.openSync(target, 'a');
    try {
      fs.writeSync(fd, Buffer.alloc(2048, 'a'));
      expect(rotateIfNeeded(target, { maxBytes: 1024 })).toBe(true);
      fs.writeSync(fd, 'after\n');
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readFileSync(target, 'utf-8')).toBe('after\n');
    expect(fs.readFileSync(`${target}.1`).length).toBe(2048);
  });

  test('existing .1 and .2 shift, oldest is dropped', () => {
    fs.writeFileSync(target, 'current');
    fs.writeFileSync(`${target}.1`, 'backup-1');
    fs.writeFileSync(`${target}.2`, 'backup-2-oldest');

    const result = rotateIfNeeded(target, { maxBytes: 1 });
    expect(result).toBe(true);

    expect(fs.readFileSync(target, 'utf-8')).toBe('');
    expect(fs.readFileSync(`${target}.1`, 'utf-8')).toBe('current');
    expect(fs.readFileSync(`${target}.2`, 'utf-8')).toBe('backup-1');
    // The old backup-2 content ("backup-2-oldest") must be gone entirely.
    expect(fs.existsSync(`${target}.3`)).toBe(false);
  });

  test('respects a custom keep count', () => {
    fs.writeFileSync(target, 'current');
    fs.writeFileSync(`${target}.1`, 'backup-1');

    const result = rotateIfNeeded(target, { maxBytes: 1, keep: 1 });
    expect(result).toBe(true);

    // With keep=1, the old .1 is dropped entirely and current becomes the new .1.
    expect(fs.readFileSync(target, 'utf-8')).toBe('');
    expect(fs.readFileSync(`${target}.1`, 'utf-8')).toBe('current');
    expect(fs.existsSync(`${target}.2`)).toBe(false);
  });

  test('rotates a file exactly at the threshold (boundary is inclusive)', () => {
    fs.writeFileSync(target, Buffer.alloc(1024));
    const result = rotateIfNeeded(target, { maxBytes: 1024 });
    expect(result).toBe(true);
    expect(fs.statSync(target).size).toBe(0);
    expect(fs.existsSync(`${target}.1`)).toBe(true);
  });

  test('a rotation that cannot write in the directory is swallowed and truncates nothing', () => {
    if (process.getuid?.() === 0) {
      // Root bypasses directory write-permission checks; nothing to assert.
      return;
    }
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    fs.chmodSync(sandbox, 0o555); // read/execute only: no lock, no copy
    try {
      const result = rotateIfNeeded(target, { maxBytes: 1024 });
      expect(result).toBe(false);
      expect(fs.statSync(target).size).toBe(2048);
      expect(fs.existsSync(`${target}.1`)).toBe(false);
    } finally {
      fs.chmodSync(sandbox, 0o755); // restore so afterEach's rmSync can clean up
    }
  });

  // #1262 review: the backups shift only after the copy succeeded, so a copy
  // that keeps failing (unreadable file, full disk) costs nothing.
  test('a failed copy keeps every backup and the live file', () => {
    if (process.getuid?.() === 0) return; // root reads a mode-000 file
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    fs.writeFileSync(`${target}.1`, 'GOOD-1');
    fs.writeFileSync(`${target}.2`, 'GOOD-2');
    fs.chmodSync(target, 0o000);
    try {
      expect(rotateIfNeeded(target, { maxBytes: 1024 })).toBe(false);
      expect(rotateIfNeeded(target, { maxBytes: 1024 })).toBe(false);
    } finally {
      fs.chmodSync(target, 0o644);
    }
    expect(fs.statSync(target).size).toBe(2048);
    expect(fs.readFileSync(`${target}.1`, 'utf-8')).toBe('GOOD-1');
    expect(fs.readFileSync(`${target}.2`, 'utf-8')).toBe('GOOD-2');
  });

  test('a rotation in progress in another process (its lock) is left alone', () => {
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    fs.writeFileSync(`${target}.lock`, '');
    expect(rotateIfNeeded(target, { maxBytes: 1024 })).toBe(false);
    expect(fs.statSync(target).size).toBe(2048);
    expect(fs.existsSync(`${target}.1`)).toBe(false);
  });

  test('a lock left by a crashed rotation is cleared, and the next check rotates', () => {
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    fs.writeFileSync(`${target}.lock`, '');
    const old = (Date.now() - STALE_ROTATION_LOCK_MS - 60_000) / 1000;
    fs.utimesSync(`${target}.lock`, old, old);

    expect(rotateIfNeeded(target, { maxBytes: 1024 })).toBe(false);
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
    expect(rotateIfNeeded(target, { maxBytes: 1024 })).toBe(true);
    expect(fs.readFileSync(`${target}.1`).length).toBe(2048);
    // The lock is released after a rotation.
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
  });

  test('a temp copy left by a crashed rotation is removed by the next rotation', () => {
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    fs.writeFileSync(`${target}.rotating-99999`, 'half a copy');
    expect(rotateIfNeeded(target, { maxBytes: 1024 })).toBe(true);
    expect(fs.existsSync(`${target}.rotating-99999`)).toBe(false);
  });

  // #1262 review: without the lock, a second rotator copied the just-emptied
  // file over the first one's `.1`, losing the rotated data (21 of 60 trials
  // with four racers). Real processes, released in the same millisecond.
  test('rotations racing in several processes keep the rotated data and the backup', async () => {
    const rotation = path.join(import.meta.dir, '../../src/cli/log-rotation.ts');
    for (let trial = 0; trial < 6; trial++) {
      fs.writeFileSync(target, Buffer.alloc(4 * 1024 * 1024, 'n'));
      fs.writeFileSync(`${target}.1`, 'OLD1');
      fs.rmSync(`${target}.2`, { force: true });
      const startAt = Date.now() + 600;
      const script = `
        import { rotateIfNeeded } from ${JSON.stringify(rotation)};
        while (Date.now() < ${startAt}) {}
        rotateIfNeeded(${JSON.stringify(target)}, { maxBytes: 1024 * 1024 });
      `;
      const racers = Array.from({ length: 4 }, () =>
        Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'ignore' }),
      );
      await Promise.all(racers.map((r) => r.exited));

      expect(fs.statSync(target).size).toBe(0);
      expect(fs.statSync(`${target}.1`).size).toBe(4 * 1024 * 1024);
      expect(fs.readFileSync(`${target}.2`, 'utf-8')).toBe('OLD1');
    }
  }, 60000);

  test('respects a custom maxBytes override', () => {
    fs.writeFileSync(target, Buffer.alloc(100));
    expect(rotateIfNeeded(target, { maxBytes: 1000 })).toBe(false);
    expect(rotateIfNeeded(target, { maxBytes: 50 })).toBe(true);
    expect(fs.existsSync(`${target}.1`)).toBe(true);
  });

  test('never throws when the target is a directory instead of a file', () => {
    const dirTarget = path.join(sandbox, 'not-a-file.log');
    fs.mkdirSync(dirTarget);
    expect(() => rotateIfNeeded(dirTarget, { maxBytes: 0 })).not.toThrow();
  });

  test('an unexpected stat failure (not ENOENT) is logged, not silently ignored', () => {
    if (process.getuid?.() === 0) {
      // Root bypasses directory execute-permission checks; nothing to assert.
      return;
    }
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    fs.chmodSync(sandbox, 0o000); // no execute: statSync throws EACCES, not ENOENT
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (msg: string) => logged.push(msg);
    try {
      expect(rotateIfNeeded(target, { maxBytes: 1024 })).toBe(false);
      expect(
        logged.some((msg) => msg.includes('log rotation failed') && msg.includes('stat')),
      ).toBe(true);
    } finally {
      console.error = originalError;
      fs.chmodSync(sandbox, 0o755); // restore so afterEach's rmSync can clean up
    }
  });
});

describe('guardLogFiles (#729)', () => {
  let sandbox: string;
  let target: string;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-log-guard-'));
    target = path.join(sandbox, 'daemon.log');
  });

  afterEach(() => {
    stop?.();
    stop = null;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('checks every five minutes by default', () => {
    expect(LOG_GUARD_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  test('rotates a file a long-lived writer holds open, without the writer reopening it', async () => {
    const fd = fs.openSync(target, 'a');
    try {
      stop = guardLogFiles([target], { maxBytes: 1024, intervalMs: 20 });
      fs.writeSync(fd, Buffer.alloc(2048, 'a'));
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(`${target}.1`) && Date.now() < deadline) await Bun.sleep(10);
      fs.writeSync(fd, 'after\n');
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readFileSync(`${target}.1`).length).toBe(2048);
    expect(fs.readFileSync(target, 'utf-8')).toBe('after\n');
  });

  test('guards every file it is given', async () => {
    const other = path.join(sandbox, 'remi-stderr.log');
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    fs.writeFileSync(other, Buffer.alloc(2048, 'b'));
    stop = guardLogFiles([target, other], { maxBytes: 1024, intervalMs: 20 });
    const deadline = Date.now() + 3000;
    while (
      !(fs.existsSync(`${target}.1`) && fs.existsSync(`${other}.1`)) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(10);
    }
    expect(fs.readFileSync(`${target}.1`).length).toBe(2048);
    expect(fs.readFileSync(`${other}.1`).length).toBe(2048);
  });

  test('stops checking once stopped', async () => {
    stop = guardLogFiles([target], { maxBytes: 1024, intervalMs: 20 });
    stop();
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    await Bun.sleep(120);
    expect(fs.existsSync(`${target}.1`)).toBe(false);
  });
});

describe('planStdioLogGuard (#729, #1262 review)', () => {
  let sandbox: string;
  let daemonLog: string;
  let stdoutLog: string;
  const opened: number[] = [];
  const open = (file: string, flags: string): number => {
    const fd = fs.openSync(file, flags);
    opened.push(fd);
    return fd;
  };

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-log-plan-'));
    daemonLog = path.join(sandbox, 'daemon.log');
    stdoutLog = path.join(sandbox, 'remi-stdout.log');
  });

  afterEach(() => {
    for (const fd of opened.splice(0)) fs.closeSync(fd);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('a descriptor that appends to one of the files is guarded, once', () => {
    const out = open(daemonLog, 'a');
    const err = open(daemonLog, 'a');
    const plan = planStdioLogGuard([out, err], [daemonLog, stdoutLog]);
    expect(plan.guarded).toEqual([daemonLog]);
    expect(plan.notices).toEqual([]);
  });

  // A `>` redirect writes at its own offset: truncating under it would pad the
  // file with NUL bytes, so the file is left alone and the person told why.
  test('a descriptor that writes without append is not guarded, and says so', () => {
    const out = open(daemonLog, 'w');
    const plan = planStdioLogGuard([out], [daemonLog, stdoutLog]);
    expect(plan.guarded).toEqual([]);
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toContain('daemon.log');
    expect(plan.notices[0]).toContain('>>');
  });

  test("a file that is not one of remi's logs is not guarded, and says so", () => {
    const out = open(path.join(sandbox, 'mine.log'), 'a');
    const plan = planStdioLogGuard([out], [daemonLog, stdoutLog]);
    expect(plan.guarded).toEqual([]);
    expect(plan.notices).toHaveLength(1);
  });

  test('a device, or a descriptor that is not open, is skipped quietly', () => {
    const devNull = open('/dev/null', 'a');
    const closed = fs.openSync(path.join(sandbox, 'gone.log'), 'a');
    fs.closeSync(closed);
    expect(planStdioLogGuard([devNull, closed], [daemonLog])).toEqual({ guarded: [], notices: [] });
  });

  test("fdAppends reads the descriptor's own mode", () => {
    expect(fdAppends(open(daemonLog, 'a'))).toBe(true);
    expect(fdAppends(open(stdoutLog, 'w'))).toBe(false);
  });
});

describe('appendBounded (#729)', () => {
  let sandbox: string;
  let target: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-append-bounded-'));
    target = path.join(sandbox, 'hook-diag.jsonl');
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('appends, and rotates first once the file reached the bound', () => {
    appendBounded(target, 'one\n', { maxBytes: 8 });
    appendBounded(target, 'two\n', { maxBytes: 8 });
    expect(fs.readFileSync(target, 'utf-8')).toBe('one\ntwo\n');

    appendBounded(target, 'three\n', { maxBytes: 8 });
    expect(fs.readFileSync(target, 'utf-8')).toBe('three\n');
    expect(fs.readFileSync(`${target}.1`, 'utf-8')).toBe('one\ntwo\n');
  });

  test('a write failure still throws, so the caller can report it', () => {
    expect(() => appendBounded(path.join(sandbox, 'no-such-dir', 'x.log'), 'x')).toThrow();
  });
});
