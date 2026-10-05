/**
 * Whether the daemon opens a relay connection at all (#1193 review F5, F6).
 *
 * The REAL cli.ts runs as `remi serve` in a sandbox `$HOME`, pointed with
 * `--signaling-url` at a loopback Worker stand-in (`remote/fake-worker.ts`),
 * never the live Worker. The test counts how many sockets the daemon opens to
 * it. This is the only way to observe the `--no-relay` wiring at the
 * registration site: every other integration test passes `--no-relay`, which
 * says nothing now that the default is off.
 *
 * "Nothing connected" cases wait for the hub to be ready (relay adapters start
 * before the hub's own listener), then stop it and read the count after the
 * process has exited; "connected" cases wait for the socket itself. No fixed
 * sleeps.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { type FakeWorker, startFakeWorker, until } from '../remote/fake-worker.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import { CLI_TS, isolatedEnv, makeIsolatedDirs, pollUntil } from './hub-test-utils.ts';

interface Run {
  readonly connections: number;
  readonly paths: string[];
  readonly output: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Boot a hub with `args`, wait for it to be ready, optionally wait for
 * `expectConnections` sockets, stop it, and report what the Worker stand-in saw
 * and what the hub printed.
 */
async function runHub(options: {
  readonly args: readonly string[];
  readonly config?: string;
  readonly expectConnections?: number;
}): Promise<Run> {
  const { home, work } = makeIsolatedDirs();
  const worker: FakeWorker = startFakeWorker();
  cleanups.push(() => {
    worker.stop();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });
  if (options.config !== undefined) {
    fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
    fs.writeFileSync(path.join(home, '.remi', 'config.toml'), options.config);
  }

  const port = await reserveRange(1, 50, DEFAULT_CONFIG.daemon.bind);
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_TS,
      'serve',
      '--port',
      String(port),
      '--no-telegram',
      '--no-mdns',
      '--signaling-url',
      worker.url,
      ...options.args,
    ],
    { cwd: work, env: isolatedEnv(home), stdout: 'pipe', stderr: 'pipe' },
  );
  cleanups.push(async () => {
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
      await proc.exited;
    }
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();

  const statusFile = path.join(home, '.remi', 'daemon-status.json');
  await pollUntil(
    () => {
      if (proc.exitCode !== null)
        throw new Error(`the hub exited early with code ${proc.exitCode}`);
      try {
        return JSON.parse(fs.readFileSync(statusFile, 'utf-8')).wsPort === port;
      } catch {
        return false;
      }
    },
    20_000,
    'the hub to be ready',
  );
  if (options.expectConnections !== undefined) {
    await until(
      () => worker.connections() >= (options.expectConnections ?? 0),
      `${options.expectConnections} relay connection(s)`,
    );
  }

  proc.kill('SIGTERM');
  await proc.exited;
  return {
    connections: worker.connections(),
    paths: worker.paths(),
    output: `${await stdout}\n${await stderr}`,
  };
}

const RELAY_ON = '[network]\nrelay = true\n';
const RELAY_OFF = '[network]\nrelay = false\n';
const NOTICE = 'Relay not started';

describe('the daemon opens a relay connection only when it can authenticate one', () => {
  test('a stock run opens none and says nothing about the relay', async () => {
    const run = await runHub({ args: ['--no-auth'] });
    expect(run.connections).toBe(0);
    expect(run.output).not.toContain(NOTICE);
  }, 40_000);

  test('relay = true with --no-relay opens none and does not print the notice', async () => {
    // --no-relay wins: the registration site must pass it to relayRequested, or
    // the notice (and, with an authenticator, a connection) would appear.
    const run = await runHub({ args: ['--no-auth', '--no-relay'], config: RELAY_ON });
    expect(run.connections).toBe(0);
    expect(run.output).not.toContain(NOTICE);
  }, 40_000);

  test('relay = true with --no-relay wins over --permanent-code too', async () => {
    const run = await runHub({
      args: ['--auth', '--permanent-code', '--no-relay'],
      config: RELAY_ON,
    });
    expect(run.connections).toBe(0);
    expect(run.output).not.toContain(NOTICE);
  }, 40_000);

  test('relay = true without --permanent-code opens none, and the notice says why and how to silence it', async () => {
    const run = await runHub({ args: ['--no-auth'], config: RELAY_ON });
    expect(run.connections).toBe(0);
    expect(run.output).toContain(NOTICE);
    expect(run.output).toContain('--auth --permanent-code');
    expect(run.output).toContain('SSH tunnel');
    expect(run.output).toContain('network.relay = false');
    expect(run.output).toContain('--no-relay');
  }, 40_000);

  test('relay = true with --auth --permanent-code opens one to the room path without automatic trust', async () => {
    const run = await runHub({
      args: ['--auth', '--permanent-code'],
      config: RELAY_ON,
      expectConnections: 1,
    });
    expect(run.connections).toBe(1);
    expect(run.paths[0]).toMatch(/^\/connect\/[A-Z]{4}-[2-9]{4}$/);
    expect(run.output).not.toContain(NOTICE);
    expect(run.output).not.toContain('authorized keys');
    expect(run.output).toContain('unknown keys require local approval');
  }, 40_000);

  test('--permanent-code wins over relay = false (the command line beats the config) and --no-tofu prints its retirement notice', async () => {
    const run = await runHub({
      args: ['--auth', '--permanent-code', '--no-tofu'],
      config: RELAY_OFF,
      expectConnections: 1,
    });
    expect(run.connections).toBe(1);
    expect(run.output).not.toContain('authorized keys');
    expect(run.output).toContain('--no-tofu is retired');
  }, 40_000);
});
