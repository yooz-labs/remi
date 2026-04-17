import { describe, expect, test } from 'bun:test';
import { type DiscoverableSession, type UUID, now } from '@remi/shared';
import { type KillCommandHelpers, runKillCommand } from '../../src/cli/cmd-kill.ts';
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
  | { fn: 'resolveSession'; args: { target: string } }
  | { fn: 'getDefaultPortRange' }
  | { fn: 'runKillClient'; args: { host: string; port: number; target: string } };

interface HelpersOptions {
  readonly livePorts?: number[];
  readonly queryResults?: readonly PortQueryResult[];
  readonly resolvedSession?: { port: number; sessionId: UUID; name?: string } | null;
  readonly defaultPortRange?: number[];
  readonly throwOnKill?: boolean;
}

function makeHelpersAndDeps(opts: HelpersOptions = {}) {
  const calls: Call[] = [];
  const helpers: KillCommandHelpers = {
    queryMultiplePorts: async (args) => {
      calls.push({ fn: 'queryMultiplePorts', args: { ports: [...args.ports], host: args.host } });
      return opts.queryResults ?? [];
    },
    resolveSession: (_results, target) => {
      calls.push({ fn: 'resolveSession', args: { target } });
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
    runKillClient: async (args) => {
      calls.push({ fn: 'runKillClient', args });
      if (opts.throwOnKill) throw new Error('kill failed');
    },
  };
  const deps = {
    getLivePorts: () => opts.livePorts ?? [],
    explicitPort: undefined as number | undefined,
  };
  return { helpers, deps, calls };
}

describe('runKillCommand', () => {
  test('prints usage and returns 1 when target id is missing', async () => {
    const { io, err } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps();
    const code = await runKillCommand(
      mkTarget({ targetId: undefined }),
      deps,
      io,
      async () => helpers,
    );
    expect(code).toBe(1);
    expect(err[0]).toBe('Usage: remi kill <session-name-or-id>');
    expect(err.some((m) => m.includes('Run `remi ls` to see live sessions.'))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('explicit port skips multi-port resolution', async () => {
    const { io } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps();
    const deps2 = { ...deps, explicitPort: 18800 };
    const code = await runKillCommand(mkTarget({ port: 18800 }), deps2, io, async () => helpers);
    expect(code).toBe(0);
    expect(calls.map((c) => c.fn)).toEqual(['runKillClient']);
  });

  test('non-localhost skips multi-port resolution even without explicit port', async () => {
    const { io } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps();
    const code = await runKillCommand(
      mkTarget({ host: 'remote.example', port: 18900 }),
      deps,
      io,
      async () => helpers,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      { fn: 'runKillClient', args: { host: 'remote.example', port: 18900, target: 'my-session' } },
    ]);
  });

  test('localhost resolution maps to session id and port', async () => {
    const { io } = makeIO();
    const { helpers, deps, calls } = makeHelpersAndDeps({
      livePorts: [18765, 18766],
      queryResults: [{ port: 18766, host: 'localhost', sessions: [] }],
      resolvedSession: { port: 18766, sessionId: 'SES-KILL-ME' as UUID, name: 'my-session' },
    });
    const code = await runKillCommand(mkTarget(), deps, io, async () => helpers);
    expect(code).toBe(0);
    expect(calls[calls.length - 1]).toEqual({
      fn: 'runKillClient',
      args: { host: 'localhost', port: 18766, target: 'SES-KILL-ME' },
    });
  });

  test('"Cannot reach any" when query returns zero results', async () => {
    const { io, err } = makeIO();
    const { helpers, deps } = makeHelpersAndDeps({
      livePorts: [18765, 18766, 18767],
      queryResults: [],
    });
    const code = await runKillCommand(mkTarget(), deps, io, async () => helpers);
    expect(code).toBe(1);
    expect(err[0]).toBe('Cannot reach any remi daemon (tried 3 port(s)). Is a daemon running?');
  });

  test('kill errors are caught, printed to stderr, exit 1', async () => {
    const { io, err } = makeIO();
    const { helpers, deps } = makeHelpersAndDeps({
      livePorts: [18765],
      queryResults: [],
      throwOnKill: true,
    });
    const deps2 = { ...deps, explicitPort: 18800 };
    const code = await runKillCommand(mkTarget({ port: 18800 }), deps2, io, async () => helpers);
    expect(code).toBe(1);
    expect(err).toEqual(['kill failed']);
  });
});
