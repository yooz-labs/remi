import { describe, expect, it } from 'bun:test';
import { optionsFromSuggestions } from '../../src/hooks/hook-event-bridge.ts';
import { extractToolQuestion } from '../../src/hooks/tool-question.ts';

describe('extractToolQuestion', () => {
  it('extracts the real AskUserQuestion question + option labels as picks', () => {
    const q = extractToolQuestion('AskUserQuestion', {
      questions: [
        {
          question: 'Which database should we use?',
          header: 'Database',
          options: [
            { label: 'Postgres', description: 'relational' },
            { label: 'SQLite', description: 'embedded' },
            { label: 'Redis', description: 'kv' },
          ],
        },
      ],
    });
    expect(q).not.toBeNull();
    if (!q) return;
    // Header prefixes the question.
    expect(q.text).toBe('Database: Which database should we use?');
    expect(q.options.map((o) => o.label)).toEqual(['Postgres', 'SQLite', 'Redis']);
    // Picks: 1-based value, never yes/no-shaped (forces the digit-submit path).
    expect(q.options.map((o) => o.value)).toEqual(['1', '2', '3']);
    expect(q.options.every((o) => o.isYes === false && o.isNo === false)).toBe(true);
  });

  it('accepts string options (not just {label} objects)', () => {
    const q = extractToolQuestion('AskUserQuestion', {
      questions: [{ question: 'Pick a color', options: ['Red', 'Green'] }],
    });
    expect(q?.options.map((o) => o.label)).toEqual(['Red', 'Green']);
    expect(q?.text).toBe('Pick a color');
  });

  it('does NOT eat the spaces in the question text', () => {
    const q = extractToolQuestion('AskUserQuestion', {
      questions: [
        { question: 'Do you want to   proceed\nwith the migration?', options: ['Yes', 'No'] },
      ],
    });
    // Runs of whitespace collapse to a single space; words stay separated.
    expect(q?.text).toBe('Do you want to proceed with the migration?');
  });

  it('builds ExitPlanMode options by meaning and carries the plan (#1127)', () => {
    const q = extractToolQuestion('ExitPlanMode', { plan: '# Plan\n- step 1\n- step 2' });
    expect(q).not.toBeNull();
    if (!q) return;
    // remi's own options, never Claude's model-dependent list; no auto mode.
    expect(q.options.map((o) => [o.label, o.value, o.isYes, o.isNo])).toEqual([
      ['Approve, auto-accept edits', '1', true, false],
      ['Approve, approve edits manually', '2', true, false],
      ['Keep planning', '3', false, true],
    ]);
    expect(q.kind).toBe('plan_approval');
    expect(q.text).toBe('Plan ready for review');
    expect(q.detail).toBe('# Plan\n- step 1\n- step 2');
    // No plan, no detail; the card still asks.
    expect(extractToolQuestion('ExitPlanMode', {})?.detail).toBeUndefined();
    // A subagent's plan: an approval that sets no session mode (review S5).
    expect(
      extractToolQuestion('ExitPlanMode', { plan: '# P' }, { subagent: true })?.options.map(
        (o) => o.label,
      ),
    ).toEqual(['Approve', 'Keep planning']);
  });

  it('numbers an exactly parsed AskUserQuestion from its input; a malformed one keeps the lenient card (#1127)', () => {
    const exact = extractToolQuestion('AskUserQuestion', {
      questions: [{ question: 'Pick', options: ['A', 'B', 'C'] }],
    });
    expect(exact?.questions?.[0]?.options.map((o) => [o.value, o.label])).toEqual([
      ['1', 'A'],
      ['2', 'B'],
      ['3', 'C'],
    ]);
    // A dropped option would shift the numbering, so the gate refuses every
    // answer to such a card; the card itself still shows what it can.
    const lenient = extractToolQuestion('AskUserQuestion', {
      questions: [{ question: 'Pick', options: [{ label: '' }, 'B'] }],
    });
    expect(lenient?.questions?.[0]?.options.map((o) => [o.value, o.label])).toEqual([['1', 'B']]);
    // ...and it is marked so no phone answer is offered (review S7); an exact
    // parse and a question-shaped tool's lenient card are not.
    expect(lenient?.terminalOnly).toBe(true);
    expect(exact?.terminalOnly).toBeUndefined();
    expect(
      extractToolQuestion('mcp__custom__ask', {
        questions: [{ question: 'Pick', options: [{ label: '' }, 'B'] }],
      })?.terminalOnly,
    ).toBeUndefined();
  });

  it('returns null for tools that carry no question (so the caller falls back)', () => {
    expect(extractToolQuestion('Bash', { command: 'git push' })).toBeNull();
    expect(extractToolQuestion('Edit', { file_path: '/tmp/x.ts' })).toBeNull();
  });

  it('returns null on a malformed AskUserQuestion (no questions / no options)', () => {
    expect(extractToolQuestion('AskUserQuestion', {})).toBeNull();
    expect(extractToolQuestion('AskUserQuestion', { questions: [] })).toBeNull();
    expect(
      extractToolQuestion('AskUserQuestion', { questions: [{ question: 'Q', options: [] }] }),
    ).toBeNull();
    expect(
      extractToolQuestion('AskUserQuestion', { questions: [{ options: ['a', 'b'] }] }),
    ).toBeNull();
  });

  it('surfaces a shape-compatible tool (mirrors isDesignQuestion), not an unrelated questions field', () => {
    // Intentional + name-agnostic: an MCP/custom tool mimicking the
    // AskUserQuestion shape gets its real options surfaced.
    const q = extractToolQuestion('mcp__custom__ask', {
      questions: [{ question: 'Proceed?', options: ['A', 'B'] }],
    });
    expect(q?.options.map((o) => o.label)).toEqual(['A', 'B']);
    // A `questions` field that is not the question shape -> null (falls through).
    expect(extractToolQuestion('SomeTool', { questions: [1, 2, 3] })).toBeNull();
    expect(extractToolQuestion('SomeTool', { questions: ['just', 'strings'] })).toBeNull();
  });

  it('surfaces a single-option AskUserQuestion as one pick (does not mask it with Yes/No)', () => {
    const q = extractToolQuestion('AskUserQuestion', {
      questions: [{ question: 'Confirm the one thing?', options: ['Confirm'] }],
    });
    // Showing the real single choice beats a fabricated Yes/No fallback.
    expect(q?.options.map((o) => o.label)).toEqual(['Confirm']);
    expect(q?.options[0]?.value).toBe('1');
  });

  // #626: the full structured multi-question is surfaced, not just questions[0].
  it('surfaces ALL sub-questions with headers, descriptions, and multiSelect', () => {
    const q = extractToolQuestion('AskUserQuestion', {
      questions: [
        {
          question: 'Who is the collaborating PI?',
          header: 'Collab PI',
          multiSelect: false,
          options: [
            { label: 'Scott', description: 'EEGLAB founder' },
            { label: 'Arnaud', description: 'EEGLAB lead' },
          ],
        },
        {
          question: 'Which tools to center on?',
          header: 'Software focus',
          multiSelect: true,
          options: [
            { label: 'EEGLAB', description: 'plugins + BIDS' },
            { label: 'NEMAR', description: 'pipelines' },
          ],
        },
      ],
    });
    expect(q).not.toBeNull();
    if (!q) return;
    expect(q.kind).toBe('multi_question');
    expect(q.submitLabel).toBe('Submit');
    expect(q.questions).toHaveLength(2);
    // Back-compat flat fields mirror questions[0] (header-prefixed text + its options).
    expect(q.text).toBe('Collab PI: Who is the collaborating PI?');
    expect(q.options.map((o) => o.label)).toEqual(['Scott', 'Arnaud']);
    // Step 0: header (NOT prefixed into step text), descriptions, single-select.
    const s0 = q.questions?.[0];
    expect(s0?.header).toBe('Collab PI');
    expect(s0?.text).toBe('Who is the collaborating PI?');
    expect(s0?.multiSelect).toBe(false);
    expect(s0?.options.map((o) => o.description)).toEqual(['EEGLAB founder', 'EEGLAB lead']);
    // Step 1: multiSelect carried; per-step 1-based values.
    const s1 = q.questions?.[1];
    expect(s1?.header).toBe('Software focus');
    expect(s1?.multiSelect).toBe(true);
    expect(s1?.options.map((o) => o.value)).toEqual(['1', '2']);
  });

  it('omits description when the AskUserQuestion option has none', () => {
    const q = extractToolQuestion('AskUserQuestion', {
      questions: [{ question: 'Pick', options: ['A', { label: 'B' }] }],
    });
    expect(q?.options.every((o) => o.description === undefined)).toBe(true);
  });

  it('drops malformed sub-questions but keeps the well-formed ones', () => {
    const q = extractToolQuestion('AskUserQuestion', {
      questions: [
        { question: 'Good one', options: ['A', 'B'] },
        { question: 'No options', options: [] },
        { options: ['orphan'] },
      ],
    });
    expect(q?.questions).toHaveLength(1);
    expect(q?.questions?.[0]?.text).toBe('Good one');
  });
});

