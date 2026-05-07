import { describe, expect, test } from 'bun:test';
import { type DiscoverableSession, type UUID, now } from '@remi/shared';
import { type DetachCommandHelpers, runDetachCommand } from '../../src/cli/cmd-detach.ts';
import type { PortQueryResult } from '../../src/cli/session-resolver.ts';
import type { ResolvedTarget } from '../../src/cli/target-resolver.ts';

function makeSession(overrides: Partial<DiscoverableSession> = {}): DiscoverableSession {
  return {
    sessionId: 'SES-DEFAULT' as UUID,
    projectPath: '/tmp/fake',
    status: 'active',
    lastActivity: now(),
    messageCount: 0,
    source: 'daemon',
    canAttach: true,
    canResume: false,
    ...overrides,
  };
}

function makeIO() {
  const err: string[] = [];
  return { io: { err: (m: string) => err.push(m) }, err };
}

function mkTarget(overrides: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return { host: 'localhost', port: 18765, targetId: 'my-session', ...overrides };
}

type Call =
  | { fn: 'queryMultiplePorts'; args: { ports: number[]; host: string } }
  | { fn: 'resolveSession'; args: { target: string; resultCount: number } }
  | { fn: 'getDefaultPortRange' }
  | { fn: 'runDetachClient'; args: { host: string; port: number; target: string } };

interface HelpersOptions {
  readonly livePorts?: number[];
  readonly queryResults?: readonly PortQueryResult[];
  readonly resolvedSession?: {
    port: number;
    sessionId: UUID;
    name?: string;
  } | null;
  readonly defaultPortRange?: number[];
  readonly throwOnDetach?: boolean;
}

function makeHelpersAndDeps(opts: HelpersOptions = {}) {
  const calls: Call[] = [];
  const helpers: DetachCommandHelpers = {
    queryMultiplePorts: async (args) => {
      calls.push({ fn: 'queryMultiplePorts', args: { ports: [...args.ports], host: args.host } });
      return opts.queryResults ?? [];
    },
    resolveSession: (results, target) => {
      calls.push({ fn: 'resolveSession', args: { target, resultCount: results.length } });
      if (!opts.resolvedSession) return null;
      const fake = makeSession({
        sessionId: opts.resolvedSession.sessionId,
        name: opts.resolvedSession.name ?? 'resolved',
      });
      return { session: fake, port: opts.resolvedSession.port, host: 'localhost' };
    },
    getDefaultPortRange: () => {
      calls.push({ fn: 'getDefaultPortRange' });
      return opts.defaultPortRange ?? [18765, 18766];
    },
    runDetachClient: async (args) => {
      calls.push({ fn: 'runDetachClient', args });
      if (opts.throwOnDetach) throw new Error('detach failed');
    },
  };
  const deps = {
    getLivePorts: () => opts.livePorts ?? [],
    explicitPort: undefined as number | undefined,
  };
  return { helpers, deps, calls };
}

