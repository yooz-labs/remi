/**
 * The pure answer mapping for AskUserQuestion and ExitPlanMode (#1127).
 * The payload shapes asserted here are the ones verified live on Claude Code
 * 2.1.287 (#1126 spike, E3 and E4); see `structured-answers.ts`.
 */

import { describe, expect, test } from 'bun:test';
import type { QuestionOption } from '@remi/shared';
import {
  ASK_DISMISSED_MESSAGE,
  type AskRefusal,
  FREE_TEXT_MAX,
  KEEP_PLANNING_MESSAGE,
  askOptionIndex,
  askQuestionSteps,
  askUserQuestionDecision,
  exitPlanModeDecision,
  exitPlanModeOptions,
  keepPlanningDecision,
  parseAskUserQuestion,
} from '../../src/hooks/structured-answers.ts';

/** The two-question input the #1126 spike (E3) answered live. */
const TWO_QUESTIONS = {
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      options: [
        { label: 'Red', description: 'The color red' },
        { label: 'Green', description: 'The color green' },
        { label: 'Blue', description: 'The color blue' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which fruits do you like?',
      header: 'Fruits',
      options: [
        { label: 'Apple', description: 'A red or green fruit' },
        { label: 'Banana', description: 'A yellow fruit' },
        { label: 'Cherry', description: 'A small red fruit' },
      ],
      multiSelect: true,
    },
  ],
};

describe('parseAskUserQuestion', () => {
  test('reads every question, option and flag exactly as sent', () => {
    const parsed = parseAskUserQuestion(TWO_QUESTIONS);
    expect(parsed?.map((q) => [q.question, q.header, q.multiSelect])).toEqual([
      ['Which color do you prefer?', 'Color', false],
      ['Which fruits do you like?', 'Fruits', true],
    ]);
    expect(parsed?.[1]?.options.map((o) => o.label)).toEqual(['Apple', 'Banana', 'Cherry']);
  });

  test('keeps raw labels and question text (whitespace included)', () => {
    const parsed = parseAskUserQuestion({
      questions: [{ question: 'Pick  one\nplease', options: ['A  b', { label: 'C' }] }],
    });
    expect(parsed?.[0]?.question).toBe('Pick  one\nplease');
    expect(parsed?.[0]?.options.map((o) => o.label)).toEqual(['A  b', 'C']);
  });

  test.each([
    ['no questions', {}],
    ['empty questions', { questions: [] }],
    ['question without text', { questions: [{ options: ['a'] }] }],
    ['question without options', { questions: [{ question: 'Q', options: [] }] }],
    ['an unusable option', { questions: [{ question: 'Q', options: ['a', { label: '' }] }] }],
    [
      'a non-boolean multiSelect',
      { questions: [{ question: 'Q', options: ['a'], multiSelect: 'yes' }] },
    ],
    [
      'two questions with the same text',
      {
        questions: [
          { question: 'Q', options: ['a'] },
          { question: 'Q', options: ['b'] },
        ],
      },
    ],
    ['two options with the same label', { questions: [{ question: 'Q', options: ['a', 'a'] }] }],
  ])('refuses an input it cannot answer exactly: %s', (_name, input) => {
    expect(parseAskUserQuestion(input)).toBeNull();
  });
});

