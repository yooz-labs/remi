import { describe, expect, test } from 'bun:test';
import { type DiscoverableSession, type UUID, now } from '@remi/shared';
import { type AttachCommandHelpers, runAttachCommand } from '../../src/cli/cmd-attach.ts';
import {
  AmbiguousSessionError,
  type DiscoveredEndpoint,
  type NetworkDiscoveryResult,
  type PortQueryResult,
} from '../../src/cli/session-resolver.ts';
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
  const out: string[] = [];
  const err: string[] = [];
  const log: string[] = [];
  return {
    io: {
      out: (m: string) => out.push(m),
      err: (m: string) => err.push(m),
      log: (m: string) => log.push(m),
    },
    out,
    err,
    log,
  };
}

function mkTarget(overrides: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return { host: 'localhost', port: 18765, targetId: undefined, ...overrides };
}

function makeRegistry(
  overrides: {
    live?: Array<{ sessionId: string; wsPort: number; startedAt: string; name?: string }>;
    findByName?: (name: string) => { wsPort: number } | null;
    livePorts?: number[];
  } = {},
): import('../../src/session/session-registry-file.ts').SessionRegistryFile {
  return {
    listLive: () => overrides.live ?? [],
    findByName: overrides.findByName ?? (() => null),
    getLivePorts: () => overrides.livePorts ?? [],
  } as unknown as import('../../src/session/session-registry-file.ts').SessionRegistryFile;
}

function makeStore(
  sessions: Array<{
    remiSessionId: string;
    port: number;
    startedAt: string;
    exitedAt: string | null;
  }> = [],
): import('../../src/session/session-store.ts').SessionStore {
  return {
    list: () => sessions,
  } as unknown as import('../../src/session/session-store.ts').SessionStore;
}

interface HelperOpts {
  readonly fetchSessions?: () => Promise<DiscoverableSession[]>;
  readonly fetchSessionsThrow?: Error;
  readonly queryResults?: readonly PortQueryResult[];
  readonly queryThrow?: Error;
  readonly resolved?: { port: number; host?: string; sessionId: UUID } | null;
  readonly classifyResult?: 'connection' | 'expected' | 'unexpected';
  readonly discovery?: NetworkDiscoveryResult;
  readonly discoveryThrow?: Error;
  readonly endpointsByHost?: DiscoveredEndpoint[];
  readonly defaultPortRange?: number[];
  readonly runAttachResult?: { exitCode: number };
  readonly runAttachThrow?: Error;
}

function makeHelpers(opts: HelperOpts = {}): AttachCommandHelpers {
  return {
    fetchSessions: async () => {
      if (opts.fetchSessionsThrow) throw opts.fetchSessionsThrow;
      return opts.fetchSessions ? opts.fetchSessions() : [];
    },
    queryMultiplePorts: async () => {
      if (opts.queryThrow) throw opts.queryThrow;
      return opts.queryResults ?? [];
    },
    resolveSession: () => {
      if (!opts.resolved) return null;
      const fake = makeSession({
        sessionId: opts.resolved.sessionId,
      });
      return { session: fake, port: opts.resolved.port, host: opts.resolved.host ?? 'localhost' };
    },
    classifyQueryError: () => opts.classifyResult ?? 'expected',
    discoverNetworkDaemons: async () => {
      if (opts.discoveryThrow) throw opts.discoveryThrow;
      return opts.discovery ?? { endpoints: [] };
    },
    findEndpointsByHostname: () => opts.endpointsByHost ?? [],
    getDefaultPortRange: () => opts.defaultPortRange ?? [18765, 18766],
    runAttachClient: async () => {
      if (opts.runAttachThrow) throw opts.runAttachThrow;
      return opts.runAttachResult ?? { exitCode: 0 };
    },
    AmbiguousSessionError,
    FETCH_SESSIONS_TIMEOUT_MS: 5000,
  };
}

