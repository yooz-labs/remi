/**
 * Tests for the client's composite-key question collection (#437). Pure
 * functions; no mocks.
 */

import { describe, expect, test } from 'bun:test';
import {
  STATUS_CLEAR_FRESHNESS_MS,
  applyIncomingQuestion,
  clearMainQuestionOnStatus,
  clearSessionQuestions,
  getSessionQuestions,
  hasSessionQuestion,
  isQuestionPending,
  pruneQuestionsNotLive,
  questionKey,
  removeQuestionById,
  removeQuestionByKeyIfId,
  resolveQuestionCard,
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

  test('clears at EXACTLY the freshness boundary (protection window is exclusive)', () => {
    const map = build(q('s1', undefined, 'a'));
    const next = clearMainQuestionOnStatus(map, 's1', 'executing', {
      now: () => BASE_MS + STATUS_CLEAR_FRESHNESS_MS,
    });
    expect(getSessionQuestions(next, 's1')).toEqual([]);
  });

  test('PROTECTS a future-dated card (daemon clock ahead => negative age)', () => {
    const map = build(q('s1', undefined, 'a'));
    // Client clock 1ms behind the card's timestamp => negative age. A card that
    // cannot be old must not be cleared by a racing status update.
    expect(clearMainQuestionOnStatus(map, 's1', 'executing', { now: () => BASE_MS - 1 })).toBe(map);
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

  test('a malformed timestamp protects the card (question_resolved is the precise cleaner)', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { timestamp: 'not-a-date' as never }));
    // Unknown age must not silently drop a possibly-actionable permission card.
    expect(clearMainQuestionOnStatus(map, 's1', 'executing', { now: () => BASE_MS })).toBe(map);
  });
});

describe('resolveQuestionCard (#652)', () => {
  test('flips a still-pending card to a resolved-elsewhere trace, fade=true', () => {
    const map = build(q('s1', undefined, 'a'));
    const { questions, fade } = resolveQuestionCard(map, 's1', 'a', 'answered');
    expect(fade).toBe(true);
    expect(questions.get(questionKey('s1'))?.resolvedReason).toBe('answered');
    expect(getSessionQuestions(questions, 's1').map((x) => x.id)).toEqual(['a']);
  });

  test('REMOVES a submitting card (#627 AUQ/cancel relies on this broadcast), fade=false', () => {
    // Regression: the card has no self-removal timer, so it must be cleared here
    // or the "Answering…" spinner + pending badge stick forever.
    const map = build(qWith(q('s1', undefined, 'a'), { submitting: true }));
    const { questions, fade } = resolveQuestionCard(map, 's1', 'a', 'answered');
    expect(fade).toBe(false);
    expect(getSessionQuestions(questions, 's1')).toEqual([]);
  });

  test('leaves a locally answered card untouched (owns its own timer), fade=false', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { answeredWith: '1' }));
    const { questions, fade } = resolveQuestionCard(map, 's1', 'a', 'answered');
    expect(fade).toBe(false);
    expect(questions).toBe(map);
  });

  test('no-op on a duplicate broadcast (already marked resolved), fade=false', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { resolvedReason: 'cancelled' }));
    const { questions, fade } = resolveQuestionCard(map, 's1', 'a', 'answered');
    expect(fade).toBe(false);
    expect(questions).toBe(map);
  });

  test('no-op (same reference, fade=false) when the card is absent', () => {
    const map = build(q('s1', undefined, 'a'));
    const { questions, fade } = resolveQuestionCard(map, 's1', 'nope', 'answered');
    expect(fade).toBe(false);
    expect(questions).toBe(map);
  });

  test('locates by id within the session; a same-id card in another session is untouched', () => {
    const map = build(q('s1', undefined, 'dup'), q('s2', undefined, 'dup'));
    const { questions } = resolveQuestionCard(map, 's1', 'dup', 'auto_denied');
    expect(questions.get(questionKey('s1'))?.resolvedReason).toBe('auto_denied');
    expect(questions.get(questionKey('s2'))?.resolvedReason).toBeUndefined();
  });
});

