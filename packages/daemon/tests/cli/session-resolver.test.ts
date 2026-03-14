/**
 * Tests for unified session resolution and discovery utilities.
 */

import { describe, expect, test } from 'bun:test';
import type { DiscoverableSession } from '@remi/shared';
import { generateId } from '@remi/shared';
import {
  AmbiguousSessionError,
  type PortQueryResult,
  classifyQueryError,
  resolveSession,
} from '../../src/cli/session-resolver.ts';

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

function makeQueryResult(
  host: string,
  port: number,
  sessions: DiscoverableSession[],
): PortQueryResult {
  return { host, port, sessions };
}

// ---------------------------------------------------------------------------
// classifyQueryError
// ---------------------------------------------------------------------------

describe('classifyQueryError', () => {
  test('classifies "Cannot connect" as connection', () => {
    expect(classifyQueryError('Cannot connect to daemon at localhost:18765')).toBe('connection');
  });

  test('classifies "closed unexpectedly" as connection', () => {
    expect(classifyQueryError('Connection to daemon closed unexpectedly')).toBe('connection');
  });

  test('classifies "ECONNREFUSED" as connection', () => {
    expect(classifyQueryError('connect ECONNREFUSED 127.0.0.1:18765')).toBe('connection');
  });

  test('classifies "ECONNRESET" as connection', () => {
    expect(classifyQueryError('read ECONNRESET')).toBe('connection');
  });

  test('classifies "not found" as expected', () => {
    expect(classifyQueryError('Session not found')).toBe('expected');
  });

  test('classifies "ENOENT" as expected', () => {
    expect(classifyQueryError('ENOENT: no such file or directory')).toBe('expected');
  });

  test('classifies "SESSION_CREATE_FAILED" as expected', () => {
    expect(classifyQueryError('Daemon error: SESSION_CREATE_FAILED')).toBe('expected');
  });

  test('classifies unknown errors as unexpected', () => {
    expect(classifyQueryError('Something went wrong')).toBe('unexpected');
  });

  test('classifies timeout as unexpected', () => {
    expect(classifyQueryError('Timed out connecting to daemon')).toBe('unexpected');
  });

  test('classifies empty string as unexpected', () => {
    expect(classifyQueryError('')).toBe('unexpected');
  });
});

// ---------------------------------------------------------------------------
// resolveSession
// ---------------------------------------------------------------------------

describe('resolveSession', () => {
  test('resolves exact name match', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('macbook/remi/main'),
        makeSession('macbook/remi/dev'),
      ]),
    ];
    const resolved = resolveSession(results, 'macbook/remi/main');
    expect(resolved).not.toBeNull();
    expect(resolved!.session.name).toBe('macbook/remi/main');
    expect(resolved!.port).toBe(18765);
    expect(resolved!.host).toBe('localhost');
  });

  test('resolves prefix name match (single)', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('macbook/remi/main'),
        makeSession('macbook/other/dev'),
      ]),
    ];
    const resolved = resolveSession(results, 'macbook/remi');
    expect(resolved).not.toBeNull();
    expect(resolved!.session.name).toBe('macbook/remi/main');
  });

  test('throws AmbiguousSessionError on ambiguous name prefix', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('macbook/remi/main'),
        makeSession('macbook/remi/dev'),
      ]),
    ];
    expect(() => resolveSession(results, 'macbook/remi')).toThrow(AmbiguousSessionError);
  });

  test('resolves exact ID match', () => {
    const id = 'abcdef12-3456-7890-abcd-ef1234567890';
    const results = [makeQueryResult('localhost', 18765, [makeSession('test-session', id)])];
    const resolved = resolveSession(results, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.session.sessionId).toBe(id);
  });

  test('resolves prefix ID match', () => {
    const id = 'abcdef12-3456-7890-abcd-ef1234567890';
    const results = [makeQueryResult('localhost', 18765, [makeSession('test-session', id)])];
    const resolved = resolveSession(results, 'abcdef12');
    expect(resolved).not.toBeNull();
    expect(resolved!.session.sessionId).toBe(id);
  });

  test('throws AmbiguousSessionError on ambiguous ID prefix', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('session-a', 'abcdef12-1111-1111-1111-111111111111'),
        makeSession('session-b', 'abcdef12-2222-2222-2222-222222222222'),
      ]),
    ];
    expect(() => resolveSession(results, 'abcdef12')).toThrow(AmbiguousSessionError);
  });

  test('returns null when no match found', () => {
    const results = [makeQueryResult('localhost', 18765, [makeSession('macbook/remi/main')])];
    const resolved = resolveSession(results, 'nonexistent');
    expect(resolved).toBeNull();
  });

  test('returns null for empty results', () => {
    const resolved = resolveSession([], 'anything');
    expect(resolved).toBeNull();
  });

  test('returns null for results with no sessions', () => {
    const results = [makeQueryResult('localhost', 18765, [])];
    const resolved = resolveSession(results, 'anything');
    expect(resolved).toBeNull();
  });

  test('resolves across multiple port results', () => {
    const id = generateId();
    const results = [
      makeQueryResult('localhost', 18765, [makeSession('macbook/remi/main')]),
      makeQueryResult('localhost', 18766, [makeSession('macbook/other/dev', id)]),
    ];
    const resolved = resolveSession(results, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.port).toBe(18766);
  });

  test('prefers exact name over prefix name', () => {
    const results = [
      makeQueryResult('localhost', 18765, [makeSession('mac'), makeSession('macbook/remi/main')]),
    ];
    const resolved = resolveSession(results, 'mac');
    expect(resolved).not.toBeNull();
    expect(resolved!.session.name).toBe('mac');
  });

  test('prefers name match over ID match', () => {
    const id = 'myproject';
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('myproject', 'aaaa-1111'),
        makeSession('other', `${id}-suffix-session`),
      ]),
    ];
    const resolved = resolveSession(results, 'myproject');
    expect(resolved).not.toBeNull();
    expect(resolved!.session.name).toBe('myproject');
  });
});

// ---------------------------------------------------------------------------
// AmbiguousSessionError
// ---------------------------------------------------------------------------

describe('AmbiguousSessionError', () => {
  test('has correct name', () => {
    const err = new AmbiguousSessionError('test', [{ name: 'a', port: 1 }]);
    expect(err.name).toBe('AmbiguousSessionError');
  });

  test('includes match count in message', () => {
    const err = new AmbiguousSessionError('test', [
      { name: 'a', port: 1 },
      { name: 'b', port: 2 },
    ]);
    expect(err.message).toContain('matches 2 sessions');
  });

  test('preserves matches array', () => {
    const matches = [
      { name: 'a', port: 18765 },
      { name: 'b', port: 18766 },
    ];
    const err = new AmbiguousSessionError('test', matches);
    expect(err.matches).toEqual(matches);
  });

  test('includes disambiguation hint', () => {
    const err = new AmbiguousSessionError('test', [{ name: 'a', port: 1 }]);
    expect(err.message).toContain('disambiguate');
  });
});
