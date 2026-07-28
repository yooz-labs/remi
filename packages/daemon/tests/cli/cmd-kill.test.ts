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

describe('runKillCommand — unreachable daemon pid fallback (#859)', () => {
  /** IO that also captures stdout, which the fallback narrates to. */
  function makeIO2() {
    const err: string[] = [];
    const out: string[] = [];
    return {
      io: { err: (m: string) => err.push(m), out: (m: string) => out.push(m) },
      err,
      out,
    };
  }

  // `name` is `path.basename(workingDirectory)` (cli.ts:2319), so a bare
  // basename is the ONLY shape that occurs in production. Earlier fixtures used
  // 'neurality/main', which cannot happen and quietly masked a dead
  // prefix-matching clause.
  const WEDGED = [{ pid: 4242, wsPort: 18766, name: 'neurality' }];

  test('signals the recorded pid when no daemon answers', async () => {
    // The state this exists for: the daemon is alive but ignoring its socket,
    // so every RPC path fails and `pkill` was previously the only option.
    const { io, err, out } = makeIO2();
    const { helpers, deps } = makeHelpersAndDeps({ queryResults: [] });
    const signalled: Array<{ pid: number; sig: string }> = [];
    const code = await runKillCommand(
      mkTarget({ targetId: 'neurality' }),
      {
        ...deps,
        listLive: () => WEDGED,
        signal: (pid, sig) => signalled.push({ pid, sig: String(sig) }),
      },
      io,
      async () => helpers,
    );
    expect(code).toBe(0);
    expect(signalled).toEqual([{ pid: 4242, sig: 'SIGTERM' }]);
    // It must be obvious that graceful shutdown was skipped.
    expect(err.join('\n')).toContain('not answering');
    expect(out.join('\n')).toContain('not shut down cleanly');
  });

  test('matches by port as well as name', async () => {
    const { io } = makeIO2();
    const { helpers, deps } = makeHelpersAndDeps({ queryResults: [] });
    const signalled: number[] = [];
    const code = await runKillCommand(
      mkTarget({ targetId: '18766' }),
      { ...deps, listLive: () => WEDGED, signal: (pid) => signalled.push(pid) },
      io,
      async () => helpers,
    );
    expect(code).toBe(0);
    expect(signalled).toEqual([4242]);
  });

  test('an unknown target still reports "cannot reach", not a silent success', async () => {
    // A typo must not be swallowed by the fallback.
    const { io, err } = makeIO2();
    const { helpers, deps } = makeHelpersAndDeps({ queryResults: [] });
    let signalled = false;
    const code = await runKillCommand(
      mkTarget({ targetId: 'no-such-session' }),
      {
        ...deps,
        listLive: () => WEDGED,
        signal: () => {
          signalled = true;
        },
      },
      io,
      async () => helpers,
    );
    expect(code).toBe(1);
    expect(signalled).toBe(false);
    expect(err.join('\n')).toContain('Cannot reach any remi daemon');
  });

  test('refuses to guess between two unreachable daemons with the same name', async () => {
    // `name` is a directory basename, so two worktrees of one project collide
    // routinely. Picking the first would SIGKILL the wrong daemon and report
    // success -- the reachable path already refuses this via
    // AmbiguousSessionError, and so must this one.
    const { io, err } = makeIO2();
    const { helpers, deps } = makeHelpersAndDeps({ queryResults: [] });
    let signalled = false;
    const code = await runKillCommand(
      mkTarget({ targetId: 'main' }),
      {
        ...deps,
        listLive: () => [
          { pid: 100, wsPort: 18765, name: 'main' },
          { pid: 200, wsPort: 18766, name: 'main' },
        ],
        signal: () => {
          signalled = true;
        },
      },
      io,
      async () => helpers,
    );
    expect(code).toBe(1);
    expect(signalled).toBe(false);
    expect(err.join('\n')).toContain('matches 2 unreachable daemons');
    expect(err.join('\n')).toContain('Nothing was stopped');
  });

  test('a process that is already gone is success, not an error', async () => {
    const { io, out } = makeIO2();
    const { helpers, deps } = makeHelpersAndDeps({ queryResults: [] });
    const code = await runKillCommand(
      mkTarget({ targetId: 'neurality' }),
      {
        ...deps,
        listLive: () => WEDGED,
        signal: () => {
          const e = new Error('no such process') as NodeJS.ErrnoException;
          e.code = 'ESRCH';
          throw e;
        },
      },
      io,
      async () => helpers,
    );
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('already gone');
  });
});
