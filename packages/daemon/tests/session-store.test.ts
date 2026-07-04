import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { normalizeProjectPath } from '../src/cli/path-resolver.ts';
import { SessionStore, type StoredSession } from '../src/session/session-store.ts';

function makeTmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-test-'));
  return path.join(dir, 'sessions.json');
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    remiSessionId: crypto.randomUUID() as UUID,
    claudeSessionId: null,
    projectPath: '/tmp/project',
    port: 18765,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
    ...overrides,
  };
}

describe('SessionStore', () => {
  let filePath: string;
  let store: SessionStore;

  beforeEach(() => {
    filePath = makeTmpPath();
    store = new SessionStore(filePath);
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(filePath), { recursive: true });
    } catch {
      // ignore
    }
  });

  test('list returns empty array when no file exists', () => {
    expect(store.list()).toEqual([]);
  });

  test('save and list round-trips a session', () => {
    const session = makeSession();
    store.save(session);
    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.remiSessionId).toBe(session.remiSessionId);
  });

  test('save updates existing session by remiSessionId', () => {
    const session = makeSession();
    store.save(session);
    const updated = { ...session, claudeSessionId: 'claude-123' };
    store.save(updated);
    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.claudeSessionId).toBe('claude-123');
  });

  test('list returns most recent first', () => {
    const older = makeSession({ startedAt: '2025-01-01T00:00:00Z' });
    const newer = makeSession({ startedAt: '2025-06-01T00:00:00Z' });
    store.save(older);
    store.save(newer);
    const sessions = store.list();
    expect(sessions[0]?.remiSessionId).toBe(newer.remiSessionId);
    expect(sessions[1]?.remiSessionId).toBe(older.remiSessionId);
  });

  test('findByClaudeSessionId returns matching session', () => {
    const session = makeSession({ claudeSessionId: 'claude-abc' });
    store.save(session);
    const found = store.findByClaudeSessionId('claude-abc');
    expect(found).not.toBeNull();
    expect(found?.remiSessionId).toBe(session.remiSessionId);
  });

  test('findByClaudeSessionId returns null when not found', () => {
    expect(store.findByClaudeSessionId('nonexistent')).toBeNull();
  });

  test('findByRemiSessionId returns matching session', () => {
    const session = makeSession();
    store.save(session);
    const found = store.findByRemiSessionId(session.remiSessionId);
    expect(found).not.toBeNull();
    expect(found?.remiSessionId).toBe(session.remiSessionId);
  });

  test('getMostRecent returns latest session', () => {
    const older = makeSession({ startedAt: '2025-01-01T00:00:00Z' });
    const newer = makeSession({ startedAt: '2025-06-01T00:00:00Z' });
    store.save(older);
    store.save(newer);
    const recent = store.getMostRecent();
    expect(recent?.remiSessionId).toBe(newer.remiSessionId);
  });

  test('getMostRecent returns null when empty', () => {
    expect(store.getMostRecent()).toBeNull();
  });

  test('markExited sets exitedAt and exitCode', () => {
    const session = makeSession();
    store.save(session);
    store.markExited(session.remiSessionId, 0);
    const found = store.findByRemiSessionId(session.remiSessionId);
    expect(found?.exitedAt).not.toBeNull();
    expect(found?.exitCode).toBe(0);
  });

  test('markExited is a no-op for unknown session', () => {
    store.markExited('nonexistent' as UUID, 1);
    expect(store.list()).toEqual([]);
  });

  test('updateClaudeSessionId updates the field', () => {
    const session = makeSession();
    store.save(session);
    store.updateClaudeSessionId(session.remiSessionId, 'claude-xyz');
    const found = store.findByRemiSessionId(session.remiSessionId);
    expect(found?.claudeSessionId).toBe('claude-xyz');
  });

  test('handles corrupt JSON gracefully', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'not json', 'utf-8');
    expect(store.list()).toEqual([]);
    // Can still save after corruption
    const session = makeSession();
    store.save(session);
    expect(store.list()).toHaveLength(1);
  });

  test('handles wrong version gracefully', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 99, sessions: [] }), 'utf-8');
    expect(store.list()).toEqual([]);
  });

  test('trims oldest exited sessions when over limit', () => {
    // Create a store that uses the default MAX_SESSIONS (100)
    // We test with a smaller set by filling 101 sessions
    // Use recent dates so purgeStale doesn't remove them as old
    const now = Date.now();
    const sessions: StoredSession[] = [];
    for (let i = 0; i < 101; i++) {
      const s = makeSession({
        startedAt: new Date(now - (101 - i) * 60_000).toISOString(),
        exitedAt: i < 50 ? new Date(now - (100 - i) * 60_000).toISOString() : null,
        exitCode: i < 50 ? 0 : null,
      });
      sessions.push(s);
    }
    for (const s of sessions) {
      store.save(s);
    }
    const result = store.list();
    expect(result.length).toBe(100);
  });

  test('purgeStale marks sessions with dead PIDs as exited', () => {
    // PID 999999 is almost certainly not running
    const stale = makeSession({ pid: 999999 });
    store.save(stale);
    const changed = store.purgeStale();
    expect(changed).toBe(true);
    const found = store.findByRemiSessionId(stale.remiSessionId);
    expect(found?.exitedAt).not.toBeNull();
    expect(found?.exitCode).toBeNull();
  });

  test('purgeStale marks sessions with null PID (legacy) as exited', () => {
    const legacy = makeSession({ pid: null });
    store.save(legacy);
    const changed = store.purgeStale();
    expect(changed).toBe(true);
    const found = store.findByRemiSessionId(legacy.remiSessionId);
    expect(found?.exitedAt).not.toBeNull();
  });

  test('purgeStale does not touch sessions with alive PIDs', () => {
    // process.pid is always alive
    const alive = makeSession({ pid: process.pid });
    store.save(alive);
    const changed = store.purgeStale();
    expect(changed).toBe(false);
    const found = store.findByRemiSessionId(alive.remiSessionId);
    expect(found?.exitedAt).toBeNull();
  });

  test('purgeStale does not touch already-exited sessions', () => {
    const exited = makeSession({
      pid: 999999,
      exitedAt: new Date().toISOString(),
      exitCode: 0,
    });
    store.save(exited);
    const changed = store.purgeStale();
    expect(changed).toBe(false);
  });

  test('purgeStale removes exited sessions older than 7 days', () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const old = makeSession({
      exitedAt: oldDate,
      exitCode: 0,
    });
    store.save(old);
    const changed = store.purgeStale();
    expect(changed).toBe(true);
    expect(store.findByRemiSessionId(old.remiSessionId)).toBeNull();
  });

  test('purgeStale keeps recent exited sessions', () => {
    const recent = makeSession({
      exitedAt: new Date().toISOString(),
      exitCode: 0,
    });
    store.save(recent);
    const changed = store.purgeStale();
    expect(changed).toBe(false);
    expect(store.findByRemiSessionId(recent.remiSessionId)).not.toBeNull();
  });

  test('list auto-purges stale sessions', () => {
    const stale = makeSession({ pid: 999999 });
    const alive = makeSession({ pid: process.pid });
    store.save(stale);
    store.save(alive);
    const sessions = store.list();
    // Both still in list, but stale one is now marked exited
    expect(sessions).toHaveLength(2);
    const staleSession = sessions.find((s) => s.remiSessionId === stale.remiSessionId);
    const aliveSession = sessions.find((s) => s.remiSessionId === alive.remiSessionId);
    expect(staleSession?.exitedAt).not.toBeNull();
    expect(aliveSession?.exitedAt).toBeNull();
  });

  describe('projectPath normalization (#680)', () => {
    test('save normalizes a tilde-form projectPath before persisting', () => {
      const session = makeSession({ projectPath: '~/Documents/git/nemar/nemar-cli' });
      store.save(session);
      const found = store.findByRemiSessionId(session.remiSessionId);
      expect(found?.projectPath).toBe(path.join(os.homedir(), 'Documents/git/nemar/nemar-cli'));
    });

    test('tilde-form and absolute-form saves converge to the same projectPath', () => {
      const tilde = makeSession({ projectPath: '~/Documents/git/nemar/nemar-cli' });
      const absolute = makeSession({
        projectPath: path.join(os.homedir(), 'Documents/git/nemar/nemar-cli'),
      });
      store.save(tilde);
      store.save(absolute);
      const foundTilde = store.findByRemiSessionId(tilde.remiSessionId);
      const foundAbsolute = store.findByRemiSessionId(absolute.remiSessionId);
      expect(foundTilde?.projectPath).toBe(foundAbsolute?.projectPath ?? '');
    });

    test('reading a legacy raw-tilde entry off disk self-heals projectPath', () => {
      // Write a pre-#680 entry directly to disk, bypassing save()'s
      // normalization, to simulate a value written by an older binary.
      const legacy: StoredSession = makeSession({
        projectPath: '~/Documents/git/nemar/nemar-cli',
      });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: 1, sessions: [legacy] }, null, 2),
        'utf-8',
      );

      const found = store.findByRemiSessionId(legacy.remiSessionId);
      expect(found?.projectPath).toBe(normalizeProjectPath(legacy.projectPath));

      const listed = store.list();
      expect(listed[0]?.projectPath).toBe(normalizeProjectPath(legacy.projectPath));

      const recent = store.getMostRecent();
      expect(recent?.projectPath).toBe(normalizeProjectPath(legacy.projectPath));
    });

    test('self-healed projectPath is persisted on the next write', () => {
      const legacy: StoredSession = makeSession({
        projectPath: '~/Documents/git/nemar/nemar-cli',
      });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: 1, sessions: [legacy] }, null, 2),
        'utf-8',
      );

      store.markExited(legacy.remiSessionId, 0);

      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        sessions: StoredSession[];
      };
      expect(raw.sessions[0]?.projectPath).toBe(normalizeProjectPath(legacy.projectPath));
    });
  });
});
