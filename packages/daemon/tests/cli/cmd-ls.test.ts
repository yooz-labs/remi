import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type LsClientHelpers, runLsCommand } from '../../src/cli/cmd-ls.ts';
import type { SessionRegistryFile } from '../../src/session/session-registry-file.ts';

type Call = {
  fn: 'runNetworkLs' | 'runLsClient' | 'runHostLs' | 'runMultiPortLs' | 'getDefaultPortRange';
  args: unknown;
};

function makeIO() {
  const err: string[] = [];
  return { io: { err: (m: string) => err.push(m) }, err };
}

function makeRegistry(livePorts: number[] = [18765, 18766]): SessionRegistryFile {
  return { getLivePorts: () => livePorts } as unknown as SessionRegistryFile;
}

function makeHelpers(opts?: { throwOn?: keyof LsClientHelpers }): {
  helpers: LsClientHelpers;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record = (fn: Call['fn'], throwOnMatch: boolean) => async (args: unknown) => {
    calls.push({ fn, args });
    if (throwOnMatch) throw new Error(`${fn} failed`);
  };
  const helpers: LsClientHelpers = {
    runNetworkLs: record('runNetworkLs', opts?.throwOn === 'runNetworkLs'),
    runLsClient: record('runLsClient', opts?.throwOn === 'runLsClient'),
    runHostLs: record('runHostLs', opts?.throwOn === 'runHostLs'),
    runMultiPortLs: record('runMultiPortLs', opts?.throwOn === 'runMultiPortLs'),
    getDefaultPortRange: () => {
      calls.push({ fn: 'getDefaultPortRange', args: undefined });
      return [18765, 18766, 18767];
    },
  };
  return { helpers, calls };
}

describe('runLsCommand', () => {
  let savedPort: string | undefined;

  beforeEach(() => {
    savedPort = process.env['REMI_PORT'];
    // biome-ignore lint/performance/noDelete: tests must remove the env var, not undefined-stringify.
    delete process.env['REMI_PORT'];
  });

  afterEach(() => {
    if (savedPort === undefined) {
      // biome-ignore lint/performance/noDelete: same reason.
      delete process.env['REMI_PORT'];
    } else {
      process.env['REMI_PORT'] = savedPort;
    }
  });

  test('--network routes to runNetworkLs with live ports', async () => {
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    const code = await runLsCommand(
      { network: true },
      makeRegistry([18765, 18766]),
      io,
      async () => helpers,
    );
    expect(code).toBe(0);
    expect(calls[0]?.fn).toBe('runNetworkLs');
    expect((calls[0]?.args as { localPorts: number[] }).localPorts).toEqual([18765, 18766]);
  });

  test('explicit port routes to runLsClient on localhost', async () => {
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    const code = await runLsCommand({ port: 18800 }, makeRegistry(), io, async () => helpers);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({
      fn: 'runLsClient',
      args: { host: 'localhost', port: 18800 },
    });
  });

  test('explicit port + host routes to runLsClient on that host', async () => {
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    await runLsCommand(
      { port: 18800, host: 'remote.example' },
      makeRegistry(),
      io,
      async () => helpers,
    );
    expect(calls[0]).toEqual({
      fn: 'runLsClient',
      args: { host: 'remote.example', port: 18800 },
    });
  });

  test('host without port routes to runHostLs with default port range', async () => {
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    await runLsCommand({ host: 'remote.example' }, makeRegistry(), io, async () => helpers);
    expect(calls.map((c) => c.fn)).toEqual(['getDefaultPortRange', 'runHostLs']);
    expect(calls[1]).toEqual({
      fn: 'runHostLs',
      args: { host: 'remote.example', ports: [18765, 18766, 18767] },
    });
  });

  test('no port, no host, no network routes to runMultiPortLs with registry', async () => {
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    const registry = makeRegistry([18765]);
    await runLsCommand({}, registry, io, async () => helpers);
    expect(calls[0]?.fn).toBe('runMultiPortLs');
    expect((calls[0]?.args as { registry: SessionRegistryFile }).registry).toBe(registry);
  });

  test('REMI_PORT env acts as explicit port when --port is absent', async () => {
    process.env['REMI_PORT'] = '19000';
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    await runLsCommand({}, makeRegistry(), io, async () => helpers);
    expect(calls[0]).toEqual({
      fn: 'runLsClient',
      args: { host: 'localhost', port: 19000 },
    });
  });

  test('--port overrides REMI_PORT', async () => {
    process.env['REMI_PORT'] = '19000';
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    await runLsCommand({ port: 18888 }, makeRegistry(), io, async () => helpers);
    expect((calls[0]?.args as { port: number }).port).toBe(18888);
  });

  test('errors are caught, printed to stderr, and exit 1', async () => {
    const { io, err } = makeIO();
    const { helpers } = makeHelpers({ throwOn: 'runMultiPortLs' });
    const code = await runLsCommand({}, makeRegistry(), io, async () => helpers);
    expect(code).toBe(1);
    expect(err).toEqual(['runMultiPortLs failed']);
  });
});
