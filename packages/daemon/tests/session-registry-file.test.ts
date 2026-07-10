import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_BASE_PORT,
  type LiveSessionEntry,
  SessionRegistryFile,
  claudeChildLooksAlive,
} from '../src/session/session-registry-file.ts';

/** Spawn a trivial process and await its exit to obtain a really-dead pid. */
async function deadChildPid(): Promise<number> {
  const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
  await proc.exited;
  return proc.pid;
}

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

  test('version field persists through register/listLive (#539)', () => {
    const versioned = makeEntry({ sessionId: 'versioned-entry', version: '0.6.19-dev.2' });
    registry.register(versioned);
    expect(registry.listLive()[0]!.version).toBe('0.6.19-dev.2');
    registry.unregister(versioned.sessionId);

    // Pre-#539 entries carry no version; the field stays absent, not junk.
    registry.register(makeEntry({ sessionId: 'legacy-entry' }));
    const live = registry.listLive();
    expect(live).toHaveLength(1);
    expect(live[0]!.version).toBeUndefined();
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

  // Use high test ports to avoid conflicts with running remi instances
  const TEST_PORT_BASE = 44000 + Math.floor(Math.random() * 1000);

  test('findAvailablePort returns first port when no sessions', async () => {
    const port = await registry.findAvailablePort(TEST_PORT_BASE, 10);
    expect(port).toBe(TEST_PORT_BASE);
  });

  test('findAvailablePort skips used ports', async () => {
    registry.register(makeEntry({ sessionId: 'a', wsPort: TEST_PORT_BASE }));
    registry.register(makeEntry({ sessionId: 'b', wsPort: TEST_PORT_BASE + 1 }));

    const port = await registry.findAvailablePort(TEST_PORT_BASE, 10);
    expect(port).toBe(TEST_PORT_BASE + 2);
  });

  test('findAvailablePort fills non-contiguous gaps', async () => {
    registry.register(makeEntry({ sessionId: 'a', wsPort: TEST_PORT_BASE }));
    registry.register(makeEntry({ sessionId: 'b', wsPort: TEST_PORT_BASE + 2 }));

    const port = await registry.findAvailablePort(TEST_PORT_BASE, 10);
    expect(port).toBe(TEST_PORT_BASE + 1);
  });

  test('findAvailablePort returns null when all ports exhausted', async () => {
    for (let i = 0; i < 3; i++) {
      registry.register(makeEntry({ sessionId: `s-${i}`, wsPort: TEST_PORT_BASE + i }));
    }

    const port = await registry.findAvailablePort(TEST_PORT_BASE, 3);
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

  test('listLive skips entries with missing required fields', () => {
    // Write entries missing required fields directly to disk
    const missingSessionId = path.join(tmpDir, 'no-sid.json');
    fs.writeFileSync(missingSessionId, JSON.stringify({ pid: process.pid, wsPort: 18765 }));

    const missingPid = path.join(tmpDir, 'no-pid.json');
    fs.writeFileSync(missingPid, JSON.stringify({ sessionId: 'x', wsPort: 18765 }));

    const missingPort = path.join(tmpDir, 'no-port.json');
    fs.writeFileSync(missingPort, JSON.stringify({ sessionId: 'y', pid: process.pid }));

    const invalidPort = path.join(tmpDir, 'bad-port.json');
    fs.writeFileSync(
      invalidPort,
      JSON.stringify({ sessionId: 'z', pid: process.pid, wsPort: 99999 }),
    );

    const emptySessionId = path.join(tmpDir, 'empty-sid.json');
    fs.writeFileSync(
      emptySessionId,
      JSON.stringify({ sessionId: '', pid: process.pid, wsPort: 18765 }),
    );

    // All should be skipped
    expect(registry.listLive()).toEqual([]);
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

  // ---- projectPath normalization (#674) -----------------------------------

  describe('projectPath normalization', () => {
    test('tilde-form projectPath round-trips to an absolute normalized path', () => {
      registry.register(
        makeEntry({ sessionId: 'tilde', projectPath: '~/Documents/git/nemar/nemar-cli' }),
      );

      const live = registry.listLive();
      expect(live).toHaveLength(1);
      expect(live[0]!.projectPath).toBe(path.join(os.homedir(), 'Documents/git/nemar/nemar-cli'));
    });

    test('tilde-form and absolute-form registrations end up with an identical projectPath', () => {
      const absolutePath = path.join(os.homedir(), 'Documents/git/nemar/nemar-cli');
      registry.register(
        makeEntry({ sessionId: 'a', projectPath: '~/Documents/git/nemar/nemar-cli' }),
      );
      registry.register(makeEntry({ sessionId: 'b', projectPath: absolutePath }));

      const live = registry.listLive();
      const a = live.find((e) => e.sessionId === 'a');
      const b = live.find((e) => e.sessionId === 'b');
      expect(a!.projectPath).toBe(b!.projectPath);
    });

    test('setClaudeChildPid self-heals a legacy entry that still carries a raw tilde', () => {
      // A legacy entry written directly (bypassing register()'s
      // normalization) that still starts with `~` CAN be normalized on the
      // next patch, since patchEntry round-trips through register().
      fs.writeFileSync(
        path.join(tmpDir, 'legacy.json'),
        JSON.stringify(
          makeEntry({ sessionId: 'legacy', projectPath: '~/Documents/git/nemar/nemar-cli' }),
        ),
      );

      registry.setClaudeChildPid('legacy', 4242);

      const live = registry.listLive();
      expect(live).toHaveLength(1);
      expect(live[0]!.projectPath).toBe(path.join(os.homedir(), 'Documents/git/nemar/nemar-cli'));
      expect(live[0]!.claudeChildPid).toBe(4242);
    });

    test('setClaudeChildPid cannot un-concatenate an already-mangled projectPath', () => {
      // The exact malformed shape reported live (#674): once a `~` has been
      // concatenated mid-string onto another absolute path, the result no
      // longer starts with `~`, so normalizeProjectPath cannot recover it.
      // The guarantee is that FRESH projectPath values are normalized from now
      // on, not that this specific garbage string self-repairs.
      const malformed =
        '/Users/yahya/Documents/git/nemar/nemar-cli/~/Documents/git/nemar/nemar-cli';
      fs.writeFileSync(
        path.join(tmpDir, 'legacy.json'),
        JSON.stringify(makeEntry({ sessionId: 'legacy', projectPath: malformed })),
      );

      registry.setClaudeChildPid('legacy', 4242);

      const live = registry.listLive();
      expect(live).toHaveLength(1);
      expect(live[0]!.projectPath).toBe(malformed);
      expect(live[0]!.claudeChildPid).toBe(4242);
    });
  });

  // ---- Claude-child liveness (#451) ---------------------------------------

  describe('Claude child liveness', () => {
    test('claudeChildPid round-trips through register/list', () => {
      registry.register(makeEntry({ sessionId: 's', claudeChildPid: 4242 }));
      const live = registry.listLive();
      expect(live).toHaveLength(1);
      expect(live[0]!.claudeChildPid).toBe(4242);
    });

    test('legacy entry without the field parses and is treated as live', () => {
      // listLive keeps it (daemon pid alive); the liveness helper fail-safes.
      registry.register(makeEntry({ sessionId: 'legacy' }));
      const live = registry.listLive();
      expect(live).toHaveLength(1);
      expect(live[0]!.claudeChildPid).toBeUndefined();
      expect(claudeChildLooksAlive(live[0]!)).toBe(true);
    });

    test('listLive still keeps an entry whose daemon is alive but child is dead', async () => {
      // The whole point of #451: daemon-pid liveness is unchanged, so the
      // entry survives; the per-entry helper is what flips it to not-a-sibling.
      const childPid = await deadChildPid();
      registry.register(makeEntry({ sessionId: 'zombie', claudeChildPid: childPid }));
      const live = registry.listLive();
      expect(live).toHaveLength(1);
      expect(claudeChildLooksAlive(live[0]!)).toBe(false);
    });

    test('setClaudeChildPid preserves other fields (notably startedAt)', () => {
      const entry = makeEntry({ sessionId: 's', wsPort: 18767 });
      registry.register(entry);
      registry.setClaudeChildPid('s', 5150);
      const live = registry.listLive();
      expect(live[0]!.claudeChildPid).toBe(5150);
      expect(live[0]!.claudeChildExited).toBe(false);
      expect(live[0]!.startedAt).toBe(entry.startedAt);
      expect(live[0]!.wsPort).toBe(18767);
    });

    test('markClaudeChildExited keeps the entry but flags it not-alive (recycle-proof)', () => {
      // Use the CURRENT pid as the child pid: still alive, but the explicit
      // exited flag must override the pid probe so reuse cannot resurrect it.
      registry.register(makeEntry({ sessionId: 's', claudeChildPid: process.pid }));
      registry.markClaudeChildExited('s');
      const live = registry.listLive();
      expect(live).toHaveLength(1); // entry retained for ls/attach/resume
      expect(live[0]!.claudeChildExited).toBe(true);
      expect(claudeChildLooksAlive(live[0]!)).toBe(false);
    });

    test('patch methods are a no-op for a missing entry', () => {
      registry.setClaudeChildPid('ghost', 1);
      registry.markClaudeChildExited('ghost');
      expect(registry.listLive()).toHaveLength(0);
    });

    test('an entry with an invalid claudeChildPid is rejected by listLive', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({ ...makeEntry({ sessionId: 'bad' }), claudeChildPid: -3 }),
      );
      // Invalid entries are removed on read.
      expect(registry.listLive()).toHaveLength(0);
    });

    test('claudeChildLooksAlive: live pid → true, undefined → true, exited → false', () => {
      expect(claudeChildLooksAlive(makeEntry({ claudeChildPid: process.pid }))).toBe(true);
      expect(claudeChildLooksAlive(makeEntry())).toBe(true);
      expect(
        claudeChildLooksAlive(makeEntry({ claudeChildPid: process.pid, claudeChildExited: true })),
      ).toBe(false);
    });
  });
});
