/** Real hub/API-created daemon + PTY + Worker teardown, including a failed test body. */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCreateSessionRequest, createHello } from '@remi/shared';
import { CAPABILITY_HEADER } from '../../daemon/src/auth/capability-token';
import { Mailbox } from '../../signaling/tests/e2e/endpoints';
import { cleanupOwnedRelayFixtures, ownedRelayChild, ownedRelayHub } from './helpers/relay-hub';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await Bun.sleep(10);
  }
  return false;
}

test('owned fixture cleanup stops API-created daemons, PTY children and real Worker after body failure', async () => {
  const running = await ownedRelayHub();
  const direct = await ownedRelayChild(running);
  const registry = join(running.dir, 'state/live-sessions');
  const ws = new WebSocket(`ws://127.0.0.1:${running.port}/ws`, {
    headers: { [CAPABILITY_HEADER]: running.capability },
  } as never);
  const inbox = new Mailbox<Record<string, unknown>>();
  ws.onmessage = (event) => inbox.push(JSON.parse(String(event.data)));
  const pids = new Set<number>([running.proc.pid, direct.child.pid]);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('owned capability refused'));
    });
    ws.send(JSON.stringify(createHello('owned-lifecycle', '2')));
    for (let i = 0; i < 32; i++) if ((await inbox.next(10000))['type'] === 'hello_ack') break;
    const request = createCreateSessionRequest(running.dir);
    ws.send(JSON.stringify(request));
    let response: Record<string, unknown> | undefined;
    for (let i = 0; i < 32; i++) {
      const message = await inbox.next(10000);
      if (message['type'] === 'create_session_response' && message['requestId'] === request.id) {
        response = message;
        break;
      }
    }
    expect(response?.['success']).toBe(true);
    let entries: { pid: number; claudeChildPid: number }[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      entries = readdirSync(registry)
        .filter((name) => name.endsWith('.json'))
        .map(
          (name) =>
            JSON.parse(readFileSync(join(registry, name), 'utf8')) as {
              pid: number;
              claudeChildPid: number;
            },
        );
      if (entries.length === 2 && entries.every((entry) => Number.isInteger(entry.claudeChildPid)))
        break;
      await Bun.sleep(10);
    }
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      pids.add(entry.pid);
      pids.add(entry.claudeChildPid);
      expect(alive(entry.pid)).toBe(true);
      expect(alive(entry.claudeChildPid)).toBe(true);
    }
    // The same cleanup registered with afterEach must run when the body rejects.
    let rejected = false;
    try {
      throw new Error('owned lifecycle body failure');
    } catch {
      rejected = true;
    } finally {
      ws.close();
      await cleanupOwnedRelayFixtures();
    }
    expect(rejected).toBe(true);
    for (const pid of pids) expect(await gone(pid)).toBe(true);
    let workerReachable = false;
    try {
      await fetch(`${running.worker.url}/health`, { signal: AbortSignal.timeout(300) });
      workerReachable = true;
    } catch {
      /* disposed real Worker */
    }
    expect(workerReachable).toBe(false);
    expect(existsSync(running.dir)).toBe(false);
  } finally {
    ws.close();
    // Red-pin failures must not leave the exact private fixture PIDs behind.
    if (existsSync(registry))
      for (const name of readdirSync(registry)) {
        if (!name.endsWith('.json')) continue;
        const entry = JSON.parse(readFileSync(join(registry, name), 'utf8'));
        for (const pid of [entry.pid, entry.claudeChildPid])
          if (Number.isInteger(pid)) pids.add(pid);
      }
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM');
    await cleanupOwnedRelayFixtures();
    for (const pid of pids) await gone(pid);
  }
}, 20000);
