/**
 * Tests for the client-side richer-wins guard (#396, #718).
 */

import { describe, expect, test } from 'bun:test';
import { shouldKeepExisting } from '../../src/lib/question-merge';
import type {
  UIQuestion,
  UIQuestionOption,
  UIQuestionResolvedReason,
  UUID,
} from '../../src/types';

let nextId = 0;
function uiq(
  prompt: string,
  options: ReadonlyArray<{ label: string; isYes?: boolean; isNo?: boolean }>,
  extra: {
    timestamp?: string;
    answeredWith?: string;
    resolvedReason?: UIQuestionResolvedReason;
    optionsAreFallback?: boolean;
  } = {},
): UIQuestion {
  const structured: UIQuestionOption[] = options.map((o, i) => ({
    label: o.label,
    value: String(i + 1),
    isYes: o.isYes,
    isNo: o.isNo,
  }));
  const ts = extra.timestamp ?? new Date(1_000_000).toISOString();
  return {
    id: `q-${++nextId}` as UUID,
    sessionId: 'session-1' as UUID,
    type:
      structured.length === 0 ? 'free_text' : structured.length === 2 ? 'yes_no' : 'multi_option',
    prompt,
    structuredOptions: structured.length > 0 ? structured : undefined,
    options: structured.length > 0 ? structured.map((o) => o.label) : undefined,
    timestamp: ts,
    ...(extra.answeredWith !== undefined ? { answeredWith: extra.answeredWith } : {}),
    ...(extra.resolvedReason !== undefined ? { resolvedReason: extra.resolvedReason } : {}),
    ...(extra.optionsAreFallback !== undefined
      ? { optionsAreFallback: extra.optionsAreFallback }
      : {}),
  };
}

// #718: the daemon's honest fallback (no usable permission_suggestions),
// explicitly flagged the way the real daemon/App.tsx wiring does.
const yesNoFallback = (prompt = 'Allow Bash: ls') =>
  uiq(
    prompt,
    [
      { label: 'Yes', isYes: true },
      { label: 'No', isNo: true },
    ],
    { optionsAreFallback: true },
  );

// A 3-option set that used to double as "the bland default" pre-#718 (when
// the fallback itself was a 3-set). Under the new 2-option fallback shape
// this is just an ordinary non-default set (e.g. a #718 suggestion-derived
// card with one middle "always allow" option) — never flagged.
const threeOptionNonDefault = [
  { label: 'Yes', isYes: true },
  { label: 'Yes, always', isYes: true },
  { label: 'No', isNo: true },
];

const fourSentenceOptions = [
  { label: 'Refactor the authentication module' },
  { label: 'Patch the immediate bug only' },
  { label: 'Rewrite from scratch using a library' },
  { label: 'Skip and document the issue' },
];

const fixedNow = (ms: number) => () => ms;

