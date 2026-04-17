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
});
