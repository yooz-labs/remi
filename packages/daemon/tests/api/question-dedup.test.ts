/**
 * Tests for QuestionDedup — merges questions emitted from hook bridge and
 * PTY OutputProcessor, used to fix issue #378 (every question rendered as 3
 * options because PTY parser was gated when hooks were active).
 */

import { describe, expect, test } from 'bun:test';
import type { Question, QuestionOption } from '@remi/shared';
import { QuestionDedup, looksLikeDefaultPermissionQuestion } from '../../src/api/question-dedup.ts';
import { parseQuestion } from '../../src/parser/question-parser.ts';
import { WRAPPED_DIRECTORY_DIALOG } from '../parser/fixtures/claude-dialogs.ts';

function opt(label: string, value: string): QuestionOption {
  return { label, value, isRecommended: false, isYes: false, isNo: false };
}

let nextId = 0;
function q(text: string, optionCount: number, allowsFreeText = false): Question {
  const options: QuestionOption[] = [];
  for (let i = 1; i <= optionCount; i++) {
    options.push(opt(`Option ${i}`, String(i)));
  }
  return {
    id: `id-${++nextId}`,
    text,
    options,
    allowsFreeText,
    isAnswered: false,
  };
}

describe('QuestionDedup', () => {
  test('emits the first question', () => {
    const dedup = new QuestionDedup();
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
  });

  test('suppresses same-fingerprint question with same option count within window', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
    t += 200; // 200ms later (PTY parser arrives after hook)
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(false);
  });

  test('does NOT suppress an identical prompt from a DIFFERENT agent (#483)', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    // Main agent asks; then a background subagent asks the identical thing.
    expect(dedup.shouldEmit({ ...q('Allow Bash: ls', 3) })).toBe(true);
    t += 200;
    const subagent: Question = { ...q('Allow Bash: ls', 3), agentId: 'subagent-A' };
    // Different agent -> a genuinely distinct question the user must answer.
    expect(dedup.shouldEmit(subagent)).toBe(true);
    // But the subagent's own re-emit within the window is still suppressed.
    t += 100;
    expect(dedup.shouldEmit({ ...q('Allow Bash: ls', 3), agentId: 'subagent-A' })).toBe(false);
  });

  test('suppresses same-fingerprint question with fewer options within window', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Pick a file', 5))).toBe(true);
    t += 100;
    expect(dedup.shouldEmit(q('Pick a file', 2))).toBe(false);
  });

  test('emits same-fingerprint question with MORE options (upgrade)', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    // Hook emits default 3-option permission question
    expect(dedup.shouldEmit(q('Pick a file', 3))).toBe(true);
    t += 150;
    // PTY parser sees 5 numbered options on screen — upgrade
    expect(dedup.shouldEmit(q('Pick a file', 5))).toBe(true);
  });

  test('emits same-fingerprint question that gains allowsFreeText (upgrade)', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Enter your name', 0, false))).toBe(true);
    t += 100;
    // PTY detects waiting prompt — upgrade with free text
    expect(dedup.shouldEmit(q('Enter your name', 0, true))).toBe(true);
  });

  test('emits different-fingerprint question regardless of timing', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
    t += 50;
    expect(dedup.shouldEmit(q('Allow Edit: foo.ts', 3))).toBe(true);
  });

  test('emits same-fingerprint question after window expires', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
    t += 6000; // Past the 5s window
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
  });

  test('fingerprint normalizes case and whitespace', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Allow Bash:   ls -la', 3))).toBe(true);
    t += 100;
    // Same prompt with different casing/spacing — still suppressed
    expect(dedup.shouldEmit(q('allow bash: ls -la', 3))).toBe(false);
  });

  test('reset() clears state', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
    dedup.reset();
    t += 100;
    // Same question after reset is treated as fresh
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
  });

  test('upgrade re-arms baseline so subsequent equal/poorer is suppressed', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Pick a file', 3))).toBe(true);
    t += 100;
    // Upgrade to 5 options
    expect(dedup.shouldEmit(q('Pick a file', 5))).toBe(true);
    t += 100;
    // Another 3-option pass within window — suppressed (we already saw richer)
    expect(dedup.shouldEmit(q('Pick a file', 3))).toBe(false);
    t += 100;
    // Another 5-option pass — also suppressed (not richer than 5)
    expect(dedup.shouldEmit(q('Pick a file', 5))).toBe(false);
  });

  test('long prompt text is truncated to 80 chars for fingerprinting', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    const base = 'a'.repeat(80);
    expect(dedup.shouldEmit(q(`${base} suffix1`, 3))).toBe(true);
    t += 100;
    // Different suffix beyond char 80 — same fingerprint, suppressed
    expect(dedup.shouldEmit(q(`${base} suffix2`, 3))).toBe(false);
  });

  test('whitespace normalization handles tabs and newlines', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Allow Bash: ls -la', 3))).toBe(true);
    t += 100;
    expect(dedup.shouldEmit(q('Allow\tBash:\n  ls -la', 3))).toBe(false);
  });

  test('PTY-first then poorer hook within window: hook is suppressed', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Pick a file', 5))).toBe(true);
    t += 100;
    expect(dedup.shouldEmit(q('Pick a file', 3))).toBe(false);
  });

  test('A then B then A within window: third A re-emits (single-slot)', () => {
    // Document the single-slot limitation. B overwrites A's baseline, so a
    // returning A is treated as fresh. This is acceptable because the dedup
    // is a same-tick safety net; cross-question dedup is not its job.
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
    t += 100;
    expect(dedup.shouldEmit(q('Allow Edit: foo', 3))).toBe(true);
    t += 100;
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
  });

  test('boundary: exactly windowMs ago is treated as expired (strict <)', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
    t += 5000;
    expect(dedup.shouldEmit(q('Allow Bash: ls', 3))).toBe(true);
  });
});

