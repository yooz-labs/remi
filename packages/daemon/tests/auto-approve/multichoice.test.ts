/**
 * Tests for the multi-choice / design-question detectors (#399, #572), which
 * decide whether an escalation is pushed on its render or immediately.
 */

import { describe, expect, test } from 'bun:test';
import {
  ALWAYS_ESCALATE_TOOLS,
  isDesignQuestion,
  isMultiChoicePermission,
} from '../../src/auto-approve/multichoice.ts';

describe('isMultiChoicePermission', () => {
  test('returns false for null/undefined/empty (default 3-set substitutes)', () => {
    expect(isMultiChoicePermission('Bash', undefined)).toBe(false);
    expect(isMultiChoicePermission('Bash', null)).toBe(false);
    expect(isMultiChoicePermission('Bash', [])).toBe(false);
  });

  test('returns false for the standard Yes/Yes-always/No 3-set', () => {
    expect(isMultiChoicePermission('Bash', ['Yes', 'Yes, always', 'No'])).toBe(false);
  });

  test("returns false for Edit's real ['Yes','Always','No'] shape (#400 review)", () => {
    // Edit/Write/MultiEdit's actual permission_suggestions; "Always" is a
    // yes-shaped synonym (matches isYes heuristic at hook-event-bridge.ts:240).
    expect(isMultiChoicePermission('Edit', ['Yes', 'Always', 'No'])).toBe(false);
    expect(isMultiChoicePermission('Write', ['Yes', 'Always', 'No'])).toBe(false);
    expect(isMultiChoicePermission('MultiEdit', ['Yes', 'Always', 'No'])).toBe(false);
  });

  test('returns false for the Allow/Deny pair', () => {
    expect(isMultiChoicePermission('Bash', ['Allow', 'Deny'])).toBe(false);
  });

  test('returns false for the standard Yes/No pair', () => {
    expect(isMultiChoicePermission('Bash', ['Yes', 'No'])).toBe(false);
    // Whitespace + case tolerated.
    expect(isMultiChoicePermission('Bash', [' YES ', ' no '])).toBe(false);
  });

  test('returns false for sentence labels that still start with yes/no', () => {
    // ExitPlanMode-style labels that all start with "Yes"/"No": label-shape
    // alone says binary. The tool-name list is what makes ExitPlanMode
    // multi-choice in the next test.
    expect(
      isMultiChoicePermission('Bash', [
        'Yes',
        "Yes, and don't ask again this session",
        'No, and tell Claude what to do differently',
      ]),
    ).toBe(false);
  });

  test('ExitPlanMode is always multi-choice regardless of label shape', () => {
    expect(isMultiChoicePermission('ExitPlanMode', ['Yes', 'No'])).toBe(true);
    expect(isMultiChoicePermission('ExitPlanMode', ['Yes', 'Always', 'No'])).toBe(true);
    expect(isMultiChoicePermission('ExitPlanMode', undefined)).toBe(true);
  });

  test('returns true for >3 option lists', () => {
    expect(isMultiChoicePermission('CustomTool', ['Refactor', 'Patch', 'Rewrite', 'Skip'])).toBe(
      true,
    );
  });

  test('returns true for non-binary 2-option pairs', () => {
    expect(isMultiChoicePermission('CustomTool', ['Save', 'Discard'])).toBe(true);
  });

  test('returns true for 3-option list with non-binary middle label', () => {
    expect(isMultiChoicePermission('CustomTool', ['Yes', 'Maybe later', 'No'])).toBe(true);
  });

  test('ignores non-string entries when classifying around real string labels', () => {
    // Garbage entries (null, raw numbers, bare objects) carry no
    // pickable label. Classification reads only the string subset, so
    // ['Yes', 'No'] plus a stray null is still binary. Defensive against
    // schema drift without flipping every real Claude Code prompt into
    // an unconditional escalate.
    expect(isMultiChoicePermission('Bash', [null, 'Yes', 'No'] as readonly unknown[])).toBe(false);
    // No string labels at all -> default UI options (Yes/Yes-always/No)
    // -> binary.
    expect(isMultiChoicePermission('Bash', [{}, 1] as readonly unknown[])).toBe(false);
  });

  test('returns false for object-only rule-suggestion metadata (the regression fix)', () => {
    // Concrete shapes observed live from Claude Code (2026-05-13 onwards).
    // These are typed rule suggestions Claude Code attaches to a normal
    // Bash permission prompt; the user still sees the standard
    // Yes/Yes-always/No UI. Classifying them as multi-choice would push
    // every Bash prompt at hook time instead of when it renders (#1121;
    // before #1125 it also skipped the evaluator). Lock the binary route.
    expect(
      isMultiChoicePermission('Bash', [
        {
          type: 'addDirectories',
          directories: ['/Users/foo/.claude/agents'],
          destination: 'session',
        },
      ] as readonly unknown[]),
    ).toBe(false);
    expect(
      isMultiChoicePermission('Bash', [
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      ] as readonly unknown[]),
    ).toBe(false);
    expect(
      isMultiChoicePermission('Bash', [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'rm -rf derivatives/preproc/sub-NDARAA948VFH' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ] as readonly unknown[]),
    ).toBe(false);
  });

  test('returns true when 4+ STRING labels are present alongside object metadata', () => {
    // Mixed payload with enough real labels to overflow the binary path.
    expect(
      isMultiChoicePermission('CustomTool', [
        'Refactor',
        'Patch',
        'Rewrite',
        'Skip',
        { type: 'addRules', rules: [], behavior: 'allow', destination: 'session' },
      ] as readonly unknown[]),
    ).toBe(true);
  });

  test('single non-binary string label (with or without objects) routes to multi-choice', () => {
    // A 1-option string label has no meaningful binary mapping and must
    // route to multi-choice so the card is pushed with the menu as Claude
    // sent it (nothing picks on the user's behalf since #1125). Without
    // this property, a future Claude Code payload
    // like `["Continue"]` would slip into the binary path.
    expect(isMultiChoicePermission('CustomTool', ['Continue'])).toBe(true);
    // Mixed with rule-suggestion objects — same outcome.
    expect(
      isMultiChoicePermission('CustomTool', [
        { type: 'addRules', rules: [], behavior: 'allow', destination: 'session' },
        'Continue',
      ] as readonly unknown[]),
    ).toBe(true);
  });

  test('single yes-shaped string label is still binary (degenerate but well-defined)', () => {
    // Lone "Yes" — degenerate prompt with no negative option — still
    // classifies as binary because the existing isYes/isNo heuristic
    // covers it. Locked in to document the boundary between this and
    // the previous test.
    expect(isMultiChoicePermission('CustomTool', ['Yes'])).toBe(false);
  });
});