describe('askUserQuestionDecision', () => {
  test('two questions, single and multi-select: questions echoed, answers by question text', () => {
    const result = askUserQuestionDecision(TWO_QUESTIONS, [
      { questionIndex: 0, optionIndices: [1] },
      { questionIndex: 1, optionIndices: [2, 0] },
    ]);
    // The exact response the spike verified (E3): labels joined with ", " in
    // the dialog's order, whatever order the indices came in.
    expect(result).toEqual({
      ok: true,
      decision: {
        behavior: 'allow',
        updatedInput: {
          questions: TWO_QUESTIONS.questions,
          answers: {
            'Which color do you prefer?': 'Green',
            'Which fruits do you like?': 'Apple, Cherry',
          },
        },
      },
    });
    // The echo is the input itself, not a rebuilt copy of it.
    if (result.ok && typeof result.decision === 'object' && 'updatedInput' in result.decision) {
      expect(result.decision.updatedInput['questions']).toBe(TWO_QUESTIONS.questions);
    }
  });

  test('the echo carries every key of the tool input unchanged', () => {
    const input = { ...TWO_QUESTIONS, metadata: { source: 'x' } };
    const result = askUserQuestionDecision(input, [
      { questionIndex: 0, optionIndices: [0] },
      { questionIndex: 1, optionIndices: [1] },
    ]);
    expect(
      result.ok && typeof result.decision === 'object' && 'updatedInput' in result.decision
        ? result.decision.updatedInput
        : null,
    ).toEqual({
      ...input,
      answers: { 'Which color do you prefer?': 'Red', 'Which fruits do you like?': 'Banana' },
    });
  });

  test('the answer key is the raw question text and the value the raw label', () => {
    const input = { questions: [{ question: 'Pick  one', options: [{ label: 'A  b' }, 'C'] }] };
    const result = askUserQuestionDecision(input, [{ questionIndex: 0, optionIndices: [0] }]);
    expect(result).toEqual({
      ok: true,
      decision: { behavior: 'allow', updatedInput: { ...input, answers: { 'Pick  one': 'A  b' } } },
    });
  });

  test('a question whose text is __proto__ (or another Object.prototype name) keeps its answer', () => {
    const input = {
      questions: [
        { question: '__proto__', options: ['A', 'B'] },
        { question: 'constructor', options: ['C', 'D'] },
      ],
    };
    const result = askUserQuestionDecision(input, [
      { questionIndex: 0, optionIndices: [1] },
      { questionIndex: 1, optionIndices: [0] },
    ]);
    const updatedInput =
      result.ok && typeof result.decision === 'object' && 'updatedInput' in result.decision
        ? result.decision.updatedInput
        : null;
    // What Claude receives is the JSON: both keys present as plain answers.
    expect(JSON.parse(JSON.stringify(updatedInput))['answers']).toEqual(
      JSON.parse('{"__proto__":"B","constructor":"C"}'),
    );
    expect(JSON.stringify(updatedInput)).toContain('"answers":{"__proto__":"B","constructor":"C"}');
  });

  test('a multi-select answer is keyed by the raw question text and joins the raw labels', () => {
    const input = {
      questions: [
        { question: 'Pick\nany', multiSelect: true, options: [{ label: 'A  b' }, 'C', 'D  e'] },
      ],
    };
    const result = askUserQuestionDecision(input, [{ questionIndex: 0, optionIndices: [2, 0] }]);
    expect(result).toEqual({
      ok: true,
      decision: {
        behavior: 'allow',
        updatedInput: { ...input, answers: { 'Pick\nany': 'A  b, D  e' } },
      },
    });
  });

  test('free text answers a single-select question, trimmed; longer than the bound it is refused, never cut', () => {
    const one = { questions: [TWO_QUESTIONS.questions[0]] };
    const typed = askUserQuestionDecision(one, [
      { questionIndex: 0, optionIndices: [], text: '  Teal, please  ' },
    ]);
    expect(typed).toEqual({
      ok: true,
      decision: {
        behavior: 'allow',
        updatedInput: { ...one, answers: { 'Which color do you prefer?': 'Teal, please' } },
      },
    });
    const atBound = askUserQuestionDecision(one, [
      { questionIndex: 0, text: `  ${'x'.repeat(FREE_TEXT_MAX)}  ` },
    ]);
    expect(atBound.ok).toBe(true);
    expect(
      askUserQuestionDecision(one, [{ questionIndex: 0, text: 'x'.repeat(FREE_TEXT_MAX + 1) }]),
    ).toEqual({ ok: false, reason: 'free-text-too-long' });
  });

  test.each([
    [
      'a question left unanswered',
      [{ questionIndex: 0, optionIndices: [0] }],
      'unanswered-question',
    ],
    [
      'the same question twice',
      [
        { questionIndex: 0, optionIndices: [0] },
        { questionIndex: 0, optionIndices: [1] },
      ],
      'duplicate-question',
    ],
    [
      'a question that does not exist',
      [
        { questionIndex: 0, optionIndices: [0] },
        { questionIndex: 2, optionIndices: [0] },
      ],
      'unknown-question',
    ],
    [
      'two options on a single-select',
      [
        { questionIndex: 0, optionIndices: [0, 1] },
        { questionIndex: 1, optionIndices: [0] },
      ],
      'single-select-needs-one-answer',
    ],
    [
      'an option and free text on a single-select',
      [
        { questionIndex: 0, optionIndices: [0], text: 'also this' },
        { questionIndex: 1, optionIndices: [0] },
      ],
      'single-select-needs-one-answer',
    ],
    [
      'nothing on a single-select',
      [
        { questionIndex: 0, optionIndices: [], text: '   ' },
        { questionIndex: 1, optionIndices: [0] },
      ],
      'single-select-needs-one-answer',
    ],
    [
      'no label on a multi-select',
      [
        { questionIndex: 0, optionIndices: [0] },
        { questionIndex: 1, optionIndices: [] },
      ],
      'multi-select-needs-a-label',
    ],
    [
      'free text on a multi-select',
      [
        { questionIndex: 0, optionIndices: [0] },
        { questionIndex: 1, optionIndices: [0], text: 'Mango' },
      ],
      'multi-select-needs-a-label',
    ],
    [
      'an option index out of range',
      [
        { questionIndex: 0, optionIndices: [3] },
        { questionIndex: 1, optionIndices: [0] },
      ],
      'bad-option-index',
    ],
    [
      'a repeated option index',
      [
        { questionIndex: 0, optionIndices: [0] },
        { questionIndex: 1, optionIndices: [1, 1] },
      ],
      'bad-option-index',
    ],
    [
      'a fractional option index',
      [
        { questionIndex: 0, optionIndices: [0.5] },
        { questionIndex: 1, optionIndices: [0] },
      ],
      'bad-option-index',
    ],
    ['no selections at all', [], 'malformed-selections'],
    ['selections that are not a list', { 0: [0] }, 'malformed-selections'],
    [
      'a non-string text',
      [
        { questionIndex: 0, optionIndices: [], text: 7 },
        { questionIndex: 1, optionIndices: [0] },
      ],
      'malformed-selections',
    ],
  ])('refuses %s, never completing it', (_name, selections, reason) => {
    expect(askUserQuestionDecision(TWO_QUESTIONS, selections)).toEqual({
      ok: false,
      reason: reason as AskRefusal,
    });
  });

  test('refuses every answer to an input it cannot parse exactly', () => {
    expect(
      askUserQuestionDecision({ questions: [{ question: 'Q', options: ['a', 'a'] }] }, [
        { questionIndex: 0, optionIndices: [0] },
      ]),
    ).toEqual({ ok: false, reason: 'unanswerable-input' });
  });
});

