/**
 * Tests for kill-client session resolution logic.
 *
 * These tests verify the session name/ID resolution used by `remi kill`.
 * The actual WebSocket communication is tested via integration tests.
 */

import { describe, expect, test } from 'bun:test';
import type { DiscoverableSession } from '@remi/shared';
import { generateId } from '@remi/shared';

// Extract the resolution logic for unit testing
function resolveSession(
  sessionList: DiscoverableSession[],
  nameOrId: string,
): DiscoverableSession | null {
  // Exact name match
  const byName = sessionList.filter((s) => s.name === nameOrId);
  if (byName.length === 1) return byName[0] ?? null;

  // Prefix name match
  const byPrefix = sessionList.filter((s) => s.name?.startsWith(nameOrId));
  if (byPrefix.length === 1) return byPrefix[0] ?? null;
  if (byPrefix.length > 1) {
    throw new Error(`Ambiguous session name "${nameOrId}"`);
  }

  // Exact ID match
  const byId = sessionList.filter((s) => s.sessionId === nameOrId);
  if (byId.length === 1) return byId[0] ?? null;

  // Prefix ID match
  const byIdPrefix = sessionList.filter((s) => s.sessionId.startsWith(nameOrId));
  if (byIdPrefix.length === 1) return byIdPrefix[0] ?? null;
  if (byIdPrefix.length > 1) {
    throw new Error(`Ambiguous session ID "${nameOrId}"`);
  }

  return null;
}

function makeSession(name: string, id?: string): DiscoverableSession {
  return {
    sessionId: id ?? generateId(),
    name,
    projectPath: '/tmp/test',
    status: 'active',
    lastActivity: new Date().toISOString(),
    messageCount: 0,
    source: 'daemon',
    canAttach: true,
  };
}

describe('kill-client session resolution', () => {
  test('resolves exact name match', () => {
    const sessions = [makeSession('macbook/remi/main'), makeSession('macbook/remi/dev')];
    const result = resolveSession(sessions, 'macbook/remi/main');
    expect(result?.name).toBe('macbook/remi/main');
  });

  test('resolves prefix name match', () => {
    const sessions = [makeSession('macbook/remi/main'), makeSession('macbook/other/dev')];
    const result = resolveSession(sessions, 'macbook/remi');
    expect(result?.name).toBe('macbook/remi/main');
  });

  test('throws on ambiguous name prefix', () => {
    const sessions = [makeSession('macbook/remi/main'), makeSession('macbook/remi/dev')];
    expect(() => resolveSession(sessions, 'macbook/remi')).toThrow('Ambiguous');
  });

  test('resolves exact ID match', () => {
    const id = generateId();
    const sessions = [makeSession('test-session', id)];
    const result = resolveSession(sessions, id);
    expect(result?.sessionId).toBe(id);
  });

  test('resolves prefix ID match', () => {
    const id = 'abcdef12-3456-7890-abcd-ef1234567890';
    const sessions = [makeSession('test-session', id)];
    const result = resolveSession(sessions, 'abcdef12');
    expect(result?.sessionId).toBe(id);
  });

  test('returns null for no match', () => {
    const sessions = [makeSession('macbook/remi/main')];
    const result = resolveSession(sessions, 'nonexistent');
    expect(result).toBeNull();
  });

  test('returns null for empty session list', () => {
    const result = resolveSession([], 'anything');
    expect(result).toBeNull();
  });
});