describe('shouldKeepExisting', () => {
  test('keeps a multi-choice when a default fallback arrives next', () => {
    const existing = uiq('Which approach?', fourSentenceOptions);
    const incoming = yesNoFallback('Claude needs your permission to use Bash');
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });

  test('keeps a 3-set with custom labels when default fallback arrives next', () => {
    // Edit tool's permission_suggestions (rich) followed by the hook's
    // honest fallback (poor) at equal-or-lower option count.
    const existing = uiq('Allow Edit: src/foo.ts', [
      { label: 'Yes' },
      { label: "Yes, and don't ask again this session" },
      { label: 'No, and tell Claude what to do differently' },
    ]);
    const incoming = yesNoFallback();
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });

  test('replaces when incoming has more options', () => {
    const existing = uiq('Allow Bash: ls', threeOptionNonDefault);
    const incoming = uiq('Pick a destination', fourSentenceOptions);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('keeps a genuine 2-option Yes/No when the default fallback arrives next (#407, #718)', () => {
    // The reported regression: the PTY parser detects a subprocess (y/n)
    // prompt and emits a genuine 2-option Yes/No, explicitly flagged
    // `optionsAreFallback: false` (question-parser.ts). Hook bridge then
    // falls back to the honest Yes/No default (flagged true) for the SAME
    // prompt cycle. Label/count alone can no longer tell these apart
    // post-#718 (both are 2-option Yes/No) — `optionsAreFallback` is what
    // lets the genuine one win.
    const existing = uiq(
      'Continue?',
      [
        { label: 'Yes', isYes: true },
        { label: 'No', isNo: true },
      ],
      { optionsAreFallback: false },
    );
    const incoming = yesNoFallback();
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });

  test('replaces when existing is the bland fallback and incoming is non-default (#407)', () => {
    // Symmetric: if the daemon's hook fired the fallback first and the PTY
    // then surfaced a real 2-option Yes/No, the richer one wins.
    const existing = yesNoFallback();
    const incoming = uiq(
      'Continue?',
      [
        { label: 'Yes', isYes: true },
        { label: 'No', isNo: true },
      ],
      { optionsAreFallback: false },
    );
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('replaces when both are default fallback sets (truly equivalent)', () => {
    const existing = yesNoFallback('Allow Bash: ls');
    const incoming = yesNoFallback('Allow Edit: foo');
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('replaces when existing was answered (new prompt cycle)', () => {
    const existing = uiq('Which approach?', fourSentenceOptions, {
      answeredWith: 'Refactor the authentication module',
    });
    const incoming = yesNoFallback();
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('replaces when existing is older than the freshness window', () => {
    const stale = new Date(1_000_000).toISOString();
    const existing = uiq('Old plan question', fourSentenceOptions, { timestamp: stale });
    const incoming = yesNoFallback();
    // 6 seconds later: stale, allow replacement.
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_006_001) })).toBe(false);
  });

  test('keeps within window even at the edge (4999 ms)', () => {
    const existing = uiq('Which approach?', fourSentenceOptions, {
      timestamp: new Date(1_000_000).toISOString(),
    });
    const incoming = uiq('Allow Bash: ls', threeOptionNonDefault);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_004_999) })).toBe(true);
  });

  test('replaces when incoming has same count as an ordinary 3-option set (truly equivalent)', () => {
    // Edge case: identical non-default 3-option pairs come through; the
    // second is no worse than the first so we let it replace (last wins).
    const existing = uiq('Allow Bash: ls', threeOptionNonDefault);
    const incoming = uiq('Allow Bash: ls', threeOptionNonDefault);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('shape outranks count: keeps a 2-option Yes/No over a default fallback (#407, #718)', () => {
    // Pre-#407 this asserted the opposite — that the (then 3-set) default
    // replaces the 2-option Yes/No. That was the bug: the bland fallback
    // must never replace a non-default shape regardless of count.
    const existing = uiq(
      'Run this?',
      [
        { label: 'Yes', isYes: true },
        { label: 'No', isNo: true },
      ],
      { optionsAreFallback: false },
    );
    const incoming = yesNoFallback('Run this?');
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });

  test('keeps 4-option richer when poorer 4-option arrives (not a default fallback)', () => {
    // Equal count but neither is the daemon's fallback shape — let it
    // through. We only special-case the daemon's hardcoded fallback.
    const existing = uiq('Pick a city', [
      { label: 'New York' },
      { label: 'San Francisco' },
      { label: 'Austin' },
      { label: 'Other' },
    ]);
    const incoming = uiq('Pick a city', [
      { label: 'NYC' },
      { label: 'SF' },
      { label: 'ATX' },
      { label: 'Other' },
    ]);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('malformed timestamp falls open and allows replacement (fail-closed)', () => {
    const existing = uiq('Plan', fourSentenceOptions, { timestamp: 'not-a-date' });
    const incoming = yesNoFallback('Allow Bash');
    // A corrupted/legacy timestamp must not pin the UI: the guard
    // returns false so the new emission renders normally.
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('keeps an answered question when same id is replayed (#396)', () => {
    // replay_batch path: phone wakes from background, the daemon re-feeds
    // earlier question messages. Without the same-id guard, the user is
    // re-prompted for a question they already answered.
    const existing = uiq('Which approach?', fourSentenceOptions, {
      answeredWith: 'Refactor the authentication module',
    });
    // Same id as existing — replay of the same wire message.
    const incoming: UIQuestion = { ...existing, prompt: existing.prompt };
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });

  test('replaces answered question when a different id arrives (new prompt)', () => {
    const existing = uiq('Which approach?', fourSentenceOptions, {
      answeredWith: 'Refactor the authentication module',
    });
    // Different id; treat as a genuinely new prompt.
    const incoming = yesNoFallback();
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('future-timestamped existing is not defended forever (clock skew clamp)', () => {
    // Phone clock 60s ahead of daemon clock. Without the clamp, age is
    // negative and stays under freshnessMs forever, pinning the existing
    // question. The clamp treats the negative age as zero so the window
    // applies normally.
    const future = new Date(2_000_000).toISOString();
    const existing = uiq('Old plan', fourSentenceOptions, { timestamp: future });
    const incoming = yesNoFallback();
    // 6 seconds after the existing's claimed time => stale, replace.
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(2_006_001) })).toBe(false);
  });

  test('boundary: exactly freshnessMs ago is treated as stale (>=)', () => {
    const existing = uiq('Plan', fourSentenceOptions, {
      timestamp: new Date(1_000_000).toISOString(),
    });
    const incoming = yesNoFallback();
    // Strict >= boundary: 5000ms exactly is stale, allow replacement.
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_005_000) })).toBe(false);
  });

  test('default-shape detection: an unflagged case-varied Yes/No is still caught by the label fallback', () => {
    // No `optionsAreFallback` on either side (as if from a pre-#718 daemon):
    // the guard falls back to its label heuristic, which is case-insensitive.
    const existing = uiq('Custom prompt', [
      { label: 'Yes' },
      { label: "Yes, and don't ask again this session" },
      { label: 'No' },
    ]);
    const incoming = uiq('Allow Bash: ls', [{ label: '  YES  ' }, { label: ' no ' }]);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });

  test('an explicit optionsAreFallback: false overrides a label-coincidence match', () => {
    // Even though the labels alone would match the fallback heuristic, an
    // explicit `false` from the daemon is authoritative: this is a real
    // question, not the bland substitute, so it must not be treated as
    // "poorer" than another default-shaped arrival.
    const existing = uiq(
      'Which approach?',
      [
        { label: 'Refactor the authentication module' },
        { label: 'Patch the immediate bug only' },
        { label: 'Rewrite from scratch using a library' },
        { label: 'Skip and document the issue' },
      ],
      { optionsAreFallback: false },
    );
    const incoming = uiq(
      'Allow Bash: ls',
      [
        { label: 'Yes', isYes: true },
        { label: 'No', isNo: true },
      ],
      { optionsAreFallback: false },
    );
    // Neither is the fallback (both explicitly false); falls through to
    // count-based ranking — existing (4) beats incoming (2).
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });

  describe('resolved-elsewhere trace (#652)', () => {
    test('a resolvedReason trace never blocks a genuinely new prompt (different id)', () => {
      // A richer (4-option) trace would normally out-rank an incoming default
      // fallback; once resolved it must step aside so the live prompt shows.
      const existing = uiq('Which approach?', fourSentenceOptions, { resolvedReason: 'answered' });
      const incoming = yesNoFallback('Claude needs your permission to use Bash');
      expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
    });

    test('a same-id replay keeps the resolved trace (no re-prompt)', () => {
      const existing = uiq('Allow Bash: ls', threeOptionNonDefault, { resolvedReason: 'cancelled' });
      const incoming = { ...existing };
      expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
    });
  });
});
