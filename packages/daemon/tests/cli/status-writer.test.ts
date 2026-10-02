import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type RemiStatus, StatusWriter } from '../../src/cli/status-writer.ts';

function baseStatus(overrides: Partial<RemiStatus> = {}): RemiStatus {
  return {
    pid: 12345,
    connections: 0,
    sessionStatus: 'starting',
    adapters: [],
    wsPort: 0,
    sessionId: null,
    repo: 'remi',
    branch: 'develop',
    ...overrides,
  };
}

describe('StatusWriter', () => {
  let sandbox: string;
  let target: string;
  let logs: string[];

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-status-'));
    target = path.join(sandbox, 'status.json');
    logs = [];
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('flush writes JSON atomically at the current target path', () => {
    const writer = new StatusWriter(baseStatus({ connections: 3, adapters: ['ws'] }), {
      getTargetFile: () => target,
      isEnabled: () => true,
      writeLog: (m) => logs.push(m),
      debounceMs: 0,
    });
    writer.flush();
    const content = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(content.connections).toBe(3);
    expect(content.adapters).toEqual(['ws']);
  });

  test('update merges the patch into state', () => {
    const writer = new StatusWriter(baseStatus(), {
      getTargetFile: () => target,
      isEnabled: () => true,
      writeLog: () => {},
      debounceMs: 0,
    });
    writer.update({ connections: 1, sessionStatus: 'executing' });
    expect(writer.state.connections).toBe(1);
    expect(writer.state.sessionStatus).toBe('executing');
    // Unrelated fields preserved.
    expect(writer.state.pid).toBe(12345);
  });

  test('state reflects updates across multiple patches', () => {
    const writer = new StatusWriter(baseStatus({ adapters: ['ws'] }), {
      getTargetFile: () => target,
      isEnabled: () => true,
      writeLog: () => {},
      debounceMs: 0,
    });
    writer.update({ adapters: [...writer.state.adapters, 'tg'] });
    writer.update({ connections: 5 });
    expect(writer.state.adapters).toEqual(['ws', 'tg']);
    expect(writer.state.connections).toBe(5);
  });

  test('write is a no-op when isEnabled returns false', () => {
    const writer = new StatusWriter(baseStatus(), {
      getTargetFile: () => target,
      isEnabled: () => false,
      writeLog: () => {},
      debounceMs: 0,
    });
    writer.flush();
    expect(fs.existsSync(target)).toBe(false);
  });

  test('debounce collapses bursts into a single write', async () => {
    const writer = new StatusWriter(baseStatus(), {
      getTargetFile: () => target,
      isEnabled: () => true,
      writeLog: () => {},
      debounceMs: 20,
    });
    writer.update({ connections: 1 });
    writer.update({ connections: 2 });
    writer.update({ connections: 3 });
    // Not written yet
    expect(fs.existsSync(target)).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    const content = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(content.connections).toBe(3);
  });

  test('getTargetFile is called on every flush so the path can change at runtime', () => {
    let current = path.join(sandbox, 'first.json');
    const writer = new StatusWriter(baseStatus({ connections: 1 }), {
      getTargetFile: () => current,
      isEnabled: () => true,
      writeLog: () => {},
      debounceMs: 0,
    });
    writer.flush();
    expect(fs.existsSync(current)).toBe(true);
    current = path.join(sandbox, 'second.json');
    writer.update({ connections: 2 });
    writer.flush();
    expect(fs.existsSync(current)).toBe(true);
    const content = JSON.parse(fs.readFileSync(current, 'utf-8'));
    expect(content.connections).toBe(2);
  });

  test('write errors are logged at most once per failure streak', () => {
    // Point target to a path whose parent is a regular file — writes will fail.
    const blocker = path.join(sandbox, 'blocker');
    fs.writeFileSync(blocker, 'not a dir');
    const bad = path.join(blocker, 'nested', 'status.json');
    const writer = new StatusWriter(baseStatus(), {
      getTargetFile: () => bad,
      isEnabled: () => true,
      writeLog: (m) => logs.push(m),
      debounceMs: 0,
    });
    writer.flush();
    writer.flush();
    writer.flush();
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/^\[error\] Failed to write status file/);
  });

  test('a successful write after an error resets the error-logged flag', () => {
    // Start with a bad path, then swap to a good one.
    let targetRef = path.join(sandbox, 'bad-parent', 'status.json');
    const writer = new StatusWriter(baseStatus(), {
      getTargetFile: () => targetRef,
      isEnabled: () => true,
      writeLog: (m) => logs.push(m),
      debounceMs: 0,
    });
    fs.writeFileSync(path.join(sandbox, 'bad-parent'), 'blocker');
    writer.flush();
    expect(logs.length).toBe(1);
    // Restore target to a writable location and flush again
    targetRef = path.join(sandbox, 'good.json');
    writer.flush();
    expect(fs.existsSync(targetRef)).toBe(true);
    // Now force another failure to prove the flag was reset.
    targetRef = path.join(sandbox, 'bad-parent', 'other.json');
    writer.flush();
    expect(logs.length).toBe(2);
  });

  test('cleanup removes the target file and cancels pending debounce', async () => {
    const writer = new StatusWriter(baseStatus(), {
      getTargetFile: () => target,
      isEnabled: () => true,
      writeLog: () => {},
      debounceMs: 30,
    });
    fs.writeFileSync(target, 'pre-existing');
    writer.update({ connections: 99 }); // schedules a write
    writer.cleanup();
    expect(fs.existsSync(target)).toBe(false);
    // Wait past the debounce window to confirm no delayed write recreates the file.
    await new Promise((r) => setTimeout(r, 60));
    expect(fs.existsSync(target)).toBe(false);
  });

  test('cleanup is a no-op when the target file does not exist', () => {
    const writer = new StatusWriter(baseStatus(), {
      getTargetFile: () => target,
      isEnabled: () => true,
      writeLog: () => {},
      debounceMs: 0,
    });
    expect(() => writer.cleanup()).not.toThrow();
  });

  describe('broadcast + attach-state stamping (#754/#755)', () => {
    test('flush stamps getAttachState fields and fires broadcast with them', () => {
      const broadcasts: Array<{
        attached: boolean | undefined;
        queuedCount: number | undefined;
      }> = [];
      const writer = new StatusWriter(baseStatus(), {
        getTargetFile: () => target,
        isEnabled: () => true,
        writeLog: (m) => logs.push(m),
        debounceMs: 0,
        getAttachState: () => ({ attached: true, queuedCount: 2 }),
        broadcast: (s) => broadcasts.push({ attached: s.attached, queuedCount: s.queuedCount }),
      });
      writer.flush();
      expect(broadcasts).toEqual([{ attached: true, queuedCount: 2 }]);
      const onDisk = JSON.parse(fs.readFileSync(target, 'utf-8'));
      expect(onDisk.attached).toBe(true);
      expect(onDisk.queuedCount).toBe(2);
    });

    test('broadcast fires even when the file write is disabled', () => {
      let broadcastCount = 0;
      const writer = new StatusWriter(baseStatus(), {
        getTargetFile: () => target,
        isEnabled: () => false,
        writeLog: (m) => logs.push(m),
        debounceMs: 0,
        broadcast: () => {
          broadcastCount += 1;
        },
      });
      writer.flush();
      expect(broadcastCount).toBe(1);
      expect(fs.existsSync(target)).toBe(false);
    });

    test('a throwing broadcast is logged once and never breaks the file write', () => {
      const writer = new StatusWriter(baseStatus({ connections: 1 }), {
        getTargetFile: () => target,
        isEnabled: () => true,
        writeLog: (m) => logs.push(m),
        debounceMs: 0,
        broadcast: () => {
          throw new Error('registry down');
        },
      });
      writer.flush();
      writer.flush();
      const onDisk = JSON.parse(fs.readFileSync(target, 'utf-8'));
      expect(onDisk.connections).toBe(1); // file write survived
      expect(logs.filter((l) => l.includes('Status broadcast failed'))).toHaveLength(1);
    });

    test('debounce collapses bursts into a single broadcast', async () => {
      let broadcastCount = 0;
      const writer = new StatusWriter(baseStatus(), {
        getTargetFile: () => target,
        isEnabled: () => true,
        writeLog: (m) => logs.push(m),
        debounceMs: 10,
        broadcast: () => {
          broadcastCount += 1;
        },
      });
      writer.update({ connections: 1 });
      writer.update({ connections: 2 });
      writer.update({ connections: 3 });
      await new Promise((r) => setTimeout(r, 30));
      expect(broadcastCount).toBe(1);
    });
  });

  // #1038: `getAttachState` was pulled only inside write(), and no attach or
  // detach path calls update() -- so an attaching phone changed nothing the
  // bar, the status file or any client could see until an unrelated status
  // change happened along. refresh() is the pull that closes that.
  describe('attach-state refresh (#1038)', () => {
    function attachHarness(debounceMs = 0) {
      const broadcasts: Array<boolean | undefined> = [];
      const attach = { attached: false, queuedCount: 0 };
      const writer = new StatusWriter(baseStatus(), {
        getTargetFile: () => target,
        isEnabled: () => true,
        writeLog: (m) => logs.push(m),
        debounceMs,
        getAttachState: () => ({ ...attach }),
        broadcast: (s) => broadcasts.push(s.attached),
      });
      return { writer, attach, broadcasts };
    }

    /** refresh() only SCHEDULES; even at debounceMs 0 the flush is a task. */
    const settle = () => new Promise((r) => setTimeout(r, 5));

    test('refresh flushes when the attach state changed', async () => {
      const { writer, attach, broadcasts } = attachHarness();
      writer.refresh(); // first pull: undefined -> false, a real change
      await settle();
      expect(broadcasts).toEqual([false]);
      attach.attached = true; // a phone attaches; nothing else in the status moves
      writer.refresh();
      await settle();
      expect(writer.state.attached).toBe(true);
      expect(broadcasts).toEqual([false, true]);
      expect(JSON.parse(fs.readFileSync(target, 'utf-8')).attached).toBe(true);
    });

    test('refresh writes nothing when the attach state is unchanged', async () => {
      const { writer, broadcasts } = attachHarness();
      writer.refresh();
      await settle();
      expect(broadcasts).toHaveLength(1);
      // The poll runs several times a second; an idle session must not turn
      // that into a disk write and a client broadcast per tick.
      writer.refresh();
      writer.refresh();
      await settle();
      expect(broadcasts).toHaveLength(1);
    });

    test('a detach that leaves other connections attached still flushes', async () => {
      // queuedCount/attached are derived from the SET, not from the
      // zero<->nonzero edges, so a membership change that is not an edge must
      // still reach the snapshot. Guards the ordering in
      // `detachConnection`: the emit sits BEFORE the still-attached early
      // return.
      const { writer, attach, broadcasts } = attachHarness();
      attach.attached = true;
      attach.queuedCount = 2;
      writer.refresh();
      await settle();
      expect(broadcasts).toEqual([true]);
      attach.queuedCount = 1; // one of several detached; still attached
      writer.refresh();
      await settle();
      expect(writer.state.queuedCount).toBe(1);
      expect(broadcasts).toEqual([true, true]); // flushed again, same attached
    });

    test('a throwing getAttachState is logged once and leaves refresh a no-op', () => {
      const writer = new StatusWriter(baseStatus(), {
        getTargetFile: () => target,
        isEnabled: () => true,
        writeLog: (m) => logs.push(m),
        debounceMs: 0,
        getAttachState: () => {
          throw new Error('registry down');
        },
      });
      writer.refresh();
      writer.refresh();
      expect(fs.existsSync(target)).toBe(false); // nothing scheduled
      expect(logs.filter((l) => l.includes('attach-state read failed'))).toHaveLength(1);
    });

    test('the attach-state error latch is per-streak, not per-process', () => {
      // The docstring says "once per streak"; without a reset on success it
      // is once per process, and an intermittently-throwing registry read
      // (session teardown) would go unreported for the life of the daemon
      // after the first occurrence.
      let broken = true;
      const writer = new StatusWriter(baseStatus(), {
        getTargetFile: () => target,
        isEnabled: () => true,
        writeLog: (m) => logs.push(m),
        debounceMs: 0,
        getAttachState: () => {
          if (broken) throw new Error('registry down');
          return { attached: false, queuedCount: 0 };
        },
      });
      writer.refresh();
      expect(logs.filter((l) => l.includes('attach-state read failed'))).toHaveLength(1);
      broken = false;
      writer.refresh(); // succeeds: clears the streak
      broken = true;
      writer.refresh(); // a NEW streak must report again
      expect(logs.filter((l) => l.includes('attach-state read failed'))).toHaveLength(2);
    });
  });
});
