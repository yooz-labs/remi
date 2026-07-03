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

const { DOWN, ENTER, SPACE, UP } = AUQ_KEYS;
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

/**
 * Minimal state machine modelling the multi-select TUI's row layout + key
 * semantics (ground truth: two-questions-single-and-multi.txt, decoded IN/OUT
 * lines 92-124 — see `.context/auq-tui-interaction-model.md`). Rows are
 * `[0, optionCount)` the real options, then `optionCount` = "Type something",
 * then `optionCount + 1` = "Submit". DOWN/UP move the cursor (clamped to the
 * row range); SPACE toggles the option at the cursor (only meaningful on a real
 * option row); ENTER on the Submit row leaves the tab. Used below to prove the
 * planner's derived keystrokes land in the same terminal state as the real
 * captured session, without needing a live PTY.
 */
function simulateMultiSelect(
  optionCount: number,
  keys: readonly string[],
): { cursor: number; toggled: Set<number>; submitted: boolean } {
  const typeSomethingRow = optionCount;
  const submitRow = optionCount + 1;
  let cursor = 0;
  const toggled = new Set<number>();
  let submitted = false;
  for (const key of keys) {
    if (submitted) break;
    if (key === DOWN) cursor = Math.min(cursor + 1, submitRow);
    else if (key === UP) cursor = Math.max(cursor - 1, 0);
    else if (key === SPACE) {
      if (cursor < typeSomethingRow) toggled.add(cursor);
    } else if (key === ENTER && cursor === submitRow) {
      submitted = true;
    }
  }
  return { cursor, toggled, submitted };
}

