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

  it('returns the standard ExitPlanMode choices in render order', () => {
    const q = extractToolQuestion('ExitPlanMode', { plan: '# Plan\n- step 1\n- step 2' });
    expect(q).not.toBeNull();
    if (!q) return;
    expect(q.options.map((o) => o.label)).toEqual([
      'Yes, and auto-accept edits',
      'Yes, and manually approve edits',
      'No, keep planning',
    ]);
    expect(q.options.map((o) => o.value)).toEqual(['1', '2', '3']);
    expect(q.options.every((o) => o.isYes === false && o.isNo === false)).toBe(true);
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
  it('maps >= 2 string suggestions, flagging yes/no shape', () => {
    const opts = optionsFromSuggestions(['Yes', 'Always', 'No']);
    expect(opts.map((o) => o.label)).toEqual(['Yes', 'Always', 'No']);
    expect(opts.map((o) => o.value)).toEqual(['1', '2', '3']);
    expect(opts[0]?.isYes).toBe(true);
    expect(opts[1]?.isYes).toBe(true); // "Always"
    expect(opts[2]?.isNo).toBe(true);
  });

  it('falls back to the default 3-set when there are < 2 string suggestions', () => {
    const def = optionsFromSuggestions(undefined);
    expect(def).toHaveLength(3);
    expect(def[0]?.isYes).toBe(true);
    expect(def[2]?.isNo).toBe(true);
    // Structured-only suggestions (no pickable strings) also fall back.
    expect(optionsFromSuggestions([{ type: 'addDirectories' }])).toHaveLength(3);
    expect(optionsFromSuggestions(['OnlyOne'])).toHaveLength(3);
  });
});
