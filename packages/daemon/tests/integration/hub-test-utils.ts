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
import { findAvailableTcpPort } from '../../src/session/port-utils.ts';

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

export async function findTestPort(): Promise<number> {
  const port = await findAvailableTcpPort(19200, 200);
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
  return { ...env, ...overrides };
}

/** Spawn `remi serve` without waiting for readiness (for exit-path tests). */
export function spawnServeRaw(
  home: string,
  work: string,
  port: number,
  envOverrides: Record<string, string> = {},
): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(
    [
      'bun',
      CLI_TS,
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

/** Spawn a hub in a fresh isolated $HOME and wait for its status file. */
export async function spawnHub(dirs?: { home: string; work: string }): Promise<HubHandle> {
  const { home, work } = dirs ?? makeIsolatedDirs();
  const port = await findTestPort();
  const proc = spawnServeRaw(home, work, port);
  const hub: HubHandle = { proc, home, work, port };

  const statusFile = path.join(home, '.remi', 'daemon-status.json');
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
