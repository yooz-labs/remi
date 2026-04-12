/**
 * Tests for unified session resolution and discovery utilities.
 */

import { describe, expect, test } from 'bun:test';
import type { DiscoverableSession } from '@remi/shared';
import { generateId } from '@remi/shared';
import {
  AmbiguousSessionError,
  type DiscoveredEndpoint,
  type NetworkDiscoveryResult,
  type PortQueryResult,
  classifyQueryError,
  findEndpointsByHostname,
  getLocalAddresses,
  resolveSession,
} from '../../src/cli/session-resolver.ts';

function makeSession(name: string | undefined, id?: string): DiscoverableSession {
  return {
    sessionId: id ?? generateId(),
    name,
    projectPath: '/tmp/test',
    status: 'active',
    lastActivity: new Date().toISOString(),
    messageCount: 0,
    source: 'daemon',
    canAttach: true,
    canResume: false,
  };
}

function makeQueryResult(
  host: string,
  port: number,
  sessions: DiscoverableSession[],
): PortQueryResult {
  return { host, port, sessions };
}

function makeEndpoint(
  host: string,
  port: number,
  hostname: string,
  source: 'mdns' | 'vpn',
  name?: string,
): DiscoveredEndpoint {
  const base = { host, port, hostname, source };
  if (name !== undefined) return { ...base, name };
  return base;
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

  test('classifies "Failed to create session" as expected', () => {
    expect(
      classifyQueryError(
        'Daemon error: Failed to create session: Executable not found in $PATH: "claude"',
      ),
    ).toBe('expected');
  });

  test('classifies "No active session" as expected', () => {
    expect(classifyQueryError('Daemon error: No active session available')).toBe('expected');
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
    expect(resolved?.session.name).toBe('macbook/remi/main');
    expect(resolved?.port).toBe(18765);
    expect(resolved?.host).toBe('localhost');
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
    expect(resolved?.session.name).toBe('macbook/remi/main');
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

  test('throws AmbiguousSessionError on ambiguous exact name across ports', () => {
    const results = [
      makeQueryResult('localhost', 18765, [makeSession('my-session')]),
      makeQueryResult('localhost', 18766, [makeSession('my-session')]),
    ];
    expect(() => resolveSession(results, 'my-session')).toThrow(AmbiguousSessionError);
  });

  test('resolves exact ID match', () => {
    const id = 'abcdef12-3456-7890-abcd-ef1234567890';
    const results = [makeQueryResult('localhost', 18765, [makeSession('test-session', id)])];
    const resolved = resolveSession(results, id);
    expect(resolved).not.toBeNull();
    expect(resolved?.session.sessionId).toBe(id);
  });

  test('resolves prefix ID match', () => {
    const id = 'abcdef12-3456-7890-abcd-ef1234567890';
    const results = [makeQueryResult('localhost', 18765, [makeSession('test-session', id)])];
    const resolved = resolveSession(results, 'abcdef12');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.sessionId).toBe(id);
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
    expect(resolved?.port).toBe(18766);
  });

  test('prefers exact name over prefix name', () => {
    const results = [
      makeQueryResult('localhost', 18765, [makeSession('mac'), makeSession('macbook/remi/main')]),
    ];
    const resolved = resolveSession(results, 'mac');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.name).toBe('mac');
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
    expect(resolved?.session.name).toBe('myproject');
  });

  test('skips sessions with undefined name during name matching', () => {
    const id = 'abcd1234-5678-9012-abcd-ef1234567890';
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession(undefined, id),
        makeSession('named-session'),
      ]),
    ];
    // Should not match the undefined-name session by name
    const resolved = resolveSession(results, 'named-session');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.name).toBe('named-session');
  });

  test('resolves session with undefined name by ID', () => {
    const id = 'abcd1234-5678-9012-abcd-ef1234567890';
    const results = [makeQueryResult('localhost', 18765, [makeSession(undefined, id)])];
    const resolved = resolveSession(results, id);
    expect(resolved).not.toBeNull();
    expect(resolved?.session.sessionId).toBe(id);
  });

  // Strategy 5: Stripped name (hostname removed)
  test('resolves by stripped name (hostname prefix removed)', () => {
    const results = [makeQueryResult('localhost', 18765, [makeSession('yahyas-mcm:remi/develop')])];
    const resolved = resolveSession(results, 'remi/develop');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.name).toBe('yahyas-mcm:remi/develop');
  });

  test('resolves by stripped name prefix', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('yahyas-mcm:remi/develop'),
        makeSession('yahyas-mcm:other-project/main'),
      ]),
    ];
    const resolved = resolveSession(results, 'remi/dev');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.name).toBe('yahyas-mcm:remi/develop');
  });

  test('throws AmbiguousSessionError on ambiguous stripped name', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('host-a:remi/develop'),
        makeSession('host-b:remi/develop'),
      ]),
    ];
    expect(() => resolveSession(results, 'remi/develop')).toThrow(AmbiguousSessionError);
  });

  // Strategy 6: Branch segment match
  test('resolves by branch segment (after last slash)', () => {
    const results = [makeQueryResult('localhost', 18765, [makeSession('yahyas-mcm:remi/develop')])];
    const resolved = resolveSession(results, 'develop');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.name).toBe('yahyas-mcm:remi/develop');
  });

  test('resolves by branch segment prefix', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('yahyas-mcm:remi/285-bug-multiple-sessions'),
      ]),
    ];
    const resolved = resolveSession(results, '285-bug');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.name).toBe('yahyas-mcm:remi/285-bug-multiple-sessions');
  });

  test('throws AmbiguousSessionError on ambiguous branch segment', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('host:project-a/develop'),
        makeSession('host:project-b/develop'),
      ]),
    ];
    expect(() => resolveSession(results, 'develop')).toThrow(AmbiguousSessionError);
  });

  // Strategy 7: Contains match
  test('resolves by contains match', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('yahyas-mcm:remi/285-bug-multiple-sessions-in-same-directory-get-confused'),
      ]),
    ];
    const resolved = resolveSession(results, 'multiple-sessions');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.name).toBe(
      'yahyas-mcm:remi/285-bug-multiple-sessions-in-same-directory-get-confused',
    );
  });

  test('throws AmbiguousSessionError on ambiguous contains match', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('yahyas-mcm:remi/285-bug-sessions-a'),
        makeSession('yahyas-mcm:remi/285-bug-sessions-b'),
      ]),
    ];
    expect(() => resolveSession(results, '285-bug')).toThrow(AmbiguousSessionError);
  });

  test('contains match skips sessions with undefined name', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession(undefined),
        makeSession('yahyas-mcm:remi/feature-branch'),
      ]),
    ];
    const resolved = resolveSession(results, 'feature');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.name).toBe('yahyas-mcm:remi/feature-branch');
  });

  // Existing strategies still take priority
  test('exact name match takes priority over stripped name', () => {
    const results = [
      makeQueryResult('localhost', 18765, [
        makeSession('remi/develop'),
        makeSession('yahyas-mcm:remi/develop'),
      ]),
    ];
    // "remi/develop" is an exact name match for the first session
    const resolved = resolveSession(results, 'remi/develop');
    expect(resolved).not.toBeNull();
    expect(resolved?.session.name).toBe('remi/develop');
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

// ---------------------------------------------------------------------------
// findEndpointsByHostname
// ---------------------------------------------------------------------------

describe('findEndpointsByHostname', () => {
  const discovery: NetworkDiscoveryResult = {
    endpoints: [
      makeEndpoint('192.168.1.10', 18765, 'macbook', 'mdns', 'remi-macbook'),
      makeEndpoint('192.168.1.10', 18766, 'macbook', 'mdns', 'remi-macbook-2'),
      makeEndpoint('100.79.1.5', 18765, 'linux-server', 'vpn'),
      makeEndpoint('192.168.1.20', 18765, 'desktop', 'mdns', 'remi-desktop'),
    ],
  };

  test('returns matching endpoints by exact hostname', () => {
    const matches = findEndpointsByHostname(discovery, 'macbook');
    expect(matches).toHaveLength(2);
    expect(matches[0]?.port).toBe(18765);
    expect(matches[1]?.port).toBe(18766);
  });

  test('returns empty array for non-matching hostname', () => {
    const matches = findEndpointsByHostname(discovery, 'nonexistent');
    expect(matches).toHaveLength(0);
  });

  test('does not return partial hostname matches', () => {
    const matches = findEndpointsByHostname(discovery, 'mac');
    expect(matches).toHaveLength(0);
  });

  test('returns VPN endpoints', () => {
    const matches = findEndpointsByHostname(discovery, 'linux-server');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.source).toBe('vpn');
  });

  test('returns empty for empty discovery results', () => {
    const empty: NetworkDiscoveryResult = { endpoints: [] };
    const matches = findEndpointsByHostname(empty, 'macbook');
    expect(matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getLocalAddresses (mDNS self-filter foundation)
// ---------------------------------------------------------------------------

describe('getLocalAddresses', () => {
  test('includes loopback addresses', () => {
    const addrs = getLocalAddresses('test-host');
    expect(addrs.has('127.0.0.1')).toBe(true);
    expect(addrs.has('::1')).toBe(true);
    expect(addrs.has('localhost')).toBe(true);
  });

  test('includes the provided hostname', () => {
    const addrs = getLocalAddresses('my-machine');
    expect(addrs.has('my-machine')).toBe(true);
  });

  test('self-filter should use address only, not port', () => {
    // The mDNS self-filter uses localAddrs.has(d.host) without port checks.
    // Verify that a local address is filtered regardless of what port a daemon runs on.
    const addrs = getLocalAddresses('test-host');
    // If 127.0.0.1 is in the set, any daemon at 127.0.0.1 (any port) should be filtered.
    // This tests the contract that discoverNetworkDaemons relies on.
    expect(addrs.has('127.0.0.1')).toBe(true);
    // The set contains IPs, not host:port pairs, confirming port-independent filtering.
    expect(addrs.has('127.0.0.1:18765')).toBe(false);
    expect(addrs.has('127.0.0.1:18770')).toBe(false);
  });
});
