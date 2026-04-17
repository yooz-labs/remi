import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RecentDirectory } from '@remi/shared';
import { type RecentCommandHelpers, runRecentCommand } from '../../src/cli/cmd-recent.ts';

function makeIO() {
  const err: string[] = [];
  return { io: { err: (m: string) => err.push(m) }, err };
}

type Call =
  | { fn: 'runRecentClient'; args: { host: string; port: number } }
  | { fn: 'renderRecentDirectories'; args: readonly RecentDirectory[] }
  | { fn: 'listLocalDirectories' };

function makeHelpers(throwOnRemote = false): {
  helpers: RecentCommandHelpers;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sampleDir: RecentDirectory = {
    directory: '/tmp/project',
    displayName: 'project',
    lastUsed: '2026-04-17T00:00:00.000Z',
    sessionCount: 3,
  };
  const helpers: RecentCommandHelpers = {
    runRecentClient: async (args) => {
      calls.push({ fn: 'runRecentClient', args });
      if (throwOnRemote) throw new Error('remote unreachable');
    },
    renderRecentDirectories: (dirs) => {
      calls.push({ fn: 'renderRecentDirectories', args: dirs });
    },
    listLocalDirectories: () => {
      calls.push({ fn: 'listLocalDirectories' });
      return [sampleDir];
    },
  };
  return { helpers, calls };
}

describe('runRecentCommand', () => {
  let savedPort: string | undefined;

  beforeEach(() => {
    savedPort = process.env['REMI_PORT'];
    // biome-ignore lint/performance/noDelete: restoring unset env var requires removal.
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

  test('default (no port/host) routes to local mode', async () => {
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    const code = await runRecentCommand(
      {},
      () => [],
      io,
      async () => helpers,
    );
    expect(code).toBe(0);
    // Calls listLocalDirectories (via helper) then renderRecentDirectories.
    expect(calls.map((c) => c.fn)).toEqual(['listLocalDirectories', 'renderRecentDirectories']);
  });

  test('explicit port routes to remote mode on localhost', async () => {
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    const code = await runRecentCommand(
      { port: 18800 },
      () => [],
      io,
      async () => helpers,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{ fn: 'runRecentClient', args: { host: 'localhost', port: 18800 } }]);
  });

  test('--host routes to remote mode on default port', async () => {
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    await runRecentCommand(
      { host: 'remote.example' },
      () => [],
      io,
      async () => helpers,
    );
    expect(calls).toEqual([
      { fn: 'runRecentClient', args: { host: 'remote.example', port: 18765 } },
    ]);
  });

  test('REMI_PORT env triggers remote mode when no --host', async () => {
    process.env['REMI_PORT'] = '19000';
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    await runRecentCommand(
      {},
      () => [],
      io,
      async () => helpers,
    );
    expect(calls).toEqual([{ fn: 'runRecentClient', args: { host: 'localhost', port: 19000 } }]);
  });

  test('--port overrides REMI_PORT', async () => {
    process.env['REMI_PORT'] = '19000';
    const { io } = makeIO();
    const { helpers, calls } = makeHelpers();
    await runRecentCommand(
      { port: 18888 },
      () => [],
      io,
      async () => helpers,
    );
    expect(calls).toEqual([{ fn: 'runRecentClient', args: { host: 'localhost', port: 18888 } }]);
  });

  test('remote-mode errors are caught, stderr written, exit 1, no local fallback', async () => {
    const { io, err } = makeIO();
    const { helpers, calls } = makeHelpers(true);
    const code = await runRecentCommand(
      { port: 18800 },
      () => [],
      io,
      async () => helpers,
    );
    expect(code).toBe(1);
    expect(err).toEqual(['remote unreachable']);
    // Must not fall back to local rendering on remote failure.
    expect(calls.map((c) => c.fn)).toEqual(['runRecentClient']);
  });
});
