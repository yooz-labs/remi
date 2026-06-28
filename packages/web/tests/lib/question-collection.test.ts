/**
 * Tests for the client's composite-key question collection (#437). Pure
 * functions; no mocks.
 */

import { describe, expect, test } from 'bun:test';
import {
  STATUS_CLEAR_FRESHNESS_MS,
  clearMainQuestionOnStatus,
  clearSessionQuestions,
  getSessionQuestions,
  hasSessionQuestion,
  isQuestionPending,
  markQuestionResolved,
  questionKey,
  removeQuestionById,
  removeQuestionByKeyIfId,
  statusClearsMainQuestion,
} from '../../src/lib/question-collection';
import type { UIQuestion } from '../../src/types';

const BASE_TS = '2026-05-29T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_TS);

function q(sessionId: string, agentId: string | undefined, id: string): UIQuestion {
  return {
    id: id as UIQuestion['id'],
    sessionId: sessionId as UIQuestion['sessionId'],
    type: 'yes_no',
    prompt: `${id}?`,
    timestamp: BASE_TS,
    agentId,
  };
}

function qWith(base: UIQuestion, overrides: Partial<UIQuestion>): UIQuestion {
  return { ...base, ...overrides };
}

function build(...items: UIQuestion[]): Map<string, UIQuestion> {
  const m = new Map<string, UIQuestion>();
  for (const item of items) m.set(questionKey(item.sessionId, item.agentId), item);
  return m;
}

describe('questionKey', () => {
  test('defaults agent to main', () => {
    expect(questionKey('s1')).toBe('s1#main');
    expect(questionKey('s1', undefined)).toBe('s1#main');
  });
  test('scopes by agent', () => {
    expect(questionKey('s1', 'sub-7')).toBe('s1#sub-7');
  });
  test('main and a subagent get distinct keys for the same session', () => {
    expect(questionKey('s1')).not.toBe(questionKey('s1', 'sub-7'));
  });
});

describe('getSessionQuestions', () => {
  test('returns all questions for a session across agents, in insertion order', () => {
    const map = build(q('s1', undefined, 'a'), q('s1', 'sub-7', 'b'), q('s2', undefined, 'c'));
    const got = getSessionQuestions(map, 's1');
    expect(got.map((x) => x.id)).toEqual(['a', 'b']);
  });
  test('empty for an unknown session', () => {
    expect(getSessionQuestions(build(q('s1', undefined, 'a')), 's2')).toEqual([]);
  });
});

describe('hasSessionQuestion', () => {
  test('true when any agent has a prompt for the session', () => {
    expect(hasSessionQuestion(build(q('s1', 'sub-7', 'a')), 's1')).toBe(true);
  });
  test('false otherwise', () => {
    expect(hasSessionQuestion(build(q('s1', undefined, 'a')), 's2')).toBe(false);
  });
});

describe('clearSessionQuestions', () => {
  test('removes all of a session, keeps others', () => {
    const map = build(q('s1', undefined, 'a'), q('s1', 'sub-7', 'b'), q('s2', undefined, 'c'));
    const next = clearSessionQuestions(map, 's1');
    expect(getSessionQuestions(next, 's1')).toEqual([]);
    expect(getSessionQuestions(next, 's2').map((x) => x.id)).toEqual(['c']);
  });
  test('returns the same reference when nothing matched (no-op update)', () => {
    const map = build(q('s1', undefined, 'a'));
    expect(clearSessionQuestions(map, 's2')).toBe(map);
  });
});

describe('removeQuestionById (#585 P7)', () => {
  test('removes the matching question by id within the session, keeps siblings', () => {
    const map = build(q('s1', undefined, 'a'), q('s1', 'sub-7', 'b'), q('s2', undefined, 'c'));
    const next = removeQuestionById(map, 's1', 'b');
    // The subagent prompt 'b' is gone; the main 'a' and the other session 'c' remain.
    expect(getSessionQuestions(next, 's1').map((x) => x.id)).toEqual(['a']);
    expect(getSessionQuestions(next, 's2').map((x) => x.id)).toEqual(['c']);
  });

  test('returns the same reference when the id is not present (idempotent / no-op)', () => {
    const map = build(q('s1', undefined, 'a'));
    expect(removeQuestionById(map, 's1', 'nope')).toBe(map);
  });

  test('does not remove a same-id question belonging to a different session', () => {
    const map = build(q('s1', undefined, 'dup'), q('s2', undefined, 'dup'));
    const next = removeQuestionById(map, 's1', 'dup');
    expect(getSessionQuestions(next, 's1')).toEqual([]);
    expect(getSessionQuestions(next, 's2').map((x) => x.id)).toEqual(['dup']);
  });
});

describe('statusClearsMainQuestion (#576)', () => {
  test("'waiting' never clears (the prompt is still open)", () => {
    expect(statusClearsMainQuestion('waiting')).toBe(false);
  });

  test("transient auto-approve states 'evaluating'/'approved' do NOT clear the card", () => {
    // Regression: a second permission's onEvalStart ('evaluating') or a
    // gate auto-approval ('approved') must not delete a card the user is
    // still looking at.
    expect(statusClearsMainQuestion('evaluating')).toBe(false);
    expect(statusClearsMainQuestion('approved')).toBe(false);
  });

  test("real hook statuses still clear the resolved main-agent card", () => {
    expect(statusClearsMainQuestion('thinking')).toBe(true);
    expect(statusClearsMainQuestion('executing')).toBe(true);
    expect(statusClearsMainQuestion('idle')).toBe(true);
    expect(statusClearsMainQuestion('starting')).toBe(true);
  });
});

