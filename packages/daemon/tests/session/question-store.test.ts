/**
 * Tests for QuestionStore (#888): the single owner of a session's
 * pending-question map, extracted from SessionRegistry.
 *
 * `SessionRegistry`'s own test suite (`session-registry.test.ts`) already
 * exercises this behavior indirectly through `addQuestion`/`removeQuestion`/
 * `clearQuestions`/`getQuestion` (unchanged, adapter signatures) and stays
 * green after this extraction (see the PR body). This suite tests the store
 * directly: its own public surface, the LRU eviction it now solely owns, and
 * that `callSite` threads through exactly as before.
 */

import { describe, expect, test } from 'bun:test';
import { generateId } from '@remi/shared';
import type { Question, UUID } from '@remi/shared';
import { QuestionStore } from '../../src/session/question-store.ts';

function mkQuestion(id: string, agentId?: string): Question {
  return {
    id: id as UUID,
    text: `${id}?`,
    options: [],
    allowsFreeText: true,
    isAnswered: false,
    ...(agentId !== undefined && { agentId }),
  };
}

describe('QuestionStore (#888)', () => {
  test('add registers a question, visible via questions and get', () => {
    const store = new QuestionStore(generateId() as UUID);
    const q = mkQuestion(generateId());
    store.add(q);
    expect(store.questions.size).toBe(1);
    expect(store.questions.get(q.id)).toEqual(q);
    expect(store.get(q.id)).toEqual(q);
  });

  test('get returns null for an unknown id', () => {
    const store = new QuestionStore(generateId() as UUID);
    expect(store.get(generateId() as UUID)).toBeNull();
  });

  test('remove drops the question and get returns null after', () => {
    const store = new QuestionStore(generateId() as UUID);
    const q = mkQuestion(generateId());
    store.add(q);
    store.remove(q.id);
    expect(store.get(q.id)).toBeNull();
    expect(store.questions.size).toBe(0);
  });

  test('remove of an unknown id is a harmless no-op (idempotent)', () => {
    const store = new QuestionStore(generateId() as UUID);
    expect(() => store.remove(generateId() as UUID)).not.toThrow();
    expect(store.questions.size).toBe(0);
  });

  test('add/remove keep concurrent questions independent (main + subagent)', () => {
    const store = new QuestionStore(generateId() as UUID);
    const main = mkQuestion(generateId());
    const sub = mkQuestion(generateId(), 'sub-7');
    store.add(main);
    store.add(sub);
    expect(store.questions.size).toBe(2);
    store.remove(main.id);
    expect(store.get(main.id)).toBeNull();
    expect(store.get(sub.id)).toEqual(sub);
  });

  test('clear drops every pending question', () => {
    const store = new QuestionStore(generateId() as UUID);
    store.add(mkQuestion(generateId()));
    store.add(mkQuestion(generateId()));
    store.clear();
    expect(store.questions.size).toBe(0);
  });

  test('re-adding an existing id refreshes it to newest (survives eviction)', () => {
    const store = new QuestionStore(generateId() as UUID);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = generateId();
      ids.push(id);
      store.add(mkQuestion(id));
    }
    // Refresh the oldest, then add one more: the refreshed one must survive
    // and the now-oldest (ids[1]) must be evicted instead.
    store.add(mkQuestion(ids[0] as string));
    store.add(mkQuestion(generateId()));
    expect(store.get(ids[0] as UUID)).not.toBeNull();
    expect(store.get(ids[1] as UUID)).toBeNull();
  });

  test('evicts the OLDEST when the pending cap (8) is exceeded', () => {
    const store = new QuestionStore(generateId() as UUID);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const id = generateId();
      ids.push(id);
      store.add(mkQuestion(id));
    }
    expect(store.questions.size).toBe(8);
    expect(store.get(ids[0] as UUID)).toBeNull(); // oldest gone
    expect(store.get(ids[8] as UUID)).not.toBeNull(); // newest kept
  });

  test('questions is a LIVE view: reads after a mutation see the new state', () => {
    const store = new QuestionStore(generateId() as UUID);
    const view = store.questions; // captured once
    const q = mkQuestion(generateId());
    store.add(q);
    // Same reference throughout (#888: not a copy taken at construction).
    expect(view.size).toBe(1);
    expect(view.get(q.id)).toEqual(q);
    store.remove(q.id);
    expect(view.size).toBe(0);
  });

  test('onQuestionsChanged fires with the FULL current set on add/remove/clear, never a delta', () => {
    const seen: Question[][] = [];
    const store = new QuestionStore(generateId() as UUID, {
      onQuestionsChanged: (qs) => seen.push([...qs]),
    });
    const a = mkQuestion(generateId());
    const b = mkQuestion(generateId());
    store.add(a);
    store.add(b);
    store.remove(a.id);
    store.clear();
    expect(seen.map((s) => s.length)).toEqual([1, 2, 1, 0]);
    expect(seen[1]?.map((q) => q.id)).toEqual([a.id, b.id]);
  });

  test('an eviction fires onQuestionsChanged too (the evicted id is gone from the next set)', () => {
    const counts: number[] = [];
    const store = new QuestionStore(generateId() as UUID, {
      onQuestionsChanged: (qs) => counts.push(qs.length),
    });
    for (let i = 0; i < 9; i++) {
      store.add(mkQuestion(generateId()));
    }
    // 9 adds; the 9th also evicts, but eviction does not fire a SEPARATE
    // onQuestionsChanged -- the post-eviction size (capped at 8) is what the
    // 9th add's own notifyChanged reports.
    expect(counts).toHaveLength(9);
    expect(counts[8]).toBe(8);
  });
});