describe('runAttachCommand', () => {
  // Branch A: explicit remote target without session id
  test('A: fetchSessions returns one session -> auto-attach', async () => {
    const sess = makeSession({ sessionId: 'SES-REMOTE-1' as UUID });
    const { io } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ host: 'remote.example', port: 18800 }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => makeHelpers({ fetchSessions: async () => [sess] }),
    );
    expect(code).toBe(0);
  });

  test('A: fetchSessions returns zero -> error + exit 1', async () => {
    const { io, err } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ host: 'remote.example', port: 18800 }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => makeHelpers({ fetchSessions: async () => [] }),
    );
    expect(code).toBe(1);
    expect(err[0]).toBe('No sessions found at remote.example:18800.');
  });

  test('A: multiple sessions with one attachable -> auto-attach that one', async () => {
    const s1 = makeSession({ sessionId: 'S1' as UUID, canAttach: false });
    const s2 = makeSession({ sessionId: 'S2' as UUID, canAttach: true });
    const { io } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ host: 'remote.example', port: 18800 }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => makeHelpers({ fetchSessions: async () => [s1, s2] }),
    );
    expect(code).toBe(0);
  });

  test('A: multiple attachable -> disambiguation hint, exit 1', async () => {
    const s1 = makeSession({ sessionId: 'SES-S1' as UUID, name: 's1', canAttach: true });
    const s2 = makeSession({ sessionId: 'SES-S2' as UUID, name: 's2', canAttach: true });
    const { io, err } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ host: 'remote.example', port: 18800 }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => makeHelpers({ fetchSessions: async () => [s1, s2] }),
    );
    expect(code).toBe(1);
    expect(err[0]).toBe('Multiple sessions at remote.example:18800:');
    expect(err.some((m) => m.includes('remi attach remote.example:18800/'))).toBe(true);
  });

  test('A: fetchSessions throws -> "Cannot connect" error + exit 1', async () => {
    const { io, err } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ host: 'remote.example', port: 18800 }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => makeHelpers({ fetchSessionsThrow: new Error('ECONNREFUSED') }),
    );
    expect(code).toBe(1);
    expect(err[0]).toBe('Cannot connect to remote.example:18800: ECONNREFUSED');
  });

  // Branch B: no target id, auto-pick
  test('B: no target id, live registry has a session -> pick most recent', async () => {
    const { io } = makeIO();
    const code = await runAttachCommand(
      mkTarget(),
      {},
      {
        store: makeStore(),
        registry: makeRegistry({
          live: [{ sessionId: 'LIVE-A', wsPort: 18766, startedAt: now() }],
        }),
      },
      io,
      async () => makeHelpers(),
    );
    expect(code).toBe(0);
  });

  test('B: no target id, registry empty, store has active session', async () => {
    const { io } = makeIO();
    const code = await runAttachCommand(
      mkTarget(),
      {},
      {
        store: makeStore([
          {
            remiSessionId: 'STORE-A',
            port: 18900,
            startedAt: '2026-04-17T00:00:00.000Z',
            exitedAt: null,
          },
        ]),
        registry: makeRegistry(),
      },
      io,
      async () => makeHelpers(),
    );
    expect(code).toBe(0);
  });

  test('B: no target id, both empty -> error, exit 1', async () => {
    const { io, err } = makeIO();
    const code = await runAttachCommand(
      mkTarget(),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => makeHelpers(),
    );
    expect(code).toBe(1);
    expect(err[0]).toBe('No active sessions found. Run `remi ls` to see live sessions.');
  });

  // Branch C: target name provided
  test('C: resolveSession hits -> use resolved session id and port', async () => {
    const { io } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ targetId: 'my-session' }),
      {},
      { store: makeStore(), registry: makeRegistry({ livePorts: [18765] }) },
      io,
      async () =>
        makeHelpers({
          queryResults: [{ port: 18765, host: 'localhost', sessions: [] }],
          resolved: { port: 18765, sessionId: 'SES-RESOLVED' as UUID },
        }),
    );
    expect(code).toBe(0);
  });

  test('C: AmbiguousSessionError during query -> error message + exit 1', async () => {
    const { io, err } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ targetId: 'my-session' }),
      {},
      { store: makeStore(), registry: makeRegistry({ livePorts: [18765] }) },
      io,
      async () =>
        makeHelpers({
          queryThrow: new AmbiguousSessionError('my-session', [
            { name: 'my-session', port: 18765 },
            { name: 'my-session:2', port: 18766 },
          ]),
        }),
    );
    expect(code).toBe(1);
    expect(err[0]).toContain('Ambiguous session');
  });

  test('C: prefix match in store when query fails to resolve', async () => {
    const { io } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ targetId: 'SES-PREFIX' }),
      {},
      {
        store: makeStore([
          {
            remiSessionId: 'SES-PREFIX-ABCDEF',
            port: 18900,
            startedAt: now(),
            exitedAt: null,
          },
        ]),
        registry: makeRegistry({ livePorts: [18765] }),
      },
      io,
      async () =>
        makeHelpers({
          queryResults: [{ port: 18765, host: 'localhost', sessions: [] }],
          resolved: null,
        }),
    );
    expect(code).toBe(0);
  });

  test('C: multiple prefix matches -> ambiguous error, exit 1', async () => {
    const { io, err } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ targetId: 'SES-ABC' }),
      {},
      {
        store: makeStore([
          {
            remiSessionId: 'SES-ABC-111',
            port: 18900,
            startedAt: now(),
            exitedAt: null,
          },
          {
            remiSessionId: 'SES-ABC-222',
            port: 18901,
            startedAt: now(),
            exitedAt: null,
          },
        ]),
        registry: makeRegistry(),
      },
      io,
      async () => makeHelpers({ resolved: null }),
    );
    expect(code).toBe(1);
    expect(err[0]).toContain('Ambiguous session ID "SES-ABC"');
    expect(err.some((m) => m.includes('Provide a longer prefix'))).toBe(true);
  });

  test('C: no match, no hostname prefix, no --host -> "No session found" + exit 1', async () => {
    const { io, err } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ targetId: 'unknown' }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => makeHelpers({ resolved: null }),
    );
    expect(code).toBe(1);
    expect(err.some((m) => m.startsWith('No session found matching "unknown"'))).toBe(true);
  });

  test('C: network discovery happy path — finds remote session via mDNS endpoint', async () => {
    const { io, err } = makeIO();
    const code = await runAttachCommand(
      // Target has `hostname:...` shape which triggers network discovery.
      mkTarget({ targetId: 'remotehost:project/branch' }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () =>
        makeHelpers({
          resolved: null, // local resolve fails, falls through to discovery
          discovery: {
            endpoints: [{ hostname: 'remotehost', host: '10.0.0.5', port: 18800, source: 'mdns' }],
          },
          endpointsByHost: [
            { hostname: 'remotehost', host: '10.0.0.5', port: 18800, source: 'mdns' },
          ],
          queryResults: [{ port: 18800, host: '10.0.0.5', sessions: [] }],
        }),
    );
    // First call to resolveSession returns null (local); second call inside
    // discovery branch also returns null -> `foundRemote = false` -> exit 1
    // with the ls --network error message.
    expect(code).toBe(1);
    expect(err.some((m) => m.includes('no session matches'))).toBe(true);
    // Discovery diagnostics should surface.
    expect(err.some((m) => m.startsWith('Resolving "remotehost:project/branch"'))).toBe(true);
    expect(err.some((m) => m.includes('Found 1 daemon(s); hosts:'))).toBe(true);
  });

  test('C: network discovery happy path — remote session resolves, attach succeeds', async () => {
    const { io, err } = makeIO();
    const calls: Array<{ fn: string }> = [];
    // Two-phase resolveSession: first call (local) returns null, second (remote) returns a match.
    let resolveCount = 0;
    const helpers = {
      ...makeHelpers({
        discovery: {
          endpoints: [{ hostname: 'remotehost', host: '10.0.0.5', port: 18800, source: 'mdns' }],
        },
        endpointsByHost: [
          { hostname: 'remotehost', host: '10.0.0.5', port: 18800, source: 'mdns' },
        ],
        queryResults: [{ port: 18800, host: '10.0.0.5', sessions: [] }],
      }),
      resolveSession: () => {
        resolveCount++;
        if (resolveCount === 1) return null; // local miss
        // remote hit: session found on remote daemon
        return {
          session: makeSession({ sessionId: 'SES-REMOTE-OK' as UUID }),
          port: 18800,
          host: '10.0.0.5',
        };
      },
      runAttachClient: async (args: { host: string; port: number }) => {
        calls.push({ fn: `attach:${args.host}:${args.port}` });
        return { exitCode: 0 };
      },
    };
    const code = await runAttachCommand(
      mkTarget({ targetId: 'remotehost:project/branch' }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => helpers,
    );
    expect(code).toBe(0);
    // runAttachClient called with the remote host/port discovered.
    expect(calls).toEqual([{ fn: 'attach:10.0.0.5:18800' }]);
    // Success message on stderr (notice the parenthetical host:port).
    expect(err.some((m) => m.startsWith('Found on remotehost (10.0.0.5:18800)'))).toBe(true);
  });

  test('C: AmbiguousSessionError during remote resolveSession -> exit 1 with match list', async () => {
    const { io, err } = makeIO();
    let resolveCount = 0;
    const helpers = {
      ...makeHelpers({
        discovery: {
          endpoints: [{ hostname: 'remotehost', host: '10.0.0.5', port: 18800, source: 'mdns' }],
        },
        endpointsByHost: [
          { hostname: 'remotehost', host: '10.0.0.5', port: 18800, source: 'mdns' },
        ],
        queryResults: [{ port: 18800, host: '10.0.0.5', sessions: [] }],
      }),
      resolveSession: () => {
        resolveCount++;
        if (resolveCount === 1) return null;
        throw new AmbiguousSessionError('remotehost:project/branch', [
          { name: 'remotehost:project/branch', port: 18800 },
          { name: 'remotehost:project/branch:2', port: 18801 },
        ]);
      },
    };
    const code = await runAttachCommand(
      mkTarget({ targetId: 'remotehost:project/branch' }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => helpers,
    );
    expect(code).toBe(1);
    expect(err.some((m) => m.startsWith('Ambiguous: 2 sessions match on remotehost'))).toBe(true);
    // Match list should enumerate both.
    expect(
      err.some((m) => m.includes('remotehost:project/branch') && m.includes('port 18800')),
    ).toBe(true);
  });

  test('C: --host set, no match -> skip network discovery, "No session found" + exit 1', async () => {
    const { io, err } = makeIO();
    const code = await runAttachCommand(
      mkTarget({ targetId: 'unknown' }),
      { host: 'remote.example' },
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () => makeHelpers({ resolved: null }),
    );
    expect(code).toBe(1);
    // With --host, network discovery is skipped and the simpler message fires.
    expect(err.some((m) => m.startsWith('No session found matching "unknown"'))).toBe(true);
  });

  // Final attach stage
  test('runAttachClient exit code is propagated to the caller', async () => {
    const { io } = makeIO();
    const sess = makeSession({ sessionId: 'SES-X' as UUID });
    const code = await runAttachCommand(
      mkTarget({ host: 'remote.example', port: 18800 }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () =>
        makeHelpers({
          fetchSessions: async () => [sess],
          runAttachResult: { exitCode: 42 },
        }),
    );
    expect(code).toBe(42);
  });

  test('runAttachClient throws -> stderr + exit 1', async () => {
    const { io, err } = makeIO();
    const sess = makeSession({ sessionId: 'SES-X' as UUID });
    const code = await runAttachCommand(
      mkTarget({ host: 'remote.example', port: 18800 }),
      {},
      { store: makeStore(), registry: makeRegistry() },
      io,
      async () =>
        makeHelpers({
          fetchSessions: async () => [sess],
          runAttachThrow: new Error('attach failed'),
        }),
    );
    expect(code).toBe(1);
    expect(err).toEqual(['attach failed']);
  });
});
