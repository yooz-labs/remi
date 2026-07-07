/**
 * End-to-end integration test for the session-less hub (`remi serve`, #542).
 *
 * Spawns the REAL cli.ts as a subprocess with an isolated $HOME (Bun's
 * os.homedir() respects it), so every ~/.remi artifact (daemon.pid,
 * daemon-status.json, live-sessions/) lands in a mkdtemp sandbox — never the
 * developer's real ~/.remi. The hub never spawns Claude, so a full boot is
 * cheap enough to exercise for real: no mocks anywhere.
 *
 * Covers the #542 invariants:
 *  - hub self-writes daemon.pid (split-brain fix) and cleans it on SIGTERM
 *  - status file has sessionId null + mode 'hub'
 *  - a WS client gets a session-less hello_ack (sessionId null) and an empty
 *    session list — never a NO_SESSION error
 *  - the hub does NOT install Claude hook config in its cwd and does NOT
 *    register itself in live-sessions (no phantom session)
 *  - the live-sessions watcher broadcasts sibling daemons' ports (daemonPorts)
 *  - `remi status` finds the hub via the status-file fallback even when
 *    daemon.pid is missing
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deserialize, serialize } from '@remi/shared/protocol.ts';
import { createHello, createSessionListRequest } from '@remi/shared/protocol.ts';
import type { ProtocolMessage, SessionListResponseMessage } from '@remi/shared/protocol.ts';
import { findAvailableTcpPort } from '../../src/session/port-utils.ts';

const CLI_TS = path.resolve(import.meta.dir, '../../src/cli.ts');

interface HubHandle {
  proc: ReturnType<typeof Bun.spawn>;
  home: string;
  work: string;
  port: number;
}

const hubs: HubHandle[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    try {
      hub.proc.kill('SIGKILL');
      await hub.proc.exited;
    } catch {
      // already dead
    }
    fs.rmSync(hub.home, { recursive: true, force: true });
    fs.rmSync(hub.work, { recursive: true, force: true });
  }
});

async function pollUntil(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function spawnHub(): Promise<HubHandle> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hub-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hub-work-'));
  const port = await findAvailableTcpPort(19200, 200);
  if (port === null) throw new Error('No free test port');

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
  };
  // A stray inherited port/child marker would defeat the isolation.
  // biome-ignore lint/performance/noDelete: must truly remove env var from child process
  delete env['REMI_PORT'];
  // biome-ignore lint/performance/noDelete: must truly remove env var from child process
  delete env['REMI_SPAWNED_CHILD'];

  const proc = Bun.spawn(
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
    { cwd: work, env, stdout: 'pipe', stderr: 'pipe' },
  );

  const hub: HubHandle = { proc, home, work, port };
  hubs.push(hub);

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

/** Open a WS to the hub, send hello, resolve once hello_ack arrives. Returns
 *  the socket plus a growing message log the test can keep asserting on. */
async function connectAndHello(
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

describe('remi serve hub (integration, #542)', () => {
  test('boots session-less: pid file, hub status, null hello_ack, empty list, clean stop', async () => {
    const hub = await spawnHub();
    const remiDir = path.join(hub.home, '.remi');

    // Self-written PID file names the hub process itself (split-brain fix).
    const pidContent = fs.readFileSync(path.join(remiDir, 'daemon.pid'), 'utf-8').trim();
    expect(Number.parseInt(pidContent, 10)).toBe(hub.proc.pid);

    // Status file: no session, hub mode.
    const status = JSON.parse(fs.readFileSync(path.join(remiDir, 'daemon-status.json'), 'utf-8'));
    expect(status.sessionId).toBeNull();
    expect(status.mode).toBe('hub');
    expect(status.pid).toBe(hub.proc.pid);

    // Protocol: session-less hello_ack, not a NO_SESSION error.
    const { ws, received } = await connectAndHello(hub.port);
    const ack = received.find((m) => m.type === 'hello_ack');
    expect(ack).toBeDefined();
    expect((ack as { sessionId: unknown }).sessionId).toBeNull();
    expect(received.some((m) => m.type === 'error')).toBe(false);

    // Session list: empty sessions from a hub with no children.
    ws.send(serialize(createSessionListRequest()));
    await pollUntil(
      () => received.some((m) => m.type === 'session_list_response'),
      5000,
      'session_list_response',
    );
    const list = received.find(
      (m): m is SessionListResponseMessage => m.type === 'session_list_response',
    );
    expect(list?.sessions).toEqual([]);

    // The hub must NOT have touched its cwd's Claude hook config, and must
    // NOT appear in live-sessions as a phantom session.
    expect(fs.existsSync(path.join(hub.work, '.claude'))).toBe(false);
    const liveDir = path.join(remiDir, 'live-sessions');
    const liveEntries = fs.existsSync(liveDir) ? fs.readdirSync(liveDir) : [];
    expect(liveEntries).toEqual([]);

    ws.close();

    // Clean stop: SIGTERM exits 0 and removes the self-written PID file.
    hub.proc.kill('SIGTERM');
    const code = await hub.proc.exited;
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(remiDir, 'daemon.pid'))).toBe(false);
  }, 30000);

  test('broadcasts sibling daemons via the watcher; status falls back to the status file', async () => {
    const hub = await spawnHub();
    const remiDir = path.join(hub.home, '.remi');
    const { ws, received } = await connectAndHello(hub.port);

    // A sibling session daemon registers in the shared live-sessions dir
    // (raw entry, pid = this test process so it probes as alive). The hub's
    // watcher must broadcast an updated list carrying the sibling's port.
    const liveDir = path.join(remiDir, 'live-sessions');
    fs.mkdirSync(liveDir, { recursive: true });
    const siblingPort = hub.port + 1;
    const entry = {
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      pid: process.pid,
      wsPort: siblingPort,
      hookPort: 0,
      projectPath: hub.work,
      name: 'fake-sibling',
      startedAt: new Date().toISOString(),
      claudeChildPid: process.pid,
    };
    fs.writeFileSync(path.join(liveDir, `${entry.sessionId}.json`), JSON.stringify(entry));

    await pollUntil(
      () =>
        received.some(
          (m) => m.type === 'session_list_response' && (m.daemonPorts ?? []).includes(siblingPort),
        ),
      10000,
      'watcher broadcast with sibling port',
    );

    ws.close();

    // Split-brain fallback: with daemon.pid gone, `remi status` still finds
    // the live hub through its self-written status file.
    fs.unlinkSync(path.join(remiDir, 'daemon.pid'));
    const statusProc = Bun.spawn(['bun', CLI_TS, 'status'], {
      env: { ...process.env, HOME: hub.home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await statusProc.exited;
    const out = await new Response(statusProc.stdout).text();
    expect(out).toContain(`PID ${hub.proc.pid}`);
    expect(out).toContain('Mode: hub');

    hub.proc.kill('SIGTERM');
    expect(await hub.proc.exited).toBe(0);
  }, 30000);
});