describe('askQuestionSteps and askOptionIndex', () => {
  test("a step's options are numbered by the index an answer names them by", () => {
    const parsed = parseAskUserQuestion(TWO_QUESTIONS);
    if (parsed === null) throw new Error('parse failed');
    const steps = askQuestionSteps(parsed);
    expect(steps[0]?.options.map((o) => [o.value, o.label, o.description])).toEqual([
      ['1', 'Red', 'The color red'],
      ['2', 'Green', 'The color green'],
      ['3', 'Blue', 'The color blue'],
    ]);
    expect(steps.map((s) => [s.header, s.text, s.multiSelect])).toEqual([
      ['Color', 'Which color do you prefer?', false],
      ['Fruits', 'Which fruits do you like?', true],
    ]);
  });

  test('a lock-screen pick names an option of a one-question single-select by value and label', () => {
    const one = parseAskUserQuestion({ questions: [TWO_QUESTIONS.questions[0]] });
    if (one === null) throw new Error('parse failed');
    const [red, green] = askQuestionSteps(one)[0]?.options ?? [];
    expect(askOptionIndex(one, green as QuestionOption)).toBe(1);
    expect(askOptionIndex(one, red as QuestionOption)).toBe(0);
    // A value and label that disagree with the input answer nothing.
    expect(askOptionIndex(one, { ...(green as QuestionOption), label: 'Red' })).toBeNull();
    expect(askOptionIndex(one, { ...(green as QuestionOption), value: '9' })).toBeNull();
  });

  test('a single pick never answers more than one question or a multi-select', () => {
    const both = parseAskUserQuestion(TWO_QUESTIONS);
    const multi = parseAskUserQuestion({ questions: [TWO_QUESTIONS.questions[1]] });
    if (both === null || multi === null) throw new Error('parse failed');
    const pick = askQuestionSteps(both)[0]?.options[0] as QuestionOption;
    expect(askOptionIndex(both, pick)).toBeNull();
    expect(
      askOptionIndex(multi, askQuestionSteps(multi)[0]?.options[0] as QuestionOption),
    ).toBeNull();
  });

  test('the dismissal message is fixed', () => {
    expect(ASK_DISMISSED_MESSAGE).toBe('The user dismissed the question.');
  });
});