describe('looksLikeDefaultPermissionQuestion', () => {
  // #718: the daemon's fallback shrank from a fabricated 3-set (Yes / Yes,
  // always / No) to the honest 2-set Yes/No, so this heuristic now matches
  // on a 2-option Yes/No shape instead of 3.
  test('matches Yes / No', () => {
    const question = {
      options: [{ label: 'Yes' }, { label: 'No' }],
      allowsFreeText: false,
    };
    expect(looksLikeDefaultPermissionQuestion(question)).toBe(true);
  });

  test('matches Yes / No-and-tell-Claude (real Claude wording)', () => {
    const question = {
      options: [{ label: 'Yes' }, { label: 'No, and tell Claude what to do differently' }],
      allowsFreeText: false,
    };
    expect(looksLikeDefaultPermissionQuestion(question)).toBe(true);
  });

  test('matches case-insensitively with whitespace', () => {
    const question = {
      options: [{ label: '  YES  ' }, { label: 'no thanks' }],
      allowsFreeText: false,
    };
    expect(looksLikeDefaultPermissionQuestion(question)).toBe(true);
  });

  test('does not match 3-option non-permission list', () => {
    const question = {
      options: [{ label: 'dev' }, { label: 'staging' }, { label: 'prod' }],
      allowsFreeText: false,
    };
    expect(looksLikeDefaultPermissionQuestion(question)).toBe(false);
  });

  test('WITH NO optionsAreFallback signal, a genuine 2-option Yes/No is indistinguishable from the fallback by label alone (#718)', () => {
    // When the caller does not thread `optionsAreFallback` through at all
    // (the flag is absent, not `false`), this heuristic falls back to the
    // label match — a real PTY-parsed [y/n] prompt necessarily matches too.
    // Documented tradeoff, not a design goal: PushDedup only uses this to
    // decide whether an equal-or-lower-rank duplicate within the window
    // should suppress, which is the desired outcome for two emissions of the
    // very same on-screen 2-option prompt.
    const question = {
      options: [{ label: 'Yes' }, { label: 'No' }],
      allowsFreeText: false,
    };
    expect(looksLikeDefaultPermissionQuestion(question)).toBe(true);
  });

  describe('optionsAreFallback is authoritative when present (#718 review)', () => {
    test('optionsAreFallback: true wins even when the labels look nothing like the default', () => {
      const question = {
        options: [{ label: 'Refactor' }, { label: 'Patch' }],
        allowsFreeText: false,
        optionsAreFallback: true,
      };
      expect(looksLikeDefaultPermissionQuestion(question)).toBe(true);
    });

    test('optionsAreFallback: false overrides a label match that would otherwise say "default"', () => {
      // The exact case the flag exists to fix: a genuine 2-option Yes/No
      // question (e.g. from the PTY y/n parser, which sets this explicitly)
      // must NOT be treated as the bland fallback merely because its labels
      // happen to read Yes/No.
      const question = {
        options: [{ label: 'Yes' }, { label: 'No' }],
        allowsFreeText: false,
        optionsAreFallback: false,
      };
      expect(looksLikeDefaultPermissionQuestion(question)).toBe(false);
    });

    test('optionsAreFallback: false wins even over a 3-option shape (length check never runs)', () => {
      const question = {
        options: [{ label: 'Yes' }, { label: 'Maybe' }, { label: 'No' }],
        allowsFreeText: false,
        optionsAreFallback: false,
      };
      expect(looksLikeDefaultPermissionQuestion(question)).toBe(false);
    });
  });

  test('does not match a 3-option suggestion-derived set (#718)', () => {
    const question = {
      options: [{ label: 'Yes' }, { label: 'Yes, always allow: rm -rf /tmp' }, { label: 'No' }],
      allowsFreeText: false,
    };
    expect(looksLikeDefaultPermissionQuestion(question)).toBe(false);
  });

  test('does not match 4+ option multi-choice', () => {
    const question = {
      options: [{ label: 'Yes' }, { label: 'Yes, always' }, { label: 'Maybe' }, { label: 'No' }],
      allowsFreeText: false,
    };
    expect(looksLikeDefaultPermissionQuestion(question)).toBe(false);
  });

  test('does not match free-text prompts', () => {
    const question = {
      options: [{ label: 'Yes' }, { label: 'No' }],
      allowsFreeText: true,
    };
    expect(looksLikeDefaultPermissionQuestion(question)).toBe(false);
  });
});

