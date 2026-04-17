import { describe, expect, test } from 'bun:test';
import { type UUID, now } from '@remi/shared';
import {
  type LocalSessionResolution,
  resolveLocalSession,
} from '../../src/cli/resolve-local-session.ts';
import type { PortQueryResult } from '../../src/cli/session-resolver.ts';

function fakeSession(sessionId: UUID, name: string) {
  return {
    sessionId,
    name,
    projectPath: '/tmp/fake',
    status: 'active' as const,
    lastActivity: now(),
    messageCount: 0,
    source: 'daemon' as const,
    canAttach: true,
    canResume: false,
  };
}

interface DepsOptions {
  readonly livePorts?: number[];
  readonly defaultPortRange?: number[];
  readonly queryResults?: readonly PortQueryResult[];
  readonly resolvedMatch?: { port: number; sessionId: UUID; name: string } | null;
}

function makeDeps(opts: DepsOptions = {}) {
  const calls: Array<{ fn: string; args?: unknown }> = [];
  return {
    calls,
    deps: {
      getLivePorts: () => {
        calls.push({ fn: 'getLivePorts' });
        return opts.livePorts ?? [];
      },
      getDefaultPortRange: () => {
        calls.push({ fn: 'getDefaultPortRange' });
        return opts.defaultPortRange ?? [18765, 18766];
      },
      queryMultiplePorts: async (args: unknown) => {
        calls.push({ fn: 'queryMultiplePorts', args });
        return opts.queryResults ?? [];
      },
      resolveSession: (_results: unknown, target: string) => {
        calls.push({ fn: 'resolveSession', args: { target } });
        if (!opts.resolvedMatch) return null;
        return {
          session: fakeSession(opts.resolvedMatch.sessionId, opts.resolvedMatch.name),
          port: opts.resolvedMatch.port,
          host: 'localhost',
        };
      },
    },
  };
}

describe('resolveLocalSession', () => {
  test('returns no-ports when registry and default range are both empty', async () => {
    const { deps, calls } = makeDeps({ livePorts: [], defaultPortRange: [] });
    const result = await resolveLocalSession({ target: 'abc', logLabel: 'kill' }, deps);
    expect(result).toEqual({ status: 'no-ports' });
    expect(calls.map((c) => c.fn)).toEqual(['getLivePorts', 'getDefaultPortRange']);
  });

  test('uses live ports first, skips default fallback when available', async () => {
    const { deps, calls } = makeDeps({
      livePorts: [18765, 18766],
      queryResults: [],
    });
    const result = await resolveLocalSession({ target: 'abc', logLabel: 'kill' }, deps);
    expect((result as LocalSessionResolution).status).toBe('no-daemons');
    expect(calls.map((c) => c.fn)).toEqual(['getLivePorts', 'queryMultiplePorts']);
  });

  test('falls back to default port range when registry is empty', async () => {
    const { deps, calls } = makeDeps({
      livePorts: [],
      defaultPortRange: [18765, 18766, 18767],
      queryResults: [],
    });
    await resolveLocalSession({ target: 'abc', logLabel: 'kill' }, deps);
    expect(calls.map((c) => c.fn)).toEqual([
      'getLivePorts',
      'getDefaultPortRange',
      'queryMultiplePorts',
    ]);
    expect((calls[2]?.args as { ports: number[] }).ports).toEqual([18765, 18766, 18767]);
  });

  test('returns no-daemons when query returns zero results, with probed count', async () => {
    const { deps } = makeDeps({
      livePorts: [18765, 18766, 18767],
      queryResults: [],
    });
    const result = await resolveLocalSession({ target: 'abc', logLabel: 'kill' }, deps);
    expect(result).toEqual({ status: 'no-daemons', probedCount: 3 });
  });

  test('returns resolved when resolveSession finds a match, with session id not name', async () => {
    const fake: PortQueryResult = {
      port: 18766,
      host: 'localhost',
      sessions: [fakeSession('SES-REAL-123' as UUID, 'my-session')],
    };
    const { deps } = makeDeps({
      livePorts: [18765, 18766],
      queryResults: [fake],
      resolvedMatch: { port: 18766, sessionId: 'SES-REAL-123' as UUID, name: 'my-session' },
    });
    const result = await resolveLocalSession({ target: 'my-session', logLabel: 'kill' }, deps);
    expect(result).toEqual({
      status: 'resolved',
      port: 18766,
      // Use session ID directly to avoid TOCTOU race
      target: 'SES-REAL-123',
    });
  });

  test('returns unresolved when query yields daemons but no session matches', async () => {
    const fake: PortQueryResult = {
      port: 18765,
      host: 'localhost',
      sessions: [fakeSession('SES-OTHER' as UUID, 'other-session')],
    };
    const { deps } = makeDeps({
      livePorts: [18765],
      queryResults: [fake],
      resolvedMatch: null,
    });
    const result = await resolveLocalSession({ target: 'missing', logLabel: 'detach' }, deps);
    expect(result).toEqual({ status: 'unresolved' });
  });

  test('forwards logLabel and timeoutMs to queryMultiplePorts', async () => {
    const { deps, calls } = makeDeps({
      livePorts: [18765],
      queryResults: [],
    });
    await resolveLocalSession({ target: 'abc', logLabel: 'detach', timeoutMs: 2500 }, deps);
    const queryCall = calls.find((c) => c.fn === 'queryMultiplePorts');
    expect((queryCall?.args as { logLabel: string; timeoutMs: number }).logLabel).toBe('detach');
    expect((queryCall?.args as { logLabel: string; timeoutMs: number }).timeoutMs).toBe(2500);
  });

  test('defaults timeout to 5000 ms', async () => {
    const { deps, calls } = makeDeps({
      livePorts: [18765],
      queryResults: [],
    });
    await resolveLocalSession({ target: 'abc', logLabel: 'kill' }, deps);
    const queryCall = calls.find((c) => c.fn === 'queryMultiplePorts');
    expect((queryCall?.args as { timeoutMs: number }).timeoutMs).toBe(5000);
  });
});
