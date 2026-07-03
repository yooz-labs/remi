import { describe, expect, test } from 'bun:test';
import {
  ACK_TIMEOUT_MS,
  acknowledgeSend,
  EMPTY_PENDING_SENDS,
  type PendingSend,
  sweepTimeouts,
  trackSend,
} from '../../src/lib/message-ack-tracker';

const NOW = Date.parse('2026-07-03T00:00:00Z');

const entry = (
  messageId: string,
  overrides: Partial<Omit<PendingSend, 'retryCount' | 'messageId'>> = {},
) => ({
  messageId,
  connectionId: 'conn-A',
  sessionId: 'session-1',
  content: 'hello',
  sentAt: NOW,
  ...overrides,
});

describe('trackSend', () => {
  test('adds an entry with retryCount 0', () => {
    const pending = trackSend(EMPTY_PENDING_SENDS, entry('m1'));
    expect(pending.get('m1')).toEqual({ ...entry('m1'), retryCount: 0 });
  });

  test('does not mutate the input map', () => {
    const before = EMPTY_PENDING_SENDS;
    trackSend(before, entry('m1'));
    expect(before.size).toBe(0);
  });

  test('tracking a new id with the same messageId overwrites the old entry', () => {
    const first = trackSend(EMPTY_PENDING_SENDS, entry('m1', { content: 'first' }));
    const second = trackSend(first, entry('m1', { content: 'second' }));
    expect(second.get('m1')?.content).toBe('second');
    expect(second.size).toBe(1);
  });
});

describe('acknowledgeSend', () => {
  test('matches and removes an outstanding send', () => {
    const pending = trackSend(EMPTY_PENDING_SENDS, entry('m1'));
    const result = acknowledgeSend(pending, 'm1');
    expect(result.matched).toBe(true);
    expect(result.pending.has('m1')).toBe(false);
  });

  test('reports no match for an untracked id (e.g. ack for hello/answer)', () => {
    const pending = trackSend(EMPTY_PENDING_SENDS, entry('m1'));
    const result = acknowledgeSend(pending, 'not-tracked');
    expect(result.matched).toBe(false);
    // Unrelated ack must not disturb what IS tracked.
    expect(result.pending.has('m1')).toBe(true);
  });

  test('does not mutate the input map', () => {
    const pending = trackSend(EMPTY_PENDING_SENDS, entry('m1'));
    acknowledgeSend(pending, 'm1');
    expect(pending.has('m1')).toBe(true);
  });

  test('leaves other outstanding sends untouched', () => {
    let pending = trackSend(EMPTY_PENDING_SENDS, entry('m1'));
    pending = trackSend(pending, entry('m2'));
    const result = acknowledgeSend(pending, 'm1');
    expect(result.pending.has('m1')).toBe(false);
    expect(result.pending.has('m2')).toBe(true);
  });
});

describe('sweepTimeouts', () => {
  test('leaves a fresh send untouched', () => {
    const pending = trackSend(EMPTY_PENDING_SENDS, entry('m1', { sentAt: NOW }));
    const result = sweepTimeouts(pending, NOW + 1000);
    expect(result.outcomes).toHaveLength(0);
    expect(result.pending.get('m1')?.retryCount).toBe(0);
  });

  test('boundary: exactly at the timeout retries', () => {
    const pending = trackSend(EMPTY_PENDING_SENDS, entry('m1', { sentAt: NOW }));
    const result = sweepTimeouts(pending, NOW + ACK_TIMEOUT_MS);
    expect(result.outcomes).toEqual([
      { kind: 'retry', entry: { ...entry('m1'), sentAt: NOW + ACK_TIMEOUT_MS, retryCount: 1 } },
    ]);
  });

  test('boundary: one ms under the timeout does not retry', () => {
    const pending = trackSend(EMPTY_PENDING_SENDS, entry('m1', { sentAt: NOW }));
    const result = sweepTimeouts(pending, NOW + ACK_TIMEOUT_MS - 1);
    expect(result.outcomes).toHaveLength(0);
  });

  test('first timeout retries: bumps retryCount, resets sentAt, keeps waiting', () => {
    const pending = trackSend(EMPTY_PENDING_SENDS, entry('m1', { sentAt: NOW }));
    const t1 = NOW + ACK_TIMEOUT_MS;
    const { pending: afterRetry, outcomes } = sweepTimeouts(pending, t1);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual({
      kind: 'retry',
      entry: { ...entry('m1'), sentAt: t1, retryCount: 1 },
    });
    expect(afterRetry.get('m1')).toEqual({ ...entry('m1'), sentAt: t1, retryCount: 1 });
  });

  test('second timeout (already retried) fails and removes the entry', () => {
    let pending = trackSend(EMPTY_PENDING_SENDS, entry('m1', { sentAt: NOW }));
    const t1 = NOW + ACK_TIMEOUT_MS;
    ({ pending } = sweepTimeouts(pending, t1));

    const t2 = t1 + ACK_TIMEOUT_MS;
    const { pending: afterFail, outcomes } = sweepTimeouts(pending, t2);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('failed');
    expect(outcomes[0]?.entry.messageId).toBe('m1');
    expect(afterFail.has('m1')).toBe(false);
  });

  test('an ack between the retry and the second timeout stops the sweep from failing it', () => {
    let pending = trackSend(EMPTY_PENDING_SENDS, entry('m1', { sentAt: NOW }));
    const t1 = NOW + ACK_TIMEOUT_MS;
    ({ pending } = sweepTimeouts(pending, t1));

    // Ack arrives for the retried attempt.
    ({ pending } = acknowledgeSend(pending, 'm1'));

    const t2 = t1 + ACK_TIMEOUT_MS;
    const { outcomes } = sweepTimeouts(pending, t2);
    expect(outcomes).toHaveLength(0);
  });

  test('sweeps multiple outstanding sends independently', () => {
    let pending = trackSend(EMPTY_PENDING_SENDS, entry('m1', { sentAt: NOW }));
    pending = trackSend(pending, entry('m2', { sentAt: NOW + 4000 }));

    // m1 is over the timeout, m2 is not yet.
    const { pending: after, outcomes } = sweepTimeouts(pending, NOW + ACK_TIMEOUT_MS);
    expect(outcomes).toEqual([
      { kind: 'retry', entry: { ...entry('m1'), sentAt: NOW + ACK_TIMEOUT_MS, retryCount: 1 } },
    ]);
    expect(after.get('m2')?.retryCount).toBe(0);
  });

  test('does not mutate the input map', () => {
    const pending = trackSend(EMPTY_PENDING_SENDS, entry('m1', { sentAt: NOW }));
    sweepTimeouts(pending, NOW + ACK_TIMEOUT_MS);
    expect(pending.get('m1')?.retryCount).toBe(0);
  });

  test('empty map sweeps to no outcomes', () => {
    const { pending, outcomes } = sweepTimeouts(EMPTY_PENDING_SENDS, NOW + 100_000);
    expect(outcomes).toHaveLength(0);
    expect(pending.size).toBe(0);
  });
});