describe('planQuestionKeys', () => {
  it('single-select: DOWN x index then ENTER (auto-advances)', () => {
    expect(planQuestionKeys(single(3), [0])).toEqual([ENTER]);
    expect(planQuestionKeys(single(3), [1])).toEqual([DOWN, ENTER]);
    expect(planQuestionKeys(single(3), [2])).toEqual([DOWN, DOWN, ENTER]);
  });

  it('multi-select: SPACE-toggle each (ascending) then DOWN-navigate to Submit + ENTER', () => {
    // toggle index 0 and 2 (optionCount=4): cursor 0 -> SPACE, DOWN DOWN -> SPACE
    // (cursor now 2); Submit sits at row optionCount+1=5, so 3 more DOWNs then
    // ENTER. Matches the captured fixture (two-questions-single-and-multi.txt,
    // lines 99-122: toggle Apple + Cherry, then DOWN x3 through Date/"Type
    // something" to "Submit", then Enter).
    expect(planQuestionKeys(multi(4), [0, 2])).toEqual([
      SPACE,
      DOWN,
      DOWN,
      SPACE,
      DOWN,
      DOWN,
      DOWN,
      ENTER,
    ]);
    // unordered input is sorted; cursor advances minimally. Last toggle at index
    // 3 (cursor=3): Submit at row 5, so 2 DOWNs then ENTER.
    expect(planQuestionKeys(multi(4), [3, 1])).toEqual([
      DOWN,
      SPACE,
      DOWN,
      DOWN,
      SPACE,
      DOWN,
      DOWN,
      ENTER,
    ]);
  });

  it('multi-select: a single toggle still navigates through "Type something" to Submit', () => {
    // Lone target at index 0 (optionCount=3): cursor stays 0 after the toggle;
    // Submit is at row optionCount+1=4, so 4 DOWNs then ENTER.
    expect(planQuestionKeys(multi(3), [0])).toEqual([SPACE, DOWN, DOWN, DOWN, DOWN, ENTER]);
  });

  it('multi-select: toggling the LAST option still needs 2 DOWNs to reach Submit', () => {
    // optionCount=4, target index 3 (the last real option): DOWN x3 to reach it,
    // SPACE to toggle, then DOWN (Type something) DOWN (Submit), then ENTER.
    expect(planQuestionKeys(multi(4), [3])).toEqual([DOWN, DOWN, DOWN, SPACE, DOWN, DOWN, ENTER]);
  });

  it('rejects out-of-range / malformed targets so the caller escalates', () => {
    expect(() => planQuestionKeys(single(3), [3])).toThrow();
    expect(() => planQuestionKeys(single(3), [0, 1])).toThrow(); // single needs exactly one
    expect(() => planQuestionKeys(multi(4), [])).toThrow(); // multi needs >=1
  });

  it('replays the captured fixture: the derived plan reaches the same terminal state (#661)', () => {
    // Ground truth: two-questions-single-and-multi.txt, decoded IN lines for the
    // Fruits tab (multi-select, optionCount=4: Apple/Banana/Cherry/Date):
    //   99  SPACE            toggle Apple (cursor 0)
    //   103 DOWN             -> Banana
    //   105 DOWN             -> Cherry
    //   107 DOWN             -> Date
    //   109 UP               -> back to Cherry
    //   111 SPACE            toggle Cherry
    //   113 DOWN             -> Date
    //   117 DOWN             -> "Type something"
    //   120 DOWN             -> "Submit"
    //   122 ENTER            leave the tab (-> review screen)
    // A human explored the list (the UP detour); the driver never does that, but
    // must land in the exact same place: Apple + Cherry toggled, resting on Submit.
    const capturedKeys = [SPACE, DOWN, DOWN, DOWN, UP, SPACE, DOWN, DOWN, DOWN, ENTER];
    const fromCapture = simulateMultiSelect(4, capturedKeys);
    expect(fromCapture).toEqual({ cursor: 5, toggled: new Set([0, 2]), submitted: true });

    // Our planner's minimal, open-loop derivation for the SAME target (Apple=0,
    // Cherry=2) must reach the identical final state.
    const planned = planQuestionKeys(multi(4), [0, 2]);
    const fromPlan = simulateMultiSelect(4, planned);
    expect(fromPlan).toEqual(fromCapture);
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
      DOWN,
      DOWN,
      DOWN, // past Date + "Type something" to "Submit"
      ENTER, // leave multi toward review
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

  it('reviewMatchesTarget matches labels in render order, exact on questions', () => {
    const parsed = [
      { question: 'Favorite color?', labels: ['Green'] },
      { question: 'Which fruits?', labels: ['Apple', 'Cherry'] },
    ];
    // Order-sensitive: the daemon toggles + the TUI renders in ascending option
    // index, so the expected order always equals the rendered order. A reorder
    // escalates (fail-safe) rather than risking a wrong submit.
    expect(reviewMatchesTarget(parsed, [['Green'], ['Apple', 'Cherry']])).toBe(true);
    expect(reviewMatchesTarget(parsed, [['Green'], ['Cherry', 'Apple']])).toBe(false); // reordered
    expect(reviewMatchesTarget(parsed, [['Green'], ['Apple']])).toBe(false); // wrong count
    expect(reviewMatchesTarget(parsed, [['Blue'], ['Apple', 'Cherry']])).toBe(false); // wrong label
    expect(reviewMatchesTarget(parsed, [['Green']])).toBe(false); // wrong arity
  });

  it('returns false when an expected label set is empty (cannot verify)', () => {
    const parsed = [{ question: 'Pick one', labels: ['Green'] }];
    expect(reviewMatchesTarget(parsed, [[]])).toBe(false);
  });

  it('does not conflate options that differ only by internal spaces (no wrong-submit)', () => {
    // "foo bar" must NOT verify as "foobar": internal spaces stay significant.
    const parsed = [{ question: 'Pick', labels: ['foobar'] }];
    expect(reviewMatchesTarget(parsed, [['foo bar']])).toBe(false);
    expect(reviewMatchesTarget(parsed, [['foobar']])).toBe(true);
  });

  it('verifies a single-select option whose LABEL contains a comma (#654 regression)', () => {
    // The real failure: a single-select option labelled "Sidecar first, channels.tsv
    // fallback". parseReviewAnswers splits the review line on commas, shattering the
    // one label into two; the matcher must still recognise the correct answer.
    const frame =
      'Review your answers● #854 scope → Epic via epic-dev● #854 data source → Sidecar first, channels.tsv fallback● #855 → Implement nowReady to submit your answers?❯ 1. Submit answers 2. Cancel';
    const parsed = parseReviewAnswers(frame);
    expect(parsed[1]?.labels).toEqual(['Sidecar first', 'channels.tsv fallback']); // over-split
    expect(
      reviewMatchesTarget(parsed, [
        ['Epic via epic-dev'],
        ['Sidecar first, channels.tsv fallback'], // ONE label, with its comma
        ['Implement now'],
      ]),
    ).toBe(true);
    // A fragment of the comma-label alone must NOT verify (no false positive).
    expect(
      reviewMatchesTarget(parsed, [['Epic via epic-dev'], ['Sidecar first'], ['Implement now']]),
    ).toBe(false);
  });

  it('verifies multi-select labels containing commas, in render order (#654)', () => {
    // Render order = ascending option index, so expected uses that order.
    const frame =
      'Review your answers● Pick → Sidecar first, channels.tsv fallback, Other optionReady to submit your answers?❯ 1. Submit answers';
    const parsed = parseReviewAnswers(frame);
    expect(
      reviewMatchesTarget(parsed, [['Sidecar first, channels.tsv fallback', 'Other option']]),
    ).toBe(true);
    // A wrong selection (fragments, not the whole comma-label) still fails.
    expect(reviewMatchesTarget(parsed, [['Sidecar first', 'Other option']])).toBe(false);
  });

  it('verifies two comma-containing labels selected in one question (#654)', () => {
    const frame =
      'Review your answers● Choose → A first, then B, C also, or DReady to submit your answers?❯ 1. Submit answers';
    const parsed = parseReviewAnswers(frame);
    expect(parsed[0]?.labels.length).toBe(4); // both labels over-split
    expect(reviewMatchesTarget(parsed, [['A first, then B', 'C also, or D']])).toBe(true);
    expect(reviewMatchesTarget(parsed, [['A first, then B']])).toBe(false); // only one of two
  });

  it('matches a label that is a suffix of another, in render order (#654)', () => {
    const frame =
      'Review your answers● Pick → sidecar, carReady to submit your answers?❯ 1. Submit answers';
    const parsed = parseReviewAnswers(frame);
    expect(parsed[0]?.labels).toEqual(['sidecar', 'car']);
    expect(reviewMatchesTarget(parsed, [['sidecar', 'car']])).toBe(true);
    expect(reviewMatchesTarget(parsed, [['car']])).toBe(false); // only one of two
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
