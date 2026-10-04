/**
 * R2 spike (#1197): can `bun test` drive the REAL ConnectionRoom Durable Object?
 *
 * These tests run against the Worker as it was before R2 (code-named rooms,
 * `register` and `join`), only to show that the harness reaches the real object
 * through real WebSockets, real SQLite-backed storage and a real alarm. The R2
 * implementation replaces the protocol, and with it this file.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { type TestWorker, get, startWorker } from './harness.ts';

let worker: TestWorker;
// A fresh Worker per test: Miniflare gives every request the same client address,
// so the Worker's per-IP limiter would otherwise be shared across tests.
beforeEach(async () => {
  worker = await startWorker();
});
afterEach(() => worker.stop());

function open(code: string): Promise<WebSocket> {
  const ws = new WebSocket(`${worker.wsUrl}/connect/${code}`);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('websocket failed'));
  });
}

function next(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 5_000);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(e.data)));
    };
  });
}

test('a host and a client reach the real Durable Object and relay both ways', async () => {
  const host = await open('ABCD-2345');
  const registered = next(host);
  host.send(JSON.stringify({ type: 'register' }));
  expect(await registered).toMatchObject({ type: 'registered', code: 'ABCD-2345' });

  const client = await open('ABCD-2345');
  const joined = next(client);
  const hostSees = next(host);
  client.send(JSON.stringify({ type: 'join', code: 'ABCD-2345' }));
  expect(await joined).toEqual({ type: 'joined', code: 'ABCD-2345' });
  expect(await hostSees).toEqual({ type: 'peer-connected', role: 'client' });

  const atHost = next(host);
  client.send(JSON.stringify({ type: 'relay', payload: 'from-client' }));
  expect(await atHost).toEqual({ type: 'relay', payload: 'from-client' });
  host.close();
  client.close();
});

test('the room is backed by real storage and a real alarm', async () => {
  const host = await open('EFGH-3456');
  const registered = next(host);
  host.send(JSON.stringify({ type: 'register' }));
  await registered;

  const state = (await (await get(`${worker.url}/__room/EFGH-3456/__state`)).json()) as {
    storage: { code: string };
    alarm: number | null;
    sockets: number;
  };
  expect(state.storage.code).toBe('EFGH-3456');
  expect(typeof state.alarm).toBe('number');
  expect(state.sockets).toBe(1);
  host.close();
});