/**
 * #1140: the parser no longer marks a Claude selection box as taking free
 * text. QuestionDedup read that flag as an upgrade ("gains allowsFreeText"),
 * and these tests run the real parse of the real captured dialog through it.
 */
describe('QuestionDedup with a parsed Claude menu (#1140)', () => {
  const dialog = () => {
    const parsed = parseQuestion(WRAPPED_DIRECTORY_DIALOG).question;
    if (!parsed) throw new Error('the captured dialog did not parse as a prompt');
    return parsed;
  };

  test('a re-parse of the same menu within the window is still suppressed', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    expect(dedup.shouldEmit(dialog())).toBe(true);
    t += 100;
    // A redraw mints a fresh id and the same text and options.
    expect(dedup.shouldEmit(dialog())).toBe(false);
  });

  test('the parse is no longer a free-text upgrade over a hook card with the same text and options', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    const parsed = dialog();
    // The hook's card for the same prompt: same text, same option count, no
    // free text (a permission takes a pick). The parse used to arrive with
    // allowsFreeText true and pass as an "upgrade", which put a text-capable
    // duplicate card over a menu.
    const hookCard: Question = {
      id: 'hook-card',
      text: parsed.text,
      options: parsed.options.map((o) => ({ ...o })),
      allowsFreeText: false,
      isAnswered: false,
    };
    expect(dedup.shouldEmit(hookCard)).toBe(true);
    t += 150;
    expect(dedup.shouldEmit(parsed)).toBe(false);
  });

  test('the parse still upgrades a hook card that had fewer options (the count rule is unchanged)', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    const parsed = dialog();
    const poorHookCard: Question = {
      id: 'hook-card',
      text: parsed.text,
      options: parsed.options.slice(0, 2).map((o) => ({ ...o })),
      allowsFreeText: false,
      isAnswered: false,
    };
    expect(dedup.shouldEmit(poorHookCard)).toBe(true);
    t += 150;
    expect(dedup.shouldEmit(parsed)).toBe(true);
  });

  test('a genuine free-text prompt still upgrades (the free-text rule is unchanged)', () => {
    let t = 1000;
    const dedup = new QuestionDedup(5000, () => t);
    const waiting = parseQuestion('Please enter your response:').question;
    if (!waiting) throw new Error('the free-text prompt did not parse');
    expect(waiting.allowsFreeText).toBe(true);
    expect(dedup.shouldEmit({ ...waiting, id: 'earlier', allowsFreeText: false })).toBe(true);
    t += 100;
    expect(dedup.shouldEmit(waiting)).toBe(true);
  });

  test('the parse is not the default permission shape, so a parsed Yes/No menu keeps its own rank', () => {
    const parsed = parseQuestion('Quick check\n❯ 1. Yes\n  2. No').question;
    if (!parsed) throw new Error('the menu did not parse');
    expect(parsed.allowsFreeText).toBe(false);
    expect(parsed.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    // Before #1140 the free-text flag made this "not default"; with the flag
    // false the parse's own optionsAreFallback: false must carry that.
    expect(looksLikeDefaultPermissionQuestion(parsed)).toBe(false);
  });
});
