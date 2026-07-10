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
import * as path from 'node:path';
import { createSessionListRequest, serialize } from '@remi/shared/protocol.ts';
import type { SessionListResponseMessage } from '@remi/shared/protocol.ts';
import {
  CLI_TS,
  type HubHandle,
  cleanupHub,
  connectAndHello,
  pollUntil,
  spawnHub as spawnHubShared,
} from './hub-test-utils.ts';

const hubs: HubHandle[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await cleanupHub(hub);
  }
});

async function spawnHub(): Promise<HubHandle> {
  const hub = await spawnHubShared();
  hubs.push(hub);
  return hub;
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
    // The daemon stamps its binary version for the stale-daemon check (#539).
    expect(typeof status.version).toBe('string');
    expect(status.version.length).toBeGreaterThan(0);

    // Protocol: session-less hello_ack, not a NO_SESSION error.
    const { ws, received } = await connectAndHello(hub.port);
    const ack = received.find((m) => m.type === 'hello_ack');
    expect(ack).toBeDefined();
    expect((ack as { sessionId: unknown }).sessionId).toBeNull();
    // The real subprocess stamps its binary version on the wire (#539).
    const daemonVersion = (ack as { daemonVersion?: unknown }).daemonVersion;
    expect(typeof daemonVersion).toBe('string');
    expect((daemonVersion as string).length).toBeGreaterThan(0);
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

    // The hub must NOT have touched its cwd's Claude hook config, must NOT
    // have installed the statusline into the global ~/.claude/settings.json
    // (a session-less hub never runs Claude), and must NOT appear in
    // live-sessions as a phantom session.
    expect(fs.existsSync(path.join(hub.work, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(hub.home, '.claude', 'settings.json'))).toBe(false);
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
