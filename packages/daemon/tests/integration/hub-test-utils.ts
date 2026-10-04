/**
 * Shared harness for the hub integration tests (#542): spawn the REAL cli.ts
 * as a subprocess with an isolated $HOME (Bun's os.homedir() respects it), so
 * every ~/.remi artifact lands in a mkdtemp sandbox — never the developer's
 * real ~/.remi. No mocks anywhere.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHello, deserialize, serialize } from '@remi/shared/protocol.ts';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { findAvailableTcpPort } from '../../src/session/port-utils.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

export const CLI_TS = path.resolve(import.meta.dir, '../../src/cli.ts');

export interface HubHandle {
  proc: ReturnType<typeof Bun.spawn>;
  home: string;
  work: string;
  port: number;
}

export async function pollUntil(
  cond: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function makeIsolatedDirs(): { home: string; work: string } {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hub-home-')),
    work: fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hub-work-')),
  };
}

/**
 * A free port for a spawned hub, probed on the host that hub will actually
 * bind. `spawnServeRaw` passes no `--bind`, and each hub runs under an
 * isolated `$HOME` with no config file, so the host is `DEFAULT_CONFIG` --
 * read from there rather than restated, so this cannot drift from the shipped
 * default the way the probe's own `'0.0.0.0'` default did (#880).
 *
 * Probing a different host than the hub binds is not a harmless approximation.
 * It handed the second hub the port the FIRST hub was already using, so the
 * rival died on EADDRINUSE before reaching the PID-file guard it was written
 * to exercise -- the #542 split-brain test silently stopped testing #542.
 */
export async function findTestPort(): Promise<number> {
  const port = await findAvailableTcpPort(19200, 200, new Set(), DEFAULT_CONFIG.daemon.bind);
  if (port === null) throw new Error('No free test port');
  return port;
}

/** Isolated env for a spawned cli.ts subprocess. */
export function isolatedEnv(
  home: string,
  overrides: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  // A stray inherited port/child marker would defeat the isolation.
  // biome-ignore lint/performance/noDelete: must truly remove env var from child process
  delete env['REMI_PORT'];
  // biome-ignore lint/performance/noDelete: must truly remove env var from child process
  delete env['REMI_SPAWNED_CHILD'];
  // An inherited REMI_HOME would move the child's state out of the sandbox
  // HOME this helper exists to provide (config/remi-home.ts).
  // biome-ignore lint/performance/noDelete: must truly remove env var from child process
  delete env['REMI_HOME'];
  return { ...env, ...overrides };
}

/** Spawn `remi serve` without waiting for readiness (for exit-path tests). */
export function spawnServeRaw(
  home: string,
  work: string,
  port: number,
  envOverrides: Record<string, string> = {},
  cliPath: string = CLI_TS,
): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(
    [
      'bun',
      cliPath,
      'serve',
      '--port',
      String(port),
      '--no-relay',
      '--no-telegram',
      '--no-mdns',
      '--no-auth',
    ],
    { cwd: work, env: isolatedEnv(home, envOverrides), stdout: 'pipe', stderr: 'pipe' },
  );
}

/**
 * Spawn a session daemon (`cli.ts --daemon`, not a hub) without waiting for
 * readiness, and report the port it was given. A daemon starts Claude itself
 * (`createNewSession`), so tests that need to observe the launch put a fake
 * `claude` first on PATH through `envOverrides` (the launch characterization
 * test, #1164).
 *
 * The port comes from `reserveRange` (random, 45000-49999), not
 * `findTestPort`, which hands the lowest free port from 19200 to every caller
 * and so gives concurrent test processes the same one. The child's
 * `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` defaults to empty, which remi treats
 * as unset, so a developer shell that exports `=0` cannot change what the
 * daemon passes to Claude. It runs under `process.execPath`, so an override of
 * PATH that omits `bun` still starts it.
 *
 * `extraArgs` go after the fixed flags (the Codex launch test passes
 * `--harness codex`, #1177).
 */
export async function spawnDaemon(
  home: string,
  work: string,
  envOverrides: Record<string, string> = {},
  extraArgs: readonly string[] = [],
): Promise<{ proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>; port: number }> {
  const port = await reserveRange(1, 50, DEFAULT_CONFIG.daemon.bind);
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_TS,
      '--daemon',
      '--port',
      String(port),
      '--no-relay',
      '--no-telegram',
      '--no-mdns',
      '--no-auth',
      ...extraArgs,
    ],
    {
      cwd: work,
      env: isolatedEnv(home, { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '', ...envOverrides }),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  return { proc, port };
}

/**
 * Spawn a hub in a fresh isolated $HOME and wait for its status file.
 * `envOverrides` is forwarded to the subprocess (e.g. a PATH that puts a fake
 * `claude` first, for tests that must observe whether the hub ever runs it).
 */
export async function spawnHub(
  dirs?: { home: string; work: string },
  envOverrides: Record<string, string> = {},
  cliPath: string = CLI_TS,
  chosenPort?: number,
): Promise<HubHandle> {
  const { home, work } = dirs ?? makeIsolatedDirs();
  // `findTestPort` hands the lowest free port from 19200 to every caller, so two test processes on
  // one machine can get the same one; a caller that runs beside others picks a random probed port
  // instead (`reserveRange`, as `spawnDaemon` does) and passes it here (#1204 round 2, P11).
  const port = chosenPort ?? (await findTestPort());
  const proc = spawnServeRaw(home, work, port, envOverrides, cliPath);
  const hub: HubHandle = { proc, home, work, port };

  const statusFile = path.join(home, '.remi', 'daemon-status.json');
  try {
    await pollUntil(
      () => {
        if (proc.exitCode !== null) {
          throw new Error(`Hub exited early with code ${proc.exitCode}`);
        }
        try {
          const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
          return status.wsPort === port;
        } catch {
          return false;
        }
      },
      15000,
      'hub status file',
    );
  } catch (error) {
    // An exit says nothing about why. What the hub printed does (a port in use, a bad flag).
    if (proc.exitCode !== null) {
      const said = `${await new Response(proc.stderr).text()}${await new Response(proc.stdout).text()}`;
      throw new Error(`${(error as Error).message}\n${said.trim().slice(-1500)}`);
    }
    throw error;
  }
  return hub;
}

export async function cleanupHub(hub: HubHandle): Promise<void> {
  try {
    hub.proc.kill('SIGKILL');
    await hub.proc.exited;
  } catch {
    // already dead
  }
  fs.rmSync(hub.home, { recursive: true, force: true });
  fs.rmSync(hub.work, { recursive: true, force: true });
}

/** Open a WS to the hub, send hello, resolve once hello_ack arrives. Returns
 *  the socket plus a growing message log the test can keep asserting on. */
export async function connectAndHello(
  port: number,
): Promise<{ ws: WebSocket; received: ProtocolMessage[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const received: ProtocolMessage[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => ws.send(serialize(createHello('hub-test-client', '1.0.0')));
    ws.onmessage = (e) => {
      const msg = deserialize(e.data.toString());
      if (msg) received.push(msg);
      if (msg?.type === 'hello_ack') resolve();
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout waiting for hello_ack')), 5000);
  });
  return { ws, received };
}