describe('isDesignQuestion (#572)', () => {
  const DEFAULTS = ALWAYS_ESCALATE_TOOLS;

  test('AskUserQuestion always escalates by tool name, even with binary suggestions', () => {
    expect(
      isDesignQuestion(
        'AskUserQuestion',
        { questions: [{ question: 'Which?' }] },
        undefined,
        DEFAULTS,
      ),
    ).toBe(true);
    // Tool name wins even when the suggestions look binary.
    expect(isDesignQuestion('AskUserQuestion', {}, ['Yes', 'No'], DEFAULTS)).toBe(true);
  });

  test('ExitPlanMode always escalates by tool name', () => {
    expect(isDesignQuestion('ExitPlanMode', { plan: 'do the thing' }, undefined, DEFAULTS)).toBe(
      true,
    );
  });

  test('Bash is never a design question, even when the command ends in "?"', () => {
    // The free-text heuristic must NOT inspect the Bash command string.
    expect(isDesignQuestion('Bash', { command: 'echo are we sure?' }, undefined, DEFAULTS)).toBe(
      false,
    );
  });

  test('Edit with the standard Yes/Always/No suggestions is not a design question', () => {
    expect(
      isDesignQuestion(
        'Edit',
        { file_path: '/x', old_string: 'a', new_string: 'b' },
        ['Yes', 'Always', 'No'],
        DEFAULTS,
      ),
    ).toBe(false);
  });

  test('free-text heuristic: a custom tool posing a question with no binary suggestions escalates', () => {
    expect(
      isDesignQuestion(
        'mcp__ask',
        { question: 'Which database should we use?' },
        undefined,
        DEFAULTS,
      ),
    ).toBe(true);
    expect(isDesignQuestion('mcp__ask', { questions: ['a', 'b'] }, undefined, DEFAULTS)).toBe(true);
  });

  test('free-text heuristic: a question with binary suggestions has a yes/no mapping, does NOT escalate', () => {
    expect(
      isDesignQuestion('mcp__confirm', { question: 'Proceed?' }, ['Yes', 'No'], DEFAULTS),
    ).toBe(false);
  });

  test('free-text heuristic: a question with non-binary suggestions escalates', () => {
    expect(
      isDesignQuestion('mcp__pick', { question: 'Which?' }, ['Alpha', 'Beta', 'Gamma'], DEFAULTS),
    ).toBe(true);
  });

  test('a tool with no question field and not on the allowlist is not a design question', () => {
    expect(isDesignQuestion('mcp__do', { path: '/x' }, undefined, DEFAULTS)).toBe(false);
  });

  test('whitespace-only question field does not trigger the heuristic', () => {
    expect(isDesignQuestion('mcp__ask', { question: '   ' }, undefined, DEFAULTS)).toBe(false);
  });

  test('config-extensible: a user-listed tool escalates by name', () => {
    expect(isDesignQuestion('mcp__myAsk', {}, undefined, new Set(['mcp__myAsk']))).toBe(true);
  });

  test('empty allowlist: the free-text heuristic still backs up AskUserQuestion-shaped input', () => {
    expect(
      isDesignQuestion('AskUserQuestion', { questions: [{ question: 'x' }] }, undefined, new Set()),
    ).toBe(true);
    // ...but a tool with neither a listed name nor a question field does not escalate.
    expect(isDesignQuestion('Bash', { command: 'ls' }, undefined, new Set())).toBe(false);
  });

  test('a "questions" array of non-question elements does not trigger the heuristic', () => {
    // Only strings or {question: string} objects count; bare numbers/null/{}
    // must not over-escalate a custom tool with an unrelated `questions` field.
    expect(isDesignQuestion('mcp__x', { questions: [42] }, undefined, DEFAULTS)).toBe(false);
    expect(isDesignQuestion('mcp__x', { questions: [null] }, undefined, DEFAULTS)).toBe(false);
    expect(isDesignQuestion('mcp__x', { questions: [{}] }, undefined, DEFAULTS)).toBe(false);
    // ...but the real AskUserQuestion-style {question: string} element does.
    expect(
      isDesignQuestion('mcp__x', { questions: [{ question: 'Pick?' }] }, undefined, DEFAULTS),
    ).toBe(true);
  });
});
