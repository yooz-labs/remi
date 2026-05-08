/**
 * Tests for the client-side richer-wins guard (#396).
 */

import { describe, expect, test } from 'bun:test';
import { shouldKeepExisting } from '../../src/lib/question-merge';
import type { UIQuestion, UIQuestionOption, UUID } from '../../src/types';

let nextId = 0;
function uiq(
  prompt: string,
  options: ReadonlyArray<{ label: string; isYes?: boolean; isNo?: boolean }>,
  extra: { timestamp?: string; answeredWith?: string } = {},
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
  };
}

const yesYesalwaysNo = [
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
  test('keeps a multi-choice when a default 3-set arrives next', () => {
    const existing = uiq('Which approach?', fourSentenceOptions);
    const incoming = uiq('Claude needs your permission to use Bash', yesYesalwaysNo);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });

  test('keeps a 3-set with custom labels when default 3-set arrives next', () => {
    // Edit tool's permission_suggestions (rich) followed by the hook's
    // default fallback (poor) at equal option count.
    const existing = uiq('Allow Edit: src/foo.ts', [
      { label: 'Yes' },
      { label: "Yes, and don't ask again this session" },
      { label: 'No, and tell Claude what to do differently' },
    ]);
    const incoming = uiq('Allow Bash: ls', yesYesalwaysNo);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });

  test('replaces when incoming has more options', () => {
    const existing = uiq('Allow Bash: ls', yesYesalwaysNo);
    const incoming = uiq('Pick a destination', fourSentenceOptions);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('replaces when both are default 3-sets (truly equivalent)', () => {
    const existing = uiq('Allow Bash: ls', yesYesalwaysNo);
    const incoming = uiq('Allow Edit: foo', yesYesalwaysNo);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('replaces when existing was answered (new prompt cycle)', () => {
    const existing = uiq('Which approach?', fourSentenceOptions, {
      answeredWith: 'Refactor the authentication module',
    });
    const incoming = uiq('Allow Bash: ls', yesYesalwaysNo);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('replaces when existing is older than the freshness window', () => {
    const stale = new Date(1_000_000).toISOString();
    const existing = uiq('Old plan question', fourSentenceOptions, { timestamp: stale });
    const incoming = uiq('Allow Bash: ls', yesYesalwaysNo);
    // 6 seconds later: stale, allow replacement.
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_006_001) })).toBe(false);
  });

  test('keeps within window even at the edge (4999 ms)', () => {
    const existing = uiq('Which approach?', fourSentenceOptions, {
      timestamp: new Date(1_000_000).toISOString(),
    });
    const incoming = uiq('Allow Bash: ls', yesYesalwaysNo);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_004_999) })).toBe(true);
  });

  test('replaces when incoming has same count and existing is also a 3-set default', () => {
    // Edge case: identical default-shape pairs come through; the second
    // is no worse than the first so we let it replace (last wins).
    const existing = uiq('Allow Bash: ls', yesYesalwaysNo);
    const incoming = uiq('Allow Bash: ls', yesYesalwaysNo);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('replaces when existing has fewer options regardless of shape', () => {
    const existing = uiq('Run this?', [
      { label: 'Yes', isYes: true },
      { label: 'No', isNo: true },
    ]);
    const incoming = uiq('Run this?', yesYesalwaysNo);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('keeps 4-option richer when poorer 4-option arrives (not a default 3-set)', () => {
    // Equal count but neither is the default 3-set shape — let it through.
    // We only special-case the daemon's hardcoded fallback.
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
    const incoming = uiq('Allow Bash', yesYesalwaysNo);
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
    const incoming = uiq('Allow Bash: ls', yesYesalwaysNo);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(false);
  });

  test('future-timestamped existing is not defended forever (clock skew clamp)', () => {
    // Phone clock 60s ahead of daemon clock. Without the clamp, age is
    // negative and stays under freshnessMs forever, pinning the existing
    // question. The clamp treats the negative age as zero so the window
    // applies normally.
    const future = new Date(2_000_000).toISOString();
    const existing = uiq('Old plan', fourSentenceOptions, { timestamp: future });
    const incoming = uiq('Allow Bash: ls', yesYesalwaysNo);
    // 6 seconds after the existing's claimed time => stale, replace.
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(2_006_001) })).toBe(false);
  });

  test('boundary: exactly freshnessMs ago is treated as stale (>=)', () => {
    const existing = uiq('Plan', fourSentenceOptions, {
      timestamp: new Date(1_000_000).toISOString(),
    });
    const incoming = uiq('Allow Bash: ls', yesYesalwaysNo);
    // Strict >= boundary: 5000ms exactly is stale, allow replacement.
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_005_000) })).toBe(false);
  });

  test('default-shape detection is case-insensitive', () => {
    const existing = uiq('Custom prompt', [
      { label: 'Yes' },
      { label: "Yes, and don't ask again this session" },
      { label: 'No' },
    ]);
    const incoming = uiq('Allow Bash: ls', [
      { label: '  YES  ' },
      { label: 'yes, ALWAYS' },
      { label: ' no ' },
    ]);
    expect(shouldKeepExisting(existing, incoming, { now: fixedNow(1_001_000) })).toBe(true);
  });
});
