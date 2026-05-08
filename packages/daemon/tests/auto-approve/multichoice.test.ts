/**
 * Tests for the multi-choice auto-approve helpers (#399).
 */

import { describe, expect, test } from 'bun:test';
import {
  buildMultiChoicePrompt,
  isMultiChoicePermission,
  parseMultiChoiceDecision,
} from '../../src/auto-approve/multichoice.ts';

describe('isMultiChoicePermission', () => {
  test('returns false for null/undefined/empty (default 3-set substitutes)', () => {
    expect(isMultiChoicePermission(undefined)).toBe(false);
    expect(isMultiChoicePermission(null)).toBe(false);
    expect(isMultiChoicePermission([])).toBe(false);
  });

  test('returns false for the standard Yes/Yes-always/No 3-set', () => {
    expect(isMultiChoicePermission(['Yes', 'Yes, always', 'No'])).toBe(false);
    // Case-insensitive + whitespace tolerated.
    expect(isMultiChoicePermission(['  YES  ', 'yes, ALWAYS', ' no '])).toBe(false);
  });

  test('returns false for the standard Yes/No pair', () => {
    expect(isMultiChoicePermission(['Yes', 'No'])).toBe(false);
  });

  test('returns true for non-standard 3-option sets (ExitPlanMode-style)', () => {
    expect(
      isMultiChoicePermission([
        'Yes',
        "Yes, and don't ask again this session",
        'No, and tell Claude what to do differently',
      ]),
    ).toBe(true);
    expect(
      isMultiChoicePermission(['Approve plan', 'Approve and stay in plan mode', 'Reject plan']),
    ).toBe(true);
  });

  test('returns true for >3 option lists', () => {
    expect(isMultiChoicePermission(['Refactor', 'Patch', 'Rewrite', 'Skip'])).toBe(true);
  });

  test('returns true for non-Yes-No 2-option pairs', () => {
    expect(isMultiChoicePermission(['Save', 'Discard'])).toBe(true);
  });
});

describe('buildMultiChoicePrompt', () => {
  test('lists options with 1-based indices in the user message', () => {
    const messages = buildMultiChoicePrompt('ExitPlanMode', { plan: 'Refactor auth module' }, [
      'Approve plan',
      'Approve and stay in plan mode',
      'Reject plan',
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('PICK ONE option');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('  1. Approve plan');
    expect(messages[1].content).toContain('  2. Approve and stay in plan mode');
    expect(messages[1].content).toContain('  3. Reject plan');
  });

  test('appends user instructions when provided', () => {
    const messages = buildMultiChoicePrompt(
      'ExitPlanMode',
      { plan: 'x' },
      ['Yes', 'No'],
      'Always escalate plans involving database migrations.',
    );
    expect(messages[0].content).toContain('USER-SPECIFIC GUIDANCE');
    expect(messages[0].content).toContain('database migrations');
  });

  test('truncates very long inputs', () => {
    const longInput = { plan: 'x'.repeat(5000) };
    const messages = buildMultiChoicePrompt('ExitPlanMode', longInput, ['Yes', 'No']);
    expect(messages[1].content.length).toBeLessThan(2500);
    expect(messages[1].content).toContain('...');
  });
});

describe('parseMultiChoiceDecision', () => {
  test('parses a valid pick within range', () => {
    const r = parseMultiChoiceDecision(
      '{"decision":"pick","index":2,"reasoning":"middle option fits the user intent"}',
      4,
    );
    expect(r.decision).toBe('pick');
    if (r.decision === 'pick') {
      expect(r.index).toBe(2);
      expect(r.reasoning).toBe('middle option fits the user intent');
    }
  });

  test('parses a valid escalate', () => {
    const r = parseMultiChoiceDecision(
      '{"decision":"escalate","reasoning":"plan-mode question; user intent unclear"}',
      4,
    );
    expect(r.decision).toBe('escalate');
    expect(r.reasoning).toContain('plan-mode');
  });

  test('escalates on out-of-range index', () => {
    const r = parseMultiChoiceDecision('{"decision":"pick","index":99,"reasoning":"x"}', 4);
    expect(r.decision).toBe('escalate');
    expect(r.reasoning).toContain('out-of-range');
  });

  test('escalates on zero or negative index', () => {
    const r1 = parseMultiChoiceDecision('{"decision":"pick","index":0,"reasoning":"x"}', 4);
    expect(r1.decision).toBe('escalate');
    const r2 = parseMultiChoiceDecision('{"decision":"pick","index":-1,"reasoning":"x"}', 4);
    expect(r2.decision).toBe('escalate');
  });

  test('escalates on non-integer index', () => {
    const r = parseMultiChoiceDecision('{"decision":"pick","index":2.5,"reasoning":"x"}', 4);
    expect(r.decision).toBe('escalate');
  });

  test('escalates on malformed JSON with parser hint', () => {
    const r = parseMultiChoiceDecision('not json at all', 4);
    expect(r.decision).toBe('escalate');
    expect(r.reasoning).toContain('Unparsable');
  });

  test('escalates on unknown decision strings', () => {
    const r = parseMultiChoiceDecision('{"decision":"approve","reasoning":"x"}', 4);
    expect(r.decision).toBe('escalate');
  });
});
