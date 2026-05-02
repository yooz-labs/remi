import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startUpdateWatcher } from '../../src/cli/update-watcher.ts';

describe('startUpdateWatcher (#287)', () => {
  let tmpDir: string;
  let binaryPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-update-watcher-'));
    binaryPath = path.join(tmpDir, 'fake-remi');
    // Ensure mtime resolution lets us distinguish writes — most platforms
    // give us 1ms resolution but some test runners run fast enough that two
    // back-to-back writes register identical mtimes. Add a small explicit
    // delta below where needed.
    fs.writeFileSync(binaryPath, 'v0', { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('records baseline mtime on start', () => {
    const baseline = fs.statSync(binaryPath).mtimeMs;
    const watcher = startUpdateWatcher({
      binaryPath,
      intervalMs: 50,
      onUpdateDetected: () => {},
    });
    try {
      expect(watcher.baselineMtimeMs).toBe(baseline);
    } finally {
      watcher.stop();
    }
  });

  test('fires onUpdateDetected once when binary mtime changes', async () => {
    const detected: number[] = [];
    const watcher = startUpdateWatcher({
      binaryPath,
      intervalMs: 25,
      onUpdateDetected: (m) => detected.push(m),
    });
    try {
      // Bump mtime forward by a wide margin so the file system definitely
      // sees a different value, even on coarse-resolution mtime stores.
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(binaryPath, future, future);
      // Wait for at least two poll intervals so the watcher had a chance.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(detected).toHaveLength(1);
      // And no further fires from a second modification — the watcher
      // is one-shot by design.
      const later = new Date(Date.now() + 4_000);
      fs.utimesSync(binaryPath, later, later);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(detected).toHaveLength(1);
    } finally {
      watcher.stop();
    }
  });

  test('fires when the binary is replaced via atomic rename (different inode)', async () => {
    // Builders typically write to a tmp file and rename; the new file may
    // share the same mtime as the old one if the system clock is coarse.
    // Inode change is the reliable signal in that case.
    const detected: number[] = [];
    const watcher = startUpdateWatcher({
      binaryPath,
      intervalMs: 25,
      onUpdateDetected: (m) => detected.push(m),
    });
    try {
      const tmpReplacement = `${binaryPath}.tmp`;
      fs.writeFileSync(tmpReplacement, 'v1', { mode: 0o755 });
      fs.renameSync(tmpReplacement, binaryPath);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(detected).toHaveLength(1);
    } finally {
      watcher.stop();
    }
  });

  test('survives transient ENOENT during the rename window', async () => {
    // Between the write of binary.tmp and rename(binary.tmp -> binary)
    // the watcher might stat() and see ENOENT. That must not crash and
    // must not fire onUpdateDetected (the file is back almost immediately).
    const errors: Error[] = [];
    const detected: number[] = [];
    const watcher = startUpdateWatcher({
      binaryPath,
      intervalMs: 25,
      onUpdateDetected: (m) => detected.push(m),
      onError: (err) => errors.push(err),
    });
    try {
      // Briefly remove the binary.
      fs.unlinkSync(binaryPath);
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Recreate at a NEW mtime so the watcher fires on the next tick.
      const future = new Date(Date.now() + 2_000);
      fs.writeFileSync(binaryPath, 'v1', { mode: 0o755 });
      fs.utimesSync(binaryPath, future, future);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // ENOENT is silently absorbed (no onError call), and the recreated
      // file with a new mtime fires onUpdateDetected exactly once.
      expect(errors).toHaveLength(0);
      expect(detected).toHaveLength(1);
    } finally {
      watcher.stop();
    }
  });

  test('reports null baseline + never fires when binary is missing at start', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const detected: number[] = [];
    const errors: Error[] = [];
    const watcher = startUpdateWatcher({
      binaryPath: missing,
      intervalMs: 25,
      onUpdateDetected: (m) => detected.push(m),
      onError: (err) => errors.push(err),
    });
    try {
      // Initial stat fails → onError called once with the stat failure.
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(watcher.baselineMtimeMs).toBeNull();

      // Even if the file appears later, we have no baseline to compare
      // against, so onUpdateDetected stays unfired. This is by design —
      // a missing binary at startup means we cannot know what version
      // we are running, so a "newer" signal would be meaningless.
      fs.writeFileSync(missing, 'v1', { mode: 0o755 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(detected).toEqual([]);
    } finally {
      watcher.stop();
    }
  });

  test('stop() is idempotent and stops further polling', async () => {
    const detected: number[] = [];
    const watcher = startUpdateWatcher({
      binaryPath,
      intervalMs: 25,
      onUpdateDetected: (m) => detected.push(m),
    });
    watcher.stop();
    watcher.stop(); // second call must not throw

    // Mutate the file and confirm no detection fires after stop.
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(binaryPath, future, future);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(detected).toEqual([]);
  });

  test('onError thrown from onUpdateDetected does not break the watcher', async () => {
    const errors: Error[] = [];
    const watcher = startUpdateWatcher({
      binaryPath,
      intervalMs: 25,
      onUpdateDetected: () => {
        throw new Error('client handler exploded');
      },
      onError: (err) => errors.push(err),
    });
    try {
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(binaryPath, future, future);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('client handler exploded');
    } finally {
      watcher.stop();
    }
  });
});
