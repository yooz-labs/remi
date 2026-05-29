/**
 * Tests for the client's composite-key question collection (#437). Pure
 * functions; no mocks.
 */

import { describe, expect, test } from 'bun:test';
import {
  clearSessionQuestions,
  getSessionQuestions,
  hasSessionQuestion,
  questionKey,
} from '../../src/lib/question-collection';
import type { UIQuestion } from '../../src/types';

function q(sessionId: string, agentId: string | undefined, id: string): UIQuestion {
  return {
    id: id as UIQuestion['id'],
    sessionId: sessionId as UIQuestion['sessionId'],
    type: 'yes_no',
    prompt: `${id}?`,
    timestamp: '2026-05-29T00:00:00.000Z',
    agentId,
  };
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