describe('optionsFromSuggestions', () => {
  it('maps a multi-choice string set (not all yes/no-shaped) to picks, unchanged', () => {
    const { options, isFallback } = optionsFromSuggestions(['Continue', 'Skip', 'Abort']);
    expect(isFallback).toBe(false);
    expect(options.map((o) => o.label)).toEqual(['Continue', 'Skip', 'Abort']);
    expect(options.map((o) => o.value)).toEqual(['1', '2', '3']);
    expect(options.every((o) => !o.isYes && !o.isNo)).toBe(true);
  });

  it('a legacy all-binary string set is a binary card: Yes/No, no "Always" (#1126)', () => {
    const { options, isFallback } = optionsFromSuggestions(['Yes', 'Always', 'No']);
    expect(isFallback).toBe(true);
    expect(options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('falls back to the honest Yes/No 2-set when there are no usable suggestions (#718)', () => {
    const def = optionsFromSuggestions(undefined);
    expect(def.isFallback).toBe(true);
    expect(def.options).toHaveLength(2);
    expect(def.options[0]?.isYes).toBe(true);
    expect(def.options[1]?.isNo).toBe(true);
    expect(optionsFromSuggestions([{ type: 'addDirectories' }]).isFallback).toBe(true);
    // A single string can't take the string path and isn't a structured
    // object, so it contributes nothing either.
    expect(optionsFromSuggestions(['OnlyOne']).isFallback).toBe(true);
  });

  it('never offers addDirectories, even a well-formed one (#1126)', () => {
    const { options, isFallback } = optionsFromSuggestions([
      { type: 'addDirectories', directories: ['/tmp'] },
    ]);
    expect(isFallback).toBe(true);
    expect(options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });
});
