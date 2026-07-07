import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LOG_KEEP, LOG_MAX_BYTES, rotateIfNeeded } from '../../src/cli/log-rotation.ts';

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

  test('oversized file is renamed to .1 and the live path is gone', () => {
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    const result = rotateIfNeeded(target, { maxBytes: 1024 });
    expect(result).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.1`)).toBe(true);
    expect(fs.readFileSync(`${target}.1`).length).toBe(2048);
  });

  test('existing .1 and .2 shift, oldest is dropped', () => {
    fs.writeFileSync(target, 'current');
    fs.writeFileSync(`${target}.1`, 'backup-1');
    fs.writeFileSync(`${target}.2`, 'backup-2-oldest');

    const result = rotateIfNeeded(target, { maxBytes: 1 });
    expect(result).toBe(true);

    expect(fs.existsSync(target)).toBe(false);
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
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(`${target}.1`, 'utf-8')).toBe('current');
    expect(fs.existsSync(`${target}.2`)).toBe(false);
  });

  test('rotates a file exactly at the threshold (boundary is inclusive)', () => {
    fs.writeFileSync(target, Buffer.alloc(1024));
    const result = rotateIfNeeded(target, { maxBytes: 1024 });
    expect(result).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.1`)).toBe(true);
  });

  test('a failed rename is swallowed: target is left in place, still returns true', () => {
    if (process.getuid?.() === 0) {
      // Root bypasses directory write-permission checks; nothing to assert.
      return;
    }
    fs.writeFileSync(target, Buffer.alloc(2048, 'a'));
    fs.chmodSync(sandbox, 0o555); // read/execute only: rename inside it fails
    try {
      const result = rotateIfNeeded(target, { maxBytes: 1024 });
      expect(result).toBe(true);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(`${target}.1`)).toBe(false);
    } finally {
      fs.chmodSync(sandbox, 0o755); // restore so afterEach's rmSync can clean up
    }
  });

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
});
