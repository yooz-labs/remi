import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
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
    const sessions: StoredSession[] = [];
    for (let i = 0; i < 101; i++) {
      const s = makeSession({
        startedAt: new Date(2025, 0, 1 + i).toISOString(),
        exitedAt: i < 50 ? new Date(2025, 0, 2 + i).toISOString() : null,
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
});
