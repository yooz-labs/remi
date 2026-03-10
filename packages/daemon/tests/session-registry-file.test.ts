import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_BASE_PORT,
  type LiveSessionEntry,
  SessionRegistryFile,
} from '../src/session/session-registry-file.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-registry-test-'));
}

function makeEntry(overrides: Partial<LiveSessionEntry> = {}): LiveSessionEntry {
  return {
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pid: process.pid, // current process is alive
    wsPort: DEFAULT_BASE_PORT,
    hookPort: DEFAULT_BASE_PORT + 100,
    projectPath: '/tmp/test-project',
    name: 'test:project/main',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SessionRegistryFile', () => {
  let tmpDir: string;
  let registry: SessionRegistryFile;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    registry = new SessionRegistryFile(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('register and list round-trip', () => {
    const entry = makeEntry();
    registry.register(entry);

    const live = registry.listLive();
    expect(live).toHaveLength(1);
    expect(live[0]!.sessionId).toBe(entry.sessionId);
    expect(live[0]!.wsPort).toBe(entry.wsPort);
  });

  test('register multiple sessions', () => {
    const e1 = makeEntry({ sessionId: 'sess-1', wsPort: 18765 });
    const e2 = makeEntry({ sessionId: 'sess-2', wsPort: 18766 });
    const e3 = makeEntry({ sessionId: 'sess-3', wsPort: 18767 });

    registry.register(e1);
    registry.register(e2);
    registry.register(e3);

    const live = registry.listLive();
    expect(live).toHaveLength(3);
  });

  test('unregister removes session', () => {
    const entry = makeEntry({ sessionId: 'to-remove' });
    registry.register(entry);
    expect(registry.listLive()).toHaveLength(1);

    registry.unregister('to-remove');
    expect(registry.listLive()).toHaveLength(0);
  });

  test('unregister non-existent session is no-op', () => {
    registry.unregister('does-not-exist');
    // No error thrown
  });

  test('listLive removes stale entries with dead PIDs', () => {
    // Use a PID that is almost certainly not running
    const staleEntry = makeEntry({ sessionId: 'stale', pid: 999999 });
    const liveEntry = makeEntry({ sessionId: 'live', pid: process.pid });

    registry.register(staleEntry);
    registry.register(liveEntry);

    const live = registry.listLive();
    expect(live).toHaveLength(1);
    expect(live[0]!.sessionId).toBe('live');

    // Stale file should have been cleaned up
    const staleFile = path.join(tmpDir, 'stale.json');
    expect(fs.existsSync(staleFile)).toBe(false);
  });

  test('listLive sorts by startedAt descending (most recent first)', () => {
    const older = makeEntry({
      sessionId: 'older',
      startedAt: '2025-01-01T00:00:00.000Z',
    });
    const newer = makeEntry({
      sessionId: 'newer',
      startedAt: '2026-06-01T00:00:00.000Z',
    });

    registry.register(older);
    registry.register(newer);

    const live = registry.listLive();
    expect(live[0]!.sessionId).toBe('newer');
    expect(live[1]!.sessionId).toBe('older');
  });

  test('listLive handles corrupt JSON files', () => {
    const entry = makeEntry({ sessionId: 'valid' });
    registry.register(entry);

    // Write a corrupt file
    fs.writeFileSync(path.join(tmpDir, 'corrupt.json'), '{{not json');

    const live = registry.listLive();
    expect(live).toHaveLength(1);
    expect(live[0]!.sessionId).toBe('valid');
  });

  test('listLive skips .tmp files', () => {
    const entry = makeEntry({ sessionId: 'valid' });
    registry.register(entry);

    // Write a leftover temp file
    fs.writeFileSync(path.join(tmpDir, 'leftover.json.tmp'), '{}');

    const live = registry.listLive();
    expect(live).toHaveLength(1);
  });

  test('listLive returns empty when directory does not exist', () => {
    const nonExistent = new SessionRegistryFile('/tmp/remi-does-not-exist-xyz');
    expect(nonExistent.listLive()).toEqual([]);
  });

  test('findAvailablePort returns first port when no sessions', () => {
    const port = registry.findAvailablePort(18765, 10);
    expect(port).toBe(18765);
  });

  test('findAvailablePort skips used ports', () => {
    registry.register(makeEntry({ sessionId: 'a', wsPort: 18765 }));
    registry.register(makeEntry({ sessionId: 'b', wsPort: 18766 }));

    const port = registry.findAvailablePort(18765, 10);
    expect(port).toBe(18767);
  });

  test('findAvailablePort returns null when all ports exhausted', () => {
    for (let i = 0; i < 3; i++) {
      registry.register(makeEntry({ sessionId: `s-${i}`, wsPort: 18765 + i }));
    }

    const port = registry.findAvailablePort(18765, 3);
    expect(port).toBeNull();
  });

  test('findBySessionId returns matching entry', () => {
    const entry = makeEntry({ sessionId: 'target-id' });
    registry.register(entry);
    registry.register(makeEntry({ sessionId: 'other' }));

    const found = registry.findBySessionId('target-id');
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe('target-id');
  });

  test('findBySessionId returns null for unknown ID', () => {
    expect(registry.findBySessionId('unknown')).toBeNull();
  });

  test('findByName returns exact match', () => {
    registry.register(makeEntry({ sessionId: 'a', name: 'host:project/main' }));
    registry.register(makeEntry({ sessionId: 'b', name: 'host:project/dev' }));

    const found = registry.findByName('host:project/main');
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe('a');
  });

  test('findByName returns unambiguous prefix match', () => {
    registry.register(makeEntry({ sessionId: 'a', name: 'host:project/main' }));

    const found = registry.findByName('host:project');
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe('a');
  });

  test('findByName returns null for ambiguous prefix', () => {
    registry.register(makeEntry({ sessionId: 'a', name: 'host:project/main' }));
    registry.register(makeEntry({ sessionId: 'b', name: 'host:project/dev' }));

    expect(registry.findByName('host:project')).toBeNull();
  });

  test('getLivePorts returns unique ports', () => {
    registry.register(makeEntry({ sessionId: 'a', wsPort: 18765 }));
    registry.register(makeEntry({ sessionId: 'b', wsPort: 18766 }));
    registry.register(makeEntry({ sessionId: 'c', wsPort: 18767 }));

    const ports = registry.getLivePorts();
    expect(ports).toHaveLength(3);
    expect(ports).toContain(18765);
    expect(ports).toContain(18766);
    expect(ports).toContain(18767);
  });

  test('register creates directory if it does not exist', () => {
    const newDir = path.join(tmpDir, 'nested', 'dir');
    const reg = new SessionRegistryFile(newDir);

    reg.register(makeEntry({ sessionId: 'first' }));

    expect(fs.existsSync(newDir)).toBe(true);
    expect(reg.listLive()).toHaveLength(1);
  });

  test('register overwrites existing entry for same session', () => {
    const entry = makeEntry({ sessionId: 'same', wsPort: 18765 });
    registry.register(entry);

    const updated = makeEntry({ sessionId: 'same', wsPort: 18770 });
    registry.register(updated);

    const live = registry.listLive();
    expect(live).toHaveLength(1);
    expect(live[0]!.wsPort).toBe(18770);
  });
});
