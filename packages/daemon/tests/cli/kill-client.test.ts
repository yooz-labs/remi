/**
 * Tests for kill-client session resolution logic.
 *
 * These tests verify the session name/ID resolution used by `remi kill`,
 * now delegated to the shared resolveSession utility.
 */

import { describe, expect, test } from 'bun:test';
import type { DiscoverableSession } from '@remi/shared';
import { generateId } from '@remi/shared';
import { type PortQueryResult, resolveSession } from '../../src/cli/session-resolver.ts';

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

function wrapSessions(sessions: DiscoverableSession[]): PortQueryResult[] {
  return [{ host: 'localhost', port: 18765, sessions }];
}

describe('kill-client session resolution (via shared resolver)', () => {
  test('resolves exact name match', () => {
    const sessions = [makeSession('macbook/remi/main'), makeSession('macbook/remi/dev')];
    const result = resolveSession(wrapSessions(sessions), 'macbook/remi/main');
    expect(result?.session.name).toBe('macbook/remi/main');
  });

  test('resolves prefix name match', () => {
    const sessions = [makeSession('macbook/remi/main'), makeSession('macbook/other/dev')];
    const result = resolveSession(wrapSessions(sessions), 'macbook/remi');
    expect(result?.session.name).toBe('macbook/remi/main');
  });

  test('throws on ambiguous name prefix', () => {
    const sessions = [makeSession('macbook/remi/main'), makeSession('macbook/remi/dev')];
    expect(() => resolveSession(wrapSessions(sessions), 'macbook/remi')).toThrow('Ambiguous');
  });

  test('resolves exact ID match', () => {
    const id = generateId();
    const sessions = [makeSession('test-session', id)];
    const result = resolveSession(wrapSessions(sessions), id);
    expect(result?.session.sessionId).toBe(id);
  });

  test('resolves prefix ID match', () => {
    const id = 'abcdef12-3456-7890-abcd-ef1234567890';
    const sessions = [makeSession('test-session', id)];
    const result = resolveSession(wrapSessions(sessions), 'abcdef12');
    expect(result?.session.sessionId).toBe(id);
  });

  test('returns null for no match', () => {
    const sessions = [makeSession('macbook/remi/main')];
    const result = resolveSession(wrapSessions(sessions), 'nonexistent');
    expect(result).toBeNull();
  });

  test('returns null for empty session list', () => {
    const result = resolveSession(wrapSessions([]), 'anything');
    expect(result).toBeNull();
  });
});
