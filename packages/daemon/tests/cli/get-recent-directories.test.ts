import { describe, expect, test } from 'bun:test';
import { getRecentDirectories } from '../../src/cli/recent-client.ts';
import type { SessionStore } from '../../src/session/session-store.ts';

function makeStore(sessions: Array<{ projectPath: string; startedAt: string }>): SessionStore {
  return { list: () => sessions } as unknown as SessionStore;
}

describe('getRecentDirectories', () => {
  test('returns empty list when store has no sessions', () => {
    expect(getRecentDirectories(makeStore([]), 20)).toEqual([]);
  });

  test('groups sessions by projectPath and counts them', () => {
    const store = makeStore([
      { projectPath: '/tmp/proj-a', startedAt: '2026-04-17T10:00:00Z' },
      { projectPath: '/tmp/proj-a', startedAt: '2026-04-17T12:00:00Z' },
      { projectPath: '/tmp/proj-b', startedAt: '2026-04-17T11:00:00Z' },
    ]);
    const result = getRecentDirectories(store, 20);
    const byDir = new Map(result.map((r) => [r.directory, r]));
    expect(byDir.get('/tmp/proj-a')?.sessionCount).toBe(2);
    expect(byDir.get('/tmp/proj-b')?.sessionCount).toBe(1);
  });

  test('uses the most recent startedAt as lastUsed per directory', () => {
    const store = makeStore([
      { projectPath: '/tmp/proj', startedAt: '2026-04-17T10:00:00Z' },
      { projectPath: '/tmp/proj', startedAt: '2026-04-17T14:00:00Z' },
      { projectPath: '/tmp/proj', startedAt: '2026-04-17T12:00:00Z' },
    ]);
    const result = getRecentDirectories(store, 20);
    expect(result[0]?.lastUsed).toBe('2026-04-17T14:00:00Z');
  });

  test('sorts by lastUsed descending', () => {
    const store = makeStore([
      { projectPath: '/tmp/old', startedAt: '2026-04-10T10:00:00Z' },
      { projectPath: '/tmp/new', startedAt: '2026-04-17T10:00:00Z' },
      { projectPath: '/tmp/mid', startedAt: '2026-04-15T10:00:00Z' },
    ]);
    const result = getRecentDirectories(store, 20);
    expect(result.map((r) => r.directory)).toEqual(['/tmp/new', '/tmp/mid', '/tmp/old']);
  });

  test('enforces the limit argument', () => {
    const store = makeStore(
      Array.from({ length: 25 }, (_, i) => ({
        projectPath: `/tmp/proj-${i}`,
        startedAt: `2026-04-17T${String(i).padStart(2, '0')}:00:00Z`,
      })),
    );
    expect(getRecentDirectories(store, 20).length).toBe(20);
    expect(getRecentDirectories(store, 5).length).toBe(5);
  });

  test('derives displayName from the path basename', () => {
    const store = makeStore([
      { projectPath: '/Users/yahya/projects/remi', startedAt: '2026-04-17T00:00:00Z' },
    ]);
    const result = getRecentDirectories(store, 20);
    expect(result[0]?.displayName).toBe('remi');
  });
});