describe('isQuestionPending (#652)', () => {
  test('true for a fresh unanswered card', () => {
    expect(isQuestionPending(q('s1', undefined, 'a'))).toBe(true);
  });
  test('true while submitting (an in-flight answer still counts as pending)', () => {
    expect(isQuestionPending(qWith(q('s1', undefined, 'a'), { submitting: true }))).toBe(true);
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

describe('applyIncomingQuestion (#798 part 1 -- the replay gate)', () => {
  test('a LIVE question message creates a card', () => {
    const empty = new Map<string, UIQuestion>();
    const incoming = q('s1', undefined, 'a');
    const next = applyIncomingQuestion(empty, incoming, false);
    expect(getSessionQuestions(next, 's1').map((x) => x.id)).toEqual(['a']);
  });

  test('a REPLAYED question message creates NO card (the #798 bug fix, mirrors terminal #753)', () => {
    const empty = new Map<string, UIQuestion>();
    const incoming = q('s1', undefined, 'a');
    const next = applyIncomingQuestion(empty, incoming, true);
    expect(next).toBe(empty);
    expect(getSessionQuestions(next, 's1')).toEqual([]);
  });

  test('replaying several stale questions in a batch resurrects NOTHING (the reported bug)', () => {
    // Regression for #798: a reconnect replayed a full history batch containing
    // several long-answered questions still inside the replay window. None of
    // them may create a phantom "Just now" card.
    let map = new Map<string, UIQuestion>();
    for (const [sid, id] of [
      ['s1', 'a'],
      ['s1', 'b'],
      ['s2', 'c'],
    ] as const) {
      map = applyIncomingQuestion(map, q(sid, undefined, id), true);
    }
    expect(map.size).toBe(0);
  });

  test('a LIVE resend of the SAME id right after replay still creates the card', () => {
    // The daemon re-sends the authoritative pending set as LIVE messages
    // immediately after the replay batch (pending-question-resend.ts) -- the
    // fix must not treat that id as "already seen" just because a replayed
    // copy of it passed through moments earlier.
    let map = new Map<string, UIQuestion>();
    map = applyIncomingQuestion(map, q('s1', undefined, 'a'), true); // replayed: no-op
    map = applyIncomingQuestion(map, q('s1', undefined, 'a'), false); // live resend
    expect(getSessionQuestions(map, 's1').map((x) => x.id)).toEqual(['a']);
  });

  test('defers to the richer-wins guard for a live second arrival in the same slot', () => {
    // shouldKeepExisting's freshness window is measured against the REAL clock
    // (applyIncomingQuestion passes no `now` override), so both cards need a
    // current, not fixed-fixture, timestamp -- otherwise the guard falls
    // through its "stale" branch and replaces regardless of richness.
    const now = new Date().toISOString();
    const richer = qWith(q('s1', undefined, 'a'), {
      timestamp: now,
      structuredOptions: [
        { label: 'Yes', value: 'y' },
        { label: 'No', value: 'n' },
        { label: 'Always', value: 'a' },
      ],
    });
    const poorer = qWith(q('s1', undefined, 'b'), {
      timestamp: now,
      structuredOptions: [
        { label: 'Yes', value: 'y' },
        { label: 'No', value: 'n' },
      ],
    });
    let map = new Map<string, UIQuestion>();
    map = applyIncomingQuestion(map, richer, false);
    map = applyIncomingQuestion(map, poorer, false);
    // The poorer arrival is dropped; the richer card (id 'a') stays.
    expect(getSessionQuestions(map, 's1').map((x) => x.id)).toEqual(['a']);
  });

  test('a different agent gets its own coexisting slot (#419/#425)', () => {
    let map = new Map<string, UIQuestion>();
    map = applyIncomingQuestion(map, q('s1', undefined, 'main-q'), false);
    map = applyIncomingQuestion(map, q('s1', 'sub-7', 'sub-q'), false);
    expect(getSessionQuestions(map, 's1').map((x) => x.id).sort()).toEqual(['main-q', 'sub-q']);
  });
});

describe('pruneQuestionsNotLive (#798 parts 2/3)', () => {
  test('drops a card whose id is missing from the live set', () => {
    const map = build(q('s1', undefined, 'a'));
    const next = pruneQuestionsNotLive(map, 's1', []);
    expect(getSessionQuestions(next, 's1')).toEqual([]);
  });

  test('keeps a card whose id IS in the live set', () => {
    const map = build(q('s1', undefined, 'a'));
    const next = pruneQuestionsNotLive(map, 's1', ['a']);
    expect(next).toBe(map);
  });

  test('prunes only the missing card, keeps a live sibling (main + subagent)', () => {
    const map = build(q('s1', undefined, 'a'), q('s1', 'sub-7', 'b'));
    const next = pruneQuestionsNotLive(map, 's1', ['b']);
    expect(getSessionQuestions(next, 's1').map((x) => x.id)).toEqual(['b']);
  });

  test('never touches a different session, even with an empty live set', () => {
    const map = build(q('s1', undefined, 'a'), q('s2', undefined, 'c'));
    const next = pruneQuestionsNotLive(map, 's1', []);
    expect(getSessionQuestions(next, 's1')).toEqual([]);
    expect(getSessionQuestions(next, 's2').map((x) => x.id)).toEqual(['c']);
  });

  test('returns the SAME reference when nothing was pruned (no-op update)', () => {
    const map = build(q('s1', undefined, 'a'));
    expect(pruneQuestionsNotLive(map, 's2', [])).toBe(map);
  });

  test('PRESERVES a submitting card even though its id is missing (#627 AUQ in flight)', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { submitting: true }));
    const next = pruneQuestionsNotLive(map, 's1', []);
    expect(next).toBe(map);
    expect(getSessionQuestions(next, 's1').map((x) => x.id)).toEqual(['a']);
  });

  test('PRESERVES a locally-answered card even though its id is missing (#652 own removal timer)', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { answeredWith: '1' }));
    const next = pruneQuestionsNotLive(map, 's1', []);
    expect(next).toBe(map);
  });

  test('PRESERVES a resolved-elsewhere trace card even though its id is missing (#652)', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { resolvedReason: 'answered' }));
    const next = pruneQuestionsNotLive(map, 's1', []);
    expect(next).toBe(map);
  });

  test('a same-id card in ANOTHER session is unaffected by this session live set', () => {
    const map = build(q('s1', undefined, 'dup'), q('s2', undefined, 'dup'));
    const next = pruneQuestionsNotLive(map, 's1', []);
    expect(getSessionQuestions(next, 's1')).toEqual([]);
    expect(getSessionQuestions(next, 's2').map((x) => x.id)).toEqual(['dup']);
  });

  test('reconciles a whole phantom set at once (the reported bug: multiple stale cards, no pending question)', () => {
    // Regression for #798: a reconnect-into-quiet-session replayed several
    // stale question cards. The live snapshot says NONE are pending anymore.
    const map = build(q('s1', undefined, 'a'), q('s1', 'sub-1', 'b'), q('s1', 'sub-2', 'c'));
    const next = pruneQuestionsNotLive(map, 's1', []);
    expect(getSessionQuestions(next, 's1')).toEqual([]);
  });
});

