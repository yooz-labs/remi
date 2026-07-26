/**
 * Production seams for engine supervision (#818): the real `~/.remi/engine.pid`
 * store and the real detached spawn.
 *
 * `engine-host.test.ts` covers the POLICY against an in-memory PidStore. This
 * file covers the two things that policy cannot: whether the on-disk claim is
 * actually exclusive, and whether the spawn actually detaches. Both use real
 * files and real processes — the failure modes here (a non-atomic claim, an
 * fd leak, a child that dies with its parent) only exist against a real OS.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileEnginePidStore, spawnDetachedEngine } from '../../src/auto-approve/engine-process.ts';

const TEST_DIR = path.join(os.tmpdir(), `remi-engine-pid-${process.pid}`);
const PID_FILE = path.join(TEST_DIR, 'engine.pid');
const LOG_FILE = path.join(TEST_DIR, 'engine.log');

/** A pid that is certainly dead. Very large values are above the wrap range on
 *  both macOS and Linux, so nothing can be recycled onto them mid-test. */
const DEAD_PID = 999_999_998;

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('FileEnginePidStore', () => {
  test('claims an unheld record and reports it back', () => {
    const store = new FileEnginePidStore(PID_FILE);
    expect(store.claim(process.pid)).toBe(true);
    expect(store.read()).toBe(process.pid);
  });

  test('a second claim against a LIVE holder fails', () => {
    // The start-race guard: of two daemons booting together exactly one may
    // spawn a multi-GB helper. If this ever returns true for both, #818's
    // "one engine per machine" invariant is gone.
    const first = new FileEnginePidStore(PID_FILE);
    const second = new FileEnginePidStore(PID_FILE);
    expect(first.claim(process.pid)).toBe(true);
    expect(second.claim(process.pid + 1)).toBe(false);
    expect(second.read()).toBe(process.pid);
  });

  test('a STALE record is displaced, not obeyed forever', () => {
    // A machine that lost power mid-download must not need manual cleanup.
    fs.writeFileSync(PID_FILE, `${DEAD_PID}\n`);
    const store = new FileEnginePidStore(PID_FILE);
    expect(store.claim(process.pid)).toBe(true);
    expect(store.read()).toBe(process.pid);
  });

  test('read() reports a dead holder as absent', () => {
    fs.writeFileSync(PID_FILE, `${DEAD_PID}\n`);
    expect(new FileEnginePidStore(PID_FILE).read()).toBeNull();
  });

  test('read() reports a missing or malformed file as absent', () => {
    const store = new FileEnginePidStore(PID_FILE);
    expect(store.read()).toBeNull();
    fs.writeFileSync(PID_FILE, 'not-a-pid\n');
    expect(store.read()).toBeNull();
    fs.writeFileSync(PID_FILE, '-4\n');
    expect(store.read()).toBeNull();
  });

  test('release only removes OUR record', () => {
    // A late cleanup must not delete the record of an engine somebody else
    // started in the meantime.
    const store = new FileEnginePidStore(PID_FILE);
    store.claim(process.pid);
    store.release(process.pid + 1);
    expect(store.read()).toBe(process.pid);
    store.release(process.pid);
    expect(store.read()).toBeNull();
  });

  test('release works for an already-dead pid', () => {
    // The normal cleanup case: the engine we recorded has exited, and the
    // record must still be removable even though read() calls it absent.
    fs.writeFileSync(PID_FILE, `${DEAD_PID}\n`);
    new FileEnginePidStore(PID_FILE).release(DEAD_PID);
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  test('claim after release succeeds', () => {
    const store = new FileEnginePidStore(PID_FILE);
    expect(store.claim(process.pid)).toBe(true);
    store.release(process.pid);
    expect(store.claim(process.pid)).toBe(true);
  });

  // Displacing a stale record is the one path where two processes can both
  // believe they won: without serialization, the second claimant's `unlink`
  // deletes the first's freshly written LIVE record and both return true, so
  // both spawn a multi-GB helper. That is the crash-then-reboot case (stale
  // record + hub and session daemon booting together).
  //
  // These drive the mutex directly rather than racing real processes: a real
  // race only hits the window occasionally, so a timing-based test passes just
  // as happily against the broken implementation and proves nothing.
  test('a claimant backs off while another process is mid-displacement', () => {
    fs.writeFileSync(PID_FILE, `${DEAD_PID}\n`);
    // A LIVE process (this one) holds the displacement mutex.
    fs.writeFileSync(`${PID_FILE}.claim`, `${process.pid}\n`);

    expect(new FileEnginePidStore(PID_FILE).claim(process.pid + 1)).toBe(false);
    // The stale record is untouched: displacing it is the mutex holder's job.
    expect(fs.readFileSync(PID_FILE, 'utf8').trim()).toBe(String(DEAD_PID));
  });

  test('a mutex left behind by a dead process does not wedge claiming', () => {
    // The mutex must not become a new way to jam the feature permanently --
    // that would trade one wedge for another.
    fs.writeFileSync(PID_FILE, `${DEAD_PID}\n`);
    fs.writeFileSync(`${PID_FILE}.claim`, `${DEAD_PID}\n`);

    expect(new FileEnginePidStore(PID_FILE).claim(process.pid)).toBe(true);
    expect(new FileEnginePidStore(PID_FILE).read()).toBe(process.pid);
  });

  test('the displacement mutex is released once the claim settles', () => {
    // A leaked mutex would block the NEXT displacement until its holder died.
    fs.writeFileSync(PID_FILE, `${DEAD_PID}\n`);
    expect(new FileEnginePidStore(PID_FILE).claim(process.pid)).toBe(true);
    expect(fs.existsSync(`${PID_FILE}.claim`)).toBe(false);
  });

  test('creates the containing directory', () => {
    const nested = path.join(TEST_DIR, 'deep', 'engine.pid');
    expect(new FileEnginePidStore(nested).claim(process.pid)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('spawnDetachedEngine', () => {
  /** A real, harmless long-running binary standing in for the helper. */
  const SLEEP = '/bin/sleep';

  test('starts a real process and returns its pid', () => {
    const pid = spawnDetachedEngine(SLEEP, { YOOZ_ENGINE_PORT: '19924' }, LOG_FILE);
    try {
      expect(pid).toBeGreaterThan(0);
      // Signal 0: alive without delivering anything.
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(pid);
      } catch {
        // Already gone; the assertion above is what matters.
      }
    }
  });

  test('throws on a helper path that cannot be executed', () => {
    // EngineHost relies on this throwing so it can release its pidfile claim.
    // A silent failure would leave a record for a process that never existed,
    // blocking every later attempt.
    const missing = path.join(TEST_DIR, 'no-such-helper');
    expect(() => spawnDetachedEngine(missing, {}, LOG_FILE)).toThrow();
  });

  test('writes a start banner to the log file', () => {
    // The helper's own diagnostics are the only evidence available when it
    // starts but never binds, so the log has to exist and be appended to.
    const pid = spawnDetachedEngine(SLEEP, {}, LOG_FILE);
    try {
      expect(fs.readFileSync(LOG_FILE, 'utf8')).toContain('Engine starting at');
    } finally {
      try {
        process.kill(pid);
      } catch {
        // Cleanup only.
      }
    }
  });

  test('repeated spawns do not leak descriptors', () => {
    // The log fd is opened per attempt; without the close in the finally block
    // a daemon retrying a failing helper would exhaust its fd budget.
    const before = process.report?.getReport() as { openFileDescriptors?: unknown[] } | undefined;
    const pids: number[] = [];
    try {
      for (let i = 0; i < 12; i++) pids.push(spawnDetachedEngine(SLEEP, {}, LOG_FILE));
      const after = process.report?.getReport() as { openFileDescriptors?: unknown[] } | undefined;
      const beforeCount = before?.openFileDescriptors?.length;
      const afterCount = after?.openFileDescriptors?.length;
      // Only assert when the runtime actually reports descriptors; the leak
      // this guards is a hard +1 per call, so a small allowance is ample.
      if (typeof beforeCount === 'number' && typeof afterCount === 'number') {
        expect(afterCount - beforeCount).toBeLessThan(6);
      }
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid);
        } catch {
          // Cleanup only.
        }
      }
    }
  });
});
