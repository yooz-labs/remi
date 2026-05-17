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
    // Yes/Yes-always/No UI. Classifying them as multi-choice + the
    // default `multichoice = "skip"` regresses every Bash auto-approve
    // into a silent escalate. Lock the binary route.
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
    // route to multi-choice so the safe escalate path runs. The LLM's
    // ALWAYS-ESCALATE rules then prevent a nonsensical pick from a
    // 1-item menu. Without this property, a future Claude Code payload
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

describe('buildMultiChoicePrompt', () => {
  test('lists options with 1-based indices in the user message', () => {
    const messages = buildMultiChoicePrompt('ExitPlanMode', { plan: 'Refactor auth module' }, [
      'Approve plan',
      'Approve and stay in plan mode',
      'Reject plan',
    ]);
    expect(messages).toHaveLength(2);
    const [system, user] = messages as [
      { role: string; content: string },
      { role: string; content: string },
    ];
    expect(system.role).toBe('system');
    expect(system.content).toContain('PICK ONE option');
    expect(user.role).toBe('user');
    expect(user.content).toContain('  1. Approve plan');
    expect(user.content).toContain('  2. Approve and stay in plan mode');
    expect(user.content).toContain('  3. Reject plan');
  });

  test('appends user instructions when provided', () => {
    const messages = buildMultiChoicePrompt(
      'ExitPlanMode',
      { plan: 'x' },
      ['Yes', 'No'],
      'Always escalate plans involving database migrations.',
    );
    const [system] = messages as [{ role: string; content: string }];
    expect(system.content).toContain('USER-SPECIFIC GUIDANCE');
    expect(system.content).toContain('database migrations');
  });

  test('truncates very long inputs', () => {
    const longInput = { plan: 'x'.repeat(5000) };
    const messages = buildMultiChoicePrompt('ExitPlanMode', longInput, ['Yes', 'No']);
    const user = messages[1] as { content: string };
    expect(user.content.length).toBeLessThan(2500);
    expect(user.content).toContain('...');
  });

  test('system prompt makes the design/direction/steering escalate rule explicit', () => {
    // The prompt must steer the LLM away from picking on direction,
    // design, scope, or steering questions. Locks the rule so a future
    // prompt rewrite cannot quietly drop it.
    const messages = buildMultiChoicePrompt('ExitPlanMode', {}, ['A', 'B']);
    const system = messages[0] as { content: string };
    const lower = system.content.toLowerCase();
    expect(lower).toContain('always escalate');
    expect(lower).toContain('direction');
    expect(lower).toContain('design');
    expect(lower).toContain('scope');
  });

  test('system prompt flags irreversible/permanent options as escalate', () => {
    // Options that mention "always", "permanent", or session-wide
    // commitment must escalate. Locks the rule.
    const messages = buildMultiChoicePrompt('ExitPlanMode', {}, ['A', 'B']);
    const system = messages[0] as { content: string };
    const lower = system.content.toLowerCase();
    expect(lower).toContain('irreversible');
    expect(lower).toContain('always');
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

  test('escalates on well-formed JSON with the wrong decision string (#400 review)', () => {
    // Pre-#400-review behavior labelled this "Unparsable", which is misleading
    // when triaging logs. The new branch distinguishes the failure modes.
    const r = parseMultiChoiceDecision('{"decision":"approve","reasoning":"x"}', 4);
    expect(r.decision).toBe('escalate');
    expect(r.reasoning).toContain('Invalid multi-choice decision');
    expect(r.reasoning).not.toContain('Unparsable');
  });

  test('escalates on JSON that is not an object', () => {
    const r = parseMultiChoiceDecision('"just a string"', 4);
    expect(r.decision).toBe('escalate');
    expect(r.reasoning).toContain('not a JSON object');
  });
});