describe('ExitPlanMode', () => {
  const PLAN_INPUT = {
    plan: '# Create hello.txt\n\nWrite a file named `hello.txt`.\n',
    planFilePath: '/Users/x/.claude/plans/i-want-a-file-sunny-blum.md',
  };
  const [ACCEPT_EDITS, MANUAL, KEEP] = exitPlanModeOptions() as [
    QuestionOption,
    QuestionOption,
    QuestionOption,
  ];

  test('three options by meaning; auto is never offered', () => {
    expect(exitPlanModeOptions().map((o) => [o.label, o.value, o.isYes, o.isNo])).toEqual([
      ['Approve, auto-accept edits', '1', true, false],
      ['Approve, approve edits manually', '2', true, false],
      ['Keep planning', '3', false, true],
    ]);
  });

  test('approve with auto-accept edits: plan and path echoed, setMode acceptEdits for the session', () => {
    expect(exitPlanModeDecision(PLAN_INPUT, ACCEPT_EDITS)).toEqual({
      behavior: 'allow',
      updatedInput: PLAN_INPUT,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });

  test('approve with manual edits: setMode default for the session', () => {
    expect(exitPlanModeDecision(PLAN_INPUT, MANUAL)).toEqual({
      behavior: 'allow',
      updatedInput: PLAN_INPUT,
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    });
  });

  test('the echo is a copy of the input, byte for byte', () => {
    const decision = exitPlanModeDecision(PLAN_INPUT, ACCEPT_EDITS);
    const echoed =
      decision !== null && typeof decision === 'object' && 'updatedInput' in decision
        ? decision.updatedInput
        : null;
    expect(JSON.stringify(echoed)).toBe(JSON.stringify(PLAN_INPUT));
  });

  test('keep planning denies with the message, or "Keep planning."', () => {
    expect(exitPlanModeDecision(PLAN_INPUT, KEEP, '  Add a test step.  ')).toEqual({
      behavior: 'deny',
      message: 'Add a test step.',
    });
    expect(exitPlanModeDecision(PLAN_INPUT, KEEP)).toEqual({
      behavior: 'deny',
      message: KEEP_PLANNING_MESSAGE,
    });
    expect(keepPlanningDecision('   ')).toEqual({ behavior: 'deny', message: 'Keep planning.' });
  });

  test('an option that is not one of the plan card own answers nothing', () => {
    expect(exitPlanModeDecision(PLAN_INPUT, { ...ACCEPT_EDITS, value: '2' })).toBeNull();
    expect(exitPlanModeDecision(PLAN_INPUT, { ...ACCEPT_EDITS, label: 'Yes' })).toBeNull();
    expect(
      exitPlanModeDecision(PLAN_INPUT, {
        label: 'Yes, and use auto mode',
        value: '1',
        isRecommended: true,
        isYes: true,
        isNo: false,
      }),
    ).toBeNull();
  });
});
