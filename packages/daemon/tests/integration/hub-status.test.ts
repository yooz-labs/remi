/**
 * Integration test for the `hub_status` census broadcast (#650): a REAL hub
 * subprocess (isolated $HOME, no mocks), real WS clients. Verifies the
 * counting rules end-to-end: query clients receive frames but never count;
 * a normal loopback client bumps localClients and every connection hears the
 * broadcast; disconnect drops the count back.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHello, deserialize, serialize } from '@remi/shared/protocol.ts';
import type { HubStatusMessage, ProtocolMessage } from '@remi/shared/protocol.ts';
import { type HubHandle, cleanupHub, pollUntil, spawnHub } from './hub-test-utils.ts';

const hubs: HubHandle[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await cleanupHub(hub);
  }
});

interface Client {
  ws: WebSocket;
  received: ProtocolMessage[];
}

/** Connect and hello (optionally query-mode); resolve after hello_ack. */
async function connect(port: number, mode?: 'query'): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const received: ProtocolMessage[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () =>
      ws.send(serialize(createHello('hub-status-test', '1.0.0', mode ? { mode } : {})));
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

function statusFrames(client: Client): HubStatusMessage[] {
  return client.received.filter((m): m is HubStatusMessage => m.type === 'hub_status');
}

function lastStatus(client: Client): HubStatusMessage | undefined {
  const frames = statusFrames(client);
  return frames[frames.length - 1];
}

describe('hub_status census (integration, #650)', () => {
  test('query clients see frames but never count; normal clients do; disconnect decrements', async () => {
    const hub = await spawnHub();
    hubs.push(hub);

    // 1. Query client (the menu-bar app's shape): receives the initial
    //    census right after hello_ack, and is not counted.
    const monitor = await connect(hub.port, 'query');
    await pollUntil(() => lastStatus(monitor) !== undefined, 5000, 'initial hub_status');
    const initial = lastStatus(monitor);
    expect(initial?.localClients).toBe(0);
    expect(initial?.remoteClients).toBe(0);
    expect(initial?.sessions).toBe(0);
    expect(initial?.hubVersion).toMatch(/^\d+\.\d+\.\d+/);

    // Exactly-once delivery (#744 review): the monitor's connect changed no
    // counts, so it got exactly one frame (the direct send), no duplicate.
    expect(statusFrames(monitor)).toHaveLength(1);

    // 2. A normal loopback client connects: counted as local, and the
    //    change is broadcast to the already-connected monitor too.
    const user = await connect(hub.port);
    await pollUntil(
      () => lastStatus(monitor)?.localClients === 1,
      5000,
      'broadcast after normal client connect',
    );
    await pollUntil(
      () => lastStatus(user)?.localClients === 1,
      5000,
      'initial frame on the normal client',
    );
    expect(lastStatus(monitor)?.remoteClients).toBe(0);
    // Exactly-once for the counting client too: its own connect changed the
    // counts, so the broadcast is its one and only frame.
    expect(statusFrames(user)).toHaveLength(1);
    expect(statusFrames(monitor)).toHaveLength(2);

    // 3. The normal client disconnects: census drops back to zero on the
    //    monitor's connection.
    user.ws.close();
    await pollUntil(
      () => lastStatus(monitor)?.localClients === 0,
      5000,
      'broadcast after disconnect',
    );

    monitor.ws.close();
  }, 30000);

  test('two simultaneous local clients aggregate; each disconnect decrements', async () => {
    const hub = await spawnHub();
    hubs.push(hub);

    const monitor = await connect(hub.port, 'query');
    const userA = await connect(hub.port);
    const userB = await connect(hub.port);
    await pollUntil(
      () => lastStatus(monitor)?.localClients === 2,
      5000,
      'census with two concurrent local clients',
    );
    expect(lastStatus(monitor)?.remoteClients).toBe(0);

    userA.ws.close();
    await pollUntil(
      () => lastStatus(monitor)?.localClients === 1,
      5000,
      'decrement after first disconnect',
    );

    userB.ws.close();
    monitor.ws.close();
  }, 30000);

  test('child session registration/removal broadcasts the sessions census (#650)', async () => {
    const hub = await spawnHub();
    hubs.push(hub);

    const monitor = await connect(hub.port, 'query');
    await pollUntil(() => lastStatus(monitor) !== undefined, 5000, 'initial hub_status');
    expect(lastStatus(monitor)?.sessions).toBe(0);

    // A child session daemon registers exactly like the real spawn path
    // does: a LiveSessionEntry file lands in the hub's live-sessions dir.
    // The pid is this test process, so the entry probes as alive.
    const liveDir = path.join(hub.home, '.remi', 'live-sessions');
    fs.mkdirSync(liveDir, { recursive: true });
    const entry = {
      sessionId: '33333333-3333-3333-3333-333333333333',
      pid: process.pid,
      wsPort: hub.port + 1,
      hookPort: 0,
      projectPath: hub.work,
      name: 'child-session',
      startedAt: new Date().toISOString(),
      claudeChildPid: process.pid,
    };
    const entryPath = path.join(liveDir, `${entry.sessionId}.json`);
    fs.writeFileSync(entryPath, JSON.stringify(entry));

    // Full chain: file write -> fs.watch -> debounced flush -> onDirChange ->
    // tracker.refresh() -> broadcast with the incremented sessions count.
    await pollUntil(
      () => lastStatus(monitor)?.sessions === 1,
      10000,
      'sessions census after registration',
    );

    // Removal (session ended, daemon unregistered) drops it back — this is
    // exactly the path that never produces a session_list broadcast.
    fs.unlinkSync(entryPath);
    await pollUntil(
      () => lastStatus(monitor)?.sessions === 0,
      10000,
      'sessions census after removal',
    );

    monitor.ws.close();
  }, 30000);
});
