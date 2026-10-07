/**
 * The question resolver (#1235, ADR 0038): every path that dismisses a card goes through it. It
 * broadcasts `question_resolved` and sends the quiet lock-screen dismissal once per card, so the
 * first resolution wins and a later one cannot contradict its `resolvedBy`.
 */

import { describe, expect, test } from 'bun:test';
import type { QuestionResolvedMessage, UUID } from '@remi/shared';
import { causeOfSessionClose, createQuestionResolver } from '../../src/cli/question-resolution.ts';

const SID = '11111111-1111-4111-8111-111111111111' as UUID;
const Q1 = '22222222-2222-4222-8222-222222222222' as UUID;
const Q2 = '33333333-3333-4333-8333-333333333333' as UUID;

function setup() {
  const sent: QuestionResolvedMessage[] = [];
  const dismissed: string[] = [];
  const resolver = createQuestionResolver({
    broadcast: (message) => sent.push(message),
    dismissPush: (_sessionId, questionId) => dismissed.push(questionId),
    logError: () => {},
  });
  return { resolver, sent, dismissed };
}

describe('createQuestionResolver (#1235)', () => {
  test('a resolution carries its cause when one is known, and none when it is not', () => {
    const { resolver, sent } = setup();
    resolver.resolve(SID, Q1, 'answered', 'phone');
    resolver.resolve(SID, Q2, 'cancelled');
    expect(sent.map((m) => [m.questionId, m.reason, m.resolvedBy])).toEqual([
      [Q1, 'answered', 'phone'],
      [Q2, 'cancelled', undefined],
    ]);
    expect(sent[1]).not.toHaveProperty('resolvedBy');
  });

  test('the first resolution of a card wins: a second is neither broadcast nor pushed', () => {
    const { resolver, sent, dismissed } = setup();
    expect(resolver.resolve(SID, Q1, 'answered', 'phone')).toBe(true);
    expect(resolver.resolve(SID, Q1, 'cancelled', 'terminal')).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.resolvedBy).toBe('phone');
    expect(dismissed).toEqual([Q1]);
  });

  test('a card that is live again can be resolved again', () => {
    const { resolver, sent } = setup();
    resolver.resolve(SID, Q1, 'cancelled', 'timeout');
    resolver.noteLive([Q1]);
    expect(resolver.resolve(SID, Q1, 'answered', 'phone')).toBe(true);
    expect(sent.map((m) => m.resolvedBy)).toEqual(['timeout', 'phone']);
  });

  test('a broadcast that throws still sends the dismissal, and the reverse', () => {
    const dismissed: string[] = [];
    const errors: string[] = [];
    const resolver = createQuestionResolver({
      broadcast: () => {
        throw new Error('socket gone');
      },
      dismissPush: (_s, q) => dismissed.push(q),
      logError: (line) => errors.push(line),
    });
    resolver.resolve(SID, Q1, 'answered', 'phone');
    expect(dismissed).toEqual([Q1]);
    expect(errors.join('\n')).toContain('socket gone');
  });

  test('it remembers the last 1024 resolved cards', () => {
    const { resolver } = setup();
    const ids = Array.from(
      { length: 1025 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` as UUID,
    );
    for (const id of ids) resolver.resolve(SID, id, 'cancelled', 'timeout');
    // The 1025th pushed the first out; the second is still remembered.
    expect(resolver.resolve(SID, ids[1] as UUID, 'cancelled', 'timeout')).toBe(false);
    expect(resolver.resolve(SID, ids[0] as UUID, 'cancelled', 'timeout')).toBe(true);
  });

  test('a resolution with no cause can be followed by one that names it; never the reverse (#1292 review)', () => {
    const { resolver, sent } = setup();
    // A render superseded the card while the phone's typed answer was being applied.
    expect(resolver.resolve(SID, Q1, 'cancelled')).toBe(true);
    expect(resolver.resolve(SID, Q1, 'answered', 'phone')).toBe(true);
    expect(resolver.resolve(SID, Q1, 'cancelled')).toBe(false);
    expect(resolver.resolve(SID, Q1, 'cancelled', 'terminal')).toBe(false);
    expect(sent.map((m) => m.resolvedBy)).toEqual([undefined, 'phone']);
  });
});

describe('causeOfSessionClose (#1235)', () => {
  test('the agent exiting is the harness; remi closing the session names no cause', () => {
    expect(causeOfSessionClose('pty_exit')).toBe('harness');
    expect(causeOfSessionClose('forced')).toBeUndefined();
    expect(causeOfSessionClose('timeout')).toBeUndefined();
  });
});
