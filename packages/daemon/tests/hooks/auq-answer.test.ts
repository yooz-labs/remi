import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUQ_KEYS,
  type AuqQuestionSpec,
  isAuqClosed,
  isReviewScreen,
  parseReviewAnswers,
  planAnswerKeys,
  planQuestionKeys,
  reviewMatchesTarget,
} from '../../src/hooks/auq-answer.ts';

const { DOWN, ENTER, SPACE, TAB } = AUQ_KEYS;
const single = (optionCount: number): AuqQuestionSpec => ({ multiSelect: false, optionCount });
const multi = (optionCount: number): AuqQuestionSpec => ({ multiSelect: true, optionCount });

/** Concatenate the decoded OUT payloads of a capture fixture (rendered frames). */
function fixtureOutput(name: string): string {
  const path = join(import.meta.dir, '..', 'fixtures', 'auq', name);
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  let out = '';
  for (const l of lines) {
    const m = l.match(/^OUT \d+ (.*)$/);
    if (!m) continue;
    try {
      out += JSON.parse(m[1] as string) as string;
    } catch {
      // skip a malformed capture line
    }
  }
  return out;
}

describe('planQuestionKeys', () => {
  it('single-select: DOWN x index then ENTER (auto-advances)', () => {
    expect(planQuestionKeys(single(3), [0])).toEqual([ENTER]);
    expect(planQuestionKeys(single(3), [1])).toEqual([DOWN, ENTER]);
    expect(planQuestionKeys(single(3), [2])).toEqual([DOWN, DOWN, ENTER]);
  });

  it('multi-select: SPACE-toggle each (ascending) then TAB to advance', () => {
    // toggle index 0 and 2: cursor 0 -> SPACE, DOWN DOWN -> SPACE, then TAB.
    expect(planQuestionKeys(multi(4), [0, 2])).toEqual([SPACE, DOWN, DOWN, SPACE, TAB]);
    // unordered input is sorted; cursor advances minimally.
    expect(planQuestionKeys(multi(4), [3, 1])).toEqual([DOWN, SPACE, DOWN, DOWN, SPACE, TAB]);
  });

  it('rejects out-of-range / malformed targets so the caller escalates', () => {
    expect(() => planQuestionKeys(single(3), [3])).toThrow();
    expect(() => planQuestionKeys(single(3), [0, 1])).toThrow(); // single needs exactly one
    expect(() => planQuestionKeys(multi(4), [])).toThrow(); // multi needs >=1
  });
});

describe('planAnswerKeys (matches the captured canonical sequences)', () => {
  it('one single-select question (auq-1: pick Green=index1)', () => {
    expect(planAnswerKeys([single(3)], [[1]])).toEqual([DOWN, ENTER]);
  });

  it('three single-select questions (auq-3: pick index 0,1,2)', () => {
    expect(planAnswerKeys([single(3), single(3), single(3)], [[0], [1], [2]])).toEqual([
      ENTER, // q1 index0
      DOWN,
      ENTER, // q2 index1
      DOWN,
      DOWN,
      ENTER, // q3 index2
    ]);
  });

  it('two questions single+multi (auq-2: Green; Apple+Cherry)', () => {
    expect(planAnswerKeys([single(3), multi(4)], [[1], [0, 2]])).toEqual([
      DOWN,
      ENTER, // q1 -> Green, auto-advance
      SPACE, // toggle Apple (index0)
      DOWN,
      DOWN,
      SPACE, // toggle Cherry (index2)
      TAB, // leave multi toward review
    ]);
  });

  it('rejects a questions/targets length mismatch', () => {
    expect(() => planAnswerKeys([single(3)], [[0], [1]])).toThrow();
  });
});

describe('review parsing + verification (against real captures)', () => {
  it('parses the review screen rendered in the two-question capture', () => {
    const out = fixtureOutput('two-questions-single-and-multi.txt');
    expect(isReviewScreen(out)).toBe(true);
    expect(isAuqClosed(out)).toBe(true); // the capture ran through to submission
    const parsed = parseReviewAnswers(out);
    // The review listed: Favorite color? -> Green ; Which fruits? -> Apple, Cherry.
    const color = parsed.find((p) => /favorite color/i.test(p.question));
    const fruits = parsed.find((p) => /fruits/i.test(p.question));
    expect(color?.labels).toEqual(['Green']);
    expect(fruits?.labels).toEqual(['Apple', 'Cherry']);
  });

  it('parseReviewAnswers handles the run-together rendering', () => {
    const frame =
      'Review your answers● Favorite color? → Green● Which fruits? → Apple, CherryReady to submit your answers?❯ 1. Submit answers 2. Cancel';
    expect(parseReviewAnswers(frame)).toEqual([
      { question: 'Favorite color?', labels: ['Green'] },
      { question: 'Which fruits?', labels: ['Apple', 'Cherry'] },
    ]);
  });

  it('reviewMatchesTarget is order-insensitive for multi labels, exact on questions', () => {
    const parsed = [
      { question: 'Favorite color?', labels: ['Green'] },
      { question: 'Which fruits?', labels: ['Apple', 'Cherry'] },
    ];
    expect(reviewMatchesTarget(parsed, [['Green'], ['Cherry', 'Apple']])).toBe(true);
    expect(reviewMatchesTarget(parsed, [['Green'], ['Apple']])).toBe(false); // wrong count
    expect(reviewMatchesTarget(parsed, [['Blue'], ['Apple', 'Cherry']])).toBe(false); // wrong label
    expect(reviewMatchesTarget(parsed, [['Green']])).toBe(false); // wrong arity
  });

  it('isReviewScreen / isAuqClosed are false for a plain option frame', () => {
    const out = fixtureOutput('one-question-single-select.txt');
    // The single-select capture DID close (submitted on pick).
    expect(isAuqClosed(out)).toBe(true);
    // A bare options-only string is neither closed nor a review.
    expect(isAuqClosed('❯ 1. Red  2. Green  3. Blue')).toBe(false);
    expect(isReviewScreen('❯ 1. Red  2. Green  3. Blue')).toBe(false);
  });
});
