/**
 * Tests for PendingQuestionCreatedAtTracker (#786/#787): a question's
 * createdAt must stay stable across repeated sync() calls (the
 * onQuestionsChanged event fires with the FULL current set on every
 * add/remove), and must be pruned once the question is no longer pending.
 */

import { describe, expect, test } from 'bun:test';
import type { Question } from '@remi/shared';
import { PendingQuestionCreatedAtTracker } from '../../src/session/pending-question-created-at-tracker.ts';

function mkQuestion(id: string, overrides: Partial<Question> = {}): Question {
  return {
    id,
    text: `${id}?`,
    options: [],
    allowsFreeText: false,
    isAnswered: false,
    ...overrides,
  };
}

describe('PendingQuestionCreatedAtTracker (#786/#787)', () => {
  test('assigns createdAt on first sight and keeps it stable across later syncs', () => {
    let clock = 0;
    const tracker = new PendingQuestionCreatedAtTracker(() => `t${clock++}`);

    const first = tracker.sync([mkQuestion('q1')]);
    expect(first).toEqual([{ id: 'q1', label: 'q1?', createdAt: 't0' }]);

    // A SECOND question arrives; q1 must keep its original createdAt even
    // though this is a new sync() call driven by a fresh onQuestionsChanged.
    const second = tracker.sync([mkQuestion('q1'), mkQuestion('q2')]);
    expect(second).toEqual([
      { id: 'q1', label: 'q1?', createdAt: 't0' },
      { id: 'q2', label: 'q2?', createdAt: 't1' },
    ]);
  });

  test('prunes an id once it is no longer in the live set, so it re-stamps if it ever returns', () => {
    let clock = 0;
    const tracker = new PendingQuestionCreatedAtTracker(() => `t${clock++}`);

    tracker.sync([mkQuestion('q1')]);
    tracker.sync([]); // q1 answered/resolved

    // A brand-new question that happens to reuse the id 'q1' (unrealistic in
    // practice -- UUIDs -- but the tracker has no way to know that, and the
    // point is: gone-then-back gets a FRESH timestamp, not the stale one).
    const resynced = tracker.sync([mkQuestion('q1')]);
    expect(resynced).toEqual([{ id: 'q1', label: 'q1?', createdAt: 't1' }]);
  });

  test('empty sync clears everything and returns an empty array', () => {
    const tracker = new PendingQuestionCreatedAtTracker(() => 'now');
    tracker.sync([mkQuestion('q1'), mkQuestion('q2')]);
    expect(tracker.sync([])).toEqual([]);
  });

  test('uses buildPendingQuestionLabel for the label field', () => {
    const tracker = new PendingQuestionCreatedAtTracker(() => 'now');
    const [entry] = tracker.sync([
      mkQuestion('q1', { text: 'Allow Bash: ls', source: 'permission_request' }),
    ]);
    expect(entry?.label).toBe('Permission: Bash');
  });

  test('defaults to a real ISO clock when none is injected', () => {
    const tracker = new PendingQuestionCreatedAtTracker();
    const [entry] = tracker.sync([mkQuestion('q1')]);
    expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
