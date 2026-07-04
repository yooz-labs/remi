import { describe, expect, test } from 'bun:test';
import { type AckWaiters, awaitAck, resolveAckWaiter } from '../../src/lib/ack-waiter';

describe('awaitAck / resolveAckWaiter (#690)', () => {
  test('resolves true when resolveAckWaiter is called before the timeout', async () => {
    const waiters: AckWaiters = new Map();
    const promise = awaitAck(waiters, 'msg-1', 2000);
    resolveAckWaiter(waiters, 'msg-1');
    expect(await promise).toBe(true);
  });

  test('removes the waiter once resolved', async () => {
    const waiters: AckWaiters = new Map();
    const promise = awaitAck(waiters, 'msg-1', 2000);
    resolveAckWaiter(waiters, 'msg-1');
    await promise;
    expect(waiters.has('msg-1')).toBe(false);
  });

  test('resolves false when the timeout elapses with no matching ack', async () => {
    const waiters: AckWaiters = new Map();
    const result = await awaitAck(waiters, 'msg-2', 20);
    expect(result).toBe(false);
    expect(waiters.has('msg-2')).toBe(false);
  });

  test('resolveAckWaiter for an unknown id is a no-op (does not throw)', () => {
    const waiters: AckWaiters = new Map();
    expect(() => resolveAckWaiter(waiters, 'no-such-id')).not.toThrow();
  });

  test('resolving an id twice is safe (second call is a no-op)', async () => {
    const waiters: AckWaiters = new Map();
    const promise = awaitAck(waiters, 'msg-3', 2000);
    resolveAckWaiter(waiters, 'msg-3');
    expect(() => resolveAckWaiter(waiters, 'msg-3')).not.toThrow();
    expect(await promise).toBe(true);
  });

  test('two concurrent waiters for different ids do not interfere', async () => {
    const waiters: AckWaiters = new Map();
    const p1 = awaitAck(waiters, 'msg-a', 2000);
    const p2 = awaitAck(waiters, 'msg-b', 20);
    resolveAckWaiter(waiters, 'msg-a');
    expect(await p1).toBe(true);
    expect(await p2).toBe(false); // msg-b times out, unaffected by msg-a resolving
    expect(waiters.size).toBe(0);
  });

  test('resolving one id does not resolve an unrelated pending waiter', async () => {
    const waiters: AckWaiters = new Map();
    const p1 = awaitAck(waiters, 'msg-x', 2000);
    resolveAckWaiter(waiters, 'msg-y'); // no matching waiter
    expect(waiters.has('msg-x')).toBe(true);
    resolveAckWaiter(waiters, 'msg-x');
    expect(await p1).toBe(true);
  });
});