describe('STALE_ANSWER force-clear (#800 review, MEDIUM finding)', () => {
  // pruneQuestionsNotLive protects a submitting card (above), which means the
  // exact card a STALE_ANSWER names -- the one the user just answered, still
  // `submitting: true` -- can never clear through reconciliation alone. /clear,
  // /resume, and a MAX_PENDING_QUESTIONS eviction all reach STALE_ANSWER without
  // ever firing question_resolved for the dead id, so App.tsx force-removes the
  // named id by id (removeQuestionById, unconditional) BEFORE reconciling the
  // rest of the session against the live snapshot.

  test('removeQuestionById force-clears a submitting card unconditionally (no protection)', () => {
    const map = build(qWith(q('s1', undefined, 'a'), { submitting: true }));
    const next = removeQuestionById(map, 's1', 'a');
    expect(getSessionQuestions(next, 's1')).toEqual([]);
  });

  test('the App.tsx STALE_ANSWER flow: force-remove the named id, then prune the rest against the live snapshot', () => {
    // Two submitting cards in the same session: 'a' is the one a STALE_ANSWER
    // names (the daemon rejected it -- /clear, /resume, or an eviction), 'b' is
    // a genuinely different in-flight submit the error says nothing about.
    const map = build(
      qWith(q('s1', undefined, 'a'), { submitting: true }),
      qWith(q('s1', 'sub-7', 'b'), { submitting: true }),
    );
    // Step 1 (the fix): force-remove the exact id STALE_ANSWER names.
    let next = removeQuestionById(map, 's1', 'a');
    // Step 2: reconcile the rest against the live snapshot (empty here too).
    next = pruneQuestionsNotLive(next, 's1', []);
    // 'a' is gone (force-cleared, no longer stuck at "Answering..."); 'b'
    // SURVIVES -- still submitting and never named by this error, so pruning
    // alone must not touch it even though it's also missing from the live set.
    expect(getSessionQuestions(next, 's1').map((x) => x.id)).toEqual(['b']);
  });
});