describe('runDetachCommand', () => {
  test('prints usage and returns 1 when target id is missing', async () => {
    const { io, err } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps();
    const code = await runDetachCommand(
      mkTarget({ targetId: undefined }),
      deps,
      io,
      async () => helpers,
    );
    expect(code).toBe(1);
    expect(err[0]).toBe('Usage: remi detach <session-name-or-id>');
    expect(err.some((m) => m.includes('Run `remi ls` to see live sessions.'))).toBe(true);
    expect(calls).toHaveLength(0); // no helpers called when usage fails
  });

  test('explicit port skips multi-port resolution', async () => {
    const { io } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps();
    const deps2 = { ...deps, explicitPort: 18800 };
    const code = await runDetachCommand(mkTarget({ port: 18800 }), deps2, io, async () => helpers);
    expect(code).toBe(0);
    expect(calls.map((c) => c.fn)).toEqual(['runDetachClient']);
    expect(calls[0]).toEqual({
      fn: 'runDetachClient',
      args: { host: 'localhost', port: 18800, target: 'my-session' },
    });
  });

  test('non-localhost skips multi-port resolution even without explicit port', async () => {
    const { io } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps();
    const code = await runDetachCommand(
      mkTarget({ host: 'remote.example', port: 18900 }),
      deps,
      io,
      async () => helpers,
    );
    expect(code).toBe(0);
    expect(calls.map((c) => c.fn)).toEqual(['runDetachClient']);
    expect(calls[0]).toEqual({
      fn: 'runDetachClient',
      args: { host: 'remote.example', port: 18900, target: 'my-session' },
    });
  });

  test('uses live registry ports first for localhost multi-port resolution', async () => {
    const { io } = makeIO();
    const fakeSession = makeSession({
      sessionId: 'SES-ABC-123' as UUID,
      name: 'my-session',
    });
    const { helpers, deps, calls } = makeHelpersAndDeps({
      livePorts: [18765, 18766],
      queryResults: [{ port: 18766, host: 'localhost', sessions: [fakeSession] }],
      resolvedSession: { port: 18766, sessionId: 'SES-ABC-123' as UUID, name: 'my-session' },
    });
    const code = await runDetachCommand(mkTarget(), deps, io, async () => helpers);
    expect(code).toBe(0);
    expect(calls.map((c) => c.fn)).toEqual([
      'queryMultiplePorts',
      'resolveSession',
      'runDetachClient',
    ]);
    const detach = calls[2];
    expect(detach).toEqual({
      fn: 'runDetachClient',
      args: { host: 'localhost', port: 18766, target: 'SES-ABC-123' },
    });
  });

  test('falls back to getDefaultPortRange when registry is empty', async () => {
    const { io } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps({
      livePorts: [],
      defaultPortRange: [18765, 18766, 18767],
      queryResults: [],
    });
    const code = await runDetachCommand(mkTarget(), deps, io, async () => helpers);
    // Empty queryResults -> "cannot reach any" error -> exit 1
    expect(code).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['getDefaultPortRange', 'queryMultiplePorts']);
    const query = calls[1];
    expect((query as { args: { ports: number[] } }).args.ports).toEqual([18765, 18766, 18767]);
  });

  test('prints "Cannot reach any" when query returns zero results', async () => {
    const { io, err } = makeIO();
    const { helpers, deps } = makeHelpersAndDeps({
      livePorts: [18765, 18766],
      queryResults: [],
    });
    const code = await runDetachCommand(mkTarget(), deps, io, async () => helpers);
    expect(code).toBe(1);
    expect(err[0]).toBe('Cannot reach any remi daemon (tried 2 port(s)). Is a daemon running?');
  });

  test('if no live ports and no default range, skip multi-port and fall through', async () => {
    // Both registry and defaults empty -> skip the block, go straight to detach.
    const { io } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps({
      livePorts: [],
      defaultPortRange: [],
    });
    const code = await runDetachCommand(mkTarget(), deps, io, async () => helpers);
    expect(code).toBe(0);
    expect(calls.map((c) => c.fn)).toEqual(['getDefaultPortRange', 'runDetachClient']);
  });

  test('detach errors are caught, printed to stderr, exit 1', async () => {
    const { io, err } = makeIO();
    const { helpers, deps } = makeHelpersAndDeps({
      livePorts: [18765],
      queryResults: [],
      throwOnDetach: true,
    });
    const deps2 = { ...deps, explicitPort: 18800 };
    const code = await runDetachCommand(mkTarget({ port: 18800 }), deps2, io, async () => helpers);
    expect(code).toBe(1);
    expect(err).toEqual(['detach failed']);
  });

  test('unresolved session in query results still attempts detach on original port', async () => {
    const { io } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps({
      livePorts: [18765, 18766],
      queryResults: [{ port: 18765, host: 'localhost', sessions: [] }],
      resolvedSession: null, // resolveSession returns null (session not found)
    });
    const code = await runDetachCommand(mkTarget(), deps, io, async () => helpers);
    // Falls through to detach with the original target (from ResolvedTarget)
    expect(code).toBe(0);
    const detach = calls[calls.length - 1];
    expect(detach).toEqual({
      fn: 'runDetachClient',
      args: { host: 'localhost', port: 18765, target: 'my-session' },
    });
  });
});