describe('removeQuestionByKeyIfId (#652)', () => {
  test('removes the entry when the slot still holds the same id', () => {
    const map = build(q('s1', undefined, 'a'));
    const next = removeQuestionByKeyIfId(map, questionKey('s1'), 'a');
    expect(getSessionQuestions(next, 's1')).toEqual([]);
  });

  test('NO-OP when the slot was reused by a newer prompt (the core fix)', () => {
    // The post-answer timer captured key s1#main for id 'a', but id 'b' took the
    // slot before it fired; deleting by key alone would wipe the new card.
    const map = build(q('s1', undefined, 'b'));
    expect(removeQuestionByKeyIfId(map, questionKey('s1'), 'a')).toBe(map);
    expect(getSessionQuestions(map, 's1').map((x) => x.id)).toEqual(['b']);
  });

  test('NO-OP (same reference) when the key is absent', () => {
    const map = build(q('s1', undefined, 'a'));
    expect(removeQuestionByKeyIfId(map, questionKey('s2'), 'a')).toBe(map);
  });
});

describe('clearMainQuestionOnStatus (#652)', () => {
  test('non-clearing status is a no-op (same reference)', () => {
    const map = build(q('s1', undefined, 'a'));
    expect(clearMainQuestionOnStatus(map, 's1', 'waiting', { now: () => BASE_MS })).toBe(map);
  });

  test('protects a FRESH card from a status update racing it in the same burst', () => {
    const map = build(q('s1', undefined, 'a'));
    const next = clearMainQuestionOnStatus(map, 's1', 'executing', {
      now: () => BASE_MS + 500, // 500ms old, inside the 2s window
    });
    expect(next).toBe(map);
    expect(getSessionQuestions(next, 's1').map((x) => x.id)).toEqual(['a']);
  });

  test('clears a STALE main card the agent has moved past', () => {
    const map = build(q('s1', undefined, 'a'));
    const next = clearMainQuestionOnStatus(map, 's1', 'executing', {
      now: () => BASE_MS + STATUS_CLEAR_FRESHNESS_MS + 1,
    });
    expect(getSessionQuestions(next, 's1')).toEqual([]);
  });

  test('clears only the MAIN slot; a concurrent subagent prompt survives', () => {
    const map = build(q('s1', undefined, 'a'), q('s1', 'sub-7', 'b'));
    const next = clearMainQuestionOnStatus(map, 's1', 'idle', {
      now: () => BASE_MS + STATUS_CLEAR_FRESHNESS_MS + 1,
    });
    expect(getSessionQuestions(next, 's1').map((x) => x.id)).toEqual(['b']);
  });

  test('no main card present is a no-op (same reference)', () => {
    const map = build(q('s1', 'sub-7', 'b'));
    expect(
      clearMainQuestionOnStatus(map, 's1', 'idle', { now: () => BASE_MS + 10_000 }),
    ).toBe(map);
  });

  test('a malformed timestamp fails open to clearing (never pins the UI)', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { timestamp: 'not-a-date' as never }));
    const next = clearMainQuestionOnStatus(map, 's1', 'executing', { now: () => BASE_MS });
    expect(getSessionQuestions(next, 's1')).toEqual([]);
  });
});

describe('markQuestionResolved (#652)', () => {
  test('flips a still-pending card to a resolved-elsewhere trace, keeping it on screen', () => {
    const map = build(q('s1', undefined, 'a'));
    const next = markQuestionResolved(map, 's1', 'a', 'answered');
    const card = next.get(questionKey('s1'));
    expect(card?.resolvedReason).toBe('answered');
    expect(getSessionQuestions(next, 's1').map((x) => x.id)).toEqual(['a']);
  });

  test('NO-OP when the card was already answered locally (owns its own trace/timer)', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { answeredWith: '1' }));
    expect(markQuestionResolved(map, 's1', 'a', 'answered')).toBe(map);
  });

  test('NO-OP while the card is submitting (#627 auto-answer in flight)', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { submitting: true }));
    expect(markQuestionResolved(map, 's1', 'a', 'auto_approved')).toBe(map);
  });

  test('NO-OP on a duplicate broadcast (already marked resolved)', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { resolvedReason: 'cancelled' }));
    expect(markQuestionResolved(map, 's1', 'a', 'answered')).toBe(map);
  });

  test('NO-OP (same reference) when the card is absent', () => {
    const map = build(q('s1', undefined, 'a'));
    expect(markQuestionResolved(map, 's1', 'nope', 'answered')).toBe(map);
  });

  test('locates by id within the session; a same-id card in another session is untouched', () => {
    const map = build(q('s1', undefined, 'dup'), q('s2', undefined, 'dup'));
    const next = markQuestionResolved(map, 's1', 'dup', 'auto_denied');
    expect(next.get(questionKey('s1'))?.resolvedReason).toBe('auto_denied');
    expect(next.get(questionKey('s2'))?.resolvedReason).toBeUndefined();
  });
});

describe('isQuestionPending (#652)', () => {
  test('true for a fresh unanswered card', () => {
    expect(isQuestionPending(q('s1', undefined, 'a'))).toBe(true);
  });
  test('false once answered locally', () => {
    expect(isQuestionPending(qWith(q('s1', undefined, 'a'), { answeredWith: '1' }))).toBe(false);
  });
  test('false once resolved elsewhere', () => {
    expect(isQuestionPending(qWith(q('s1', undefined, 'a'), { resolvedReason: 'answered' }))).toBe(
      false,
    );
  });
});
