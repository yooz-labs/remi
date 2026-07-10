import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IDLE_AUTO_APPROVE, type RemiStatus, StatusWriter } from '../../src/cli/status-writer.ts';

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
    autoApprove: { ...IDLE_AUTO_APPROVE },
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

  // --- auto-approve eval cue (#560) ---
  const aaWriter = () =>
    new StatusWriter(baseStatus(), {
      getTargetFile: () => target,
      isEnabled: () => false, // pure in-memory state; no disk needed
      writeLog: () => {},
      debounceMs: 0,
    });

  test('autoApprove: count increments on start, decrements on end, never negative', () => {
    const w = aaWriter();
    expect(w.state.autoApprove.inFlight).toBe(0);
    w.autoApproveStart(10_000);
    expect(w.state.autoApprove.inFlight).toBe(1);
    expect(w.state.autoApprove.sinceS).toBe(10); // 10_000ms floored to seconds
    w.autoApproveStart(12_000); // second concurrent eval; batch start unchanged
    expect(w.state.autoApprove.inFlight).toBe(2);
    expect(w.state.autoApprove.sinceS).toBe(10);
    w.autoApproveEnd('approved', 15_000);
    expect(w.state.autoApprove.inFlight).toBe(1);
    expect(w.state.autoApprove.sinceS).toBe(10); // still in flight
    w.autoApproveEnd('approved', 16_000);
    expect(w.state.autoApprove.inFlight).toBe(0);
    expect(w.state.autoApprove.sinceS).toBe(0); // cleared on 1->0
    w.autoApproveEnd('cancelled', 17_000); // unbalanced extra end never goes negative
    expect(w.state.autoApprove.inFlight).toBe(0);
  });

  test('autoApprove: records the last actionable verdict; cancelled does not overwrite it', () => {
    const w = aaWriter();
    w.autoApproveStart(1_000);
    w.autoApproveEnd('escalated', 2_000);
    expect(w.state.autoApprove.lastVerdict).toBe('escalated');
    expect(w.state.autoApprove.lastVerdictAtS).toBe(2);
    w.autoApproveStart(3_000);
    w.autoApproveEnd('cancelled', 4_000); // must NOT clobber the verdict
    expect(w.state.autoApprove.lastVerdict).toBe('escalated');
    // A later approve, well past the escalate-fresh window (>60s), DOES record.
    w.autoApproveStart(70_000);
    w.autoApproveEnd('approved', 71_000);
    expect(w.state.autoApprove.lastVerdict).toBe('approved');
    expect(w.state.autoApprove.lastVerdictAtS).toBe(71);
  });

  test('autoApprove: an end with no matching start records no verdict (AA-off escalate path)', () => {
    const w = aaWriter();
    w.autoApproveEnd('escalated', 5_000); // no prior start (e.g. auto-approve disabled)
    expect(w.state.autoApprove.inFlight).toBe(0);
    expect(w.state.autoApprove.lastVerdict).toBe('none'); // not spuriously stamped
  });

  test('autoApprove: a concurrent approve does not hide a still-fresh escalate', () => {
    const w = aaWriter();
    w.autoApproveStart(1_000); // A
    w.autoApproveStart(1_500); // B
    w.autoApproveEnd('escalated', 2_000); // A escalates -> user must act
    expect(w.state.autoApprove.lastVerdict).toBe('escalated');
    w.autoApproveEnd('approved', 2_300); // B approves shortly after; must NOT clobber
    expect(w.state.autoApprove.lastVerdict).toBe('escalated');
  });

  test('autoApprove: interleaved concurrent evals never get stuck "evaluating" (the old spinner race)', () => {
    const w = aaWriter();
    w.autoApproveStart(100_000); // A
    w.autoApproveStart(101_000); // B
    w.autoApproveEnd('approved', 102_000); // A done; B still in flight
    expect(w.state.autoApprove.inFlight).toBe(1);
    w.autoApproveEnd('escalated', 103_000); // B done
    expect(w.state.autoApprove.inFlight).toBe(0); // back to idle, not stuck
    expect(w.state.autoApprove.sinceS).toBe(0);
  });

  // #754/#755: every flush stamps live attach state and broadcasts the
  // snapshot to clients on the same debounce as the disk write.
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
});
