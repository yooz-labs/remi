/**
 * Pin tests for what R2 (#1197) deletes, against the REAL Worker and Durable
 * Object. They describe the target behavior, so they are RED on the Worker as
 * it was before R2 and turn green when R2 lands:
 *
 * - the code-named room route `/connect/<code>` (the room was the 30-bit code,
 *   and whoever registered first became host with no proof);
 * - the `/answer/<code>` HTTP relay into the host socket.
 *
 * The offer, answer and ice-candidate forwarding lived only inside the first
 * route's room, so removing the route removes it; the replacement room does not
 * understand those message types (`room-protocol.e2e.test.ts`).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { type TestWorker, get, startWorker } from './harness.ts';

let worker: TestWorker;
beforeEach(async () => {
  worker = await startWorker();
});
afterEach(() => worker.stop());

test('the code-named room route is gone: an upgrade to /connect/<code> does not open', async () => {
  const opened = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${worker.wsUrl}/connect/ABCD-2345`);
    ws.onopen = () => {
      ws.close();
      resolve(true);
    };
    ws.onerror = () => resolve(false);
  });
  expect(opened).toBe(false);
});

test('the answer relay is gone: POST /answer/<code> is a 404', async () => {
  const res = await get(`${worker.url}/answer/ABCD-2345`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', questionId: 'q', answer: 'yes' }),
  });
  expect(res.status).toBe(404);
});
