/**
 * Render smoke tests for the question card (#1127 review T2, T3): the plan
 * card, the AskUserQuestion form's free-text field, and a terminal-only
 * card, rendered with the real component to static markup; and the option
 * hints by the daemon's meaning (#1155).
 */

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Question } from '@remi/shared';
import { QuestionCard } from '../../src/components/chat/QuestionCard';
import { mapQuestionToUIQuestion } from '../../src/lib/question-mapping';
import type { UIQuestion, UIQuestionOption } from '../../src/types';

const TS = '2026-10-02T00:00:00.000Z';
const opt = (label: string, value: string, isYes = false, isNo = false): UIQuestionOption => ({
  label,
  value,
  isRecommended: value === '1',
  isYes,
  isNo,
});

function render(question: UIQuestion): string {
  return renderToStaticMarkup(
    <QuestionCard question={question} onAnswer={() => {}} onAuqAnswer={() => {}} onCancel={() => {}} />,
  );
}

/**
 * #1178 (S6): a Codex card nobody can answer from the phone has no options, and its Cancel only
 * clears it (the request stays pending in Codex's own prompt), where Claude's terminal-only cards
 * deny the call. The daemon marks the first with `cancelDismissesOnly`; the card must offer no
 * input it will refuse and must not claim a decline that does not happen.
 */
describe('a terminal-only card whose Cancel only dismisses (#1178)', () => {
  const codexCard: UIQuestion = {
    id: 'codex' as UIQuestion['id'],
    sessionId: 's' as UIQuestion['sessionId'],
    type: 'free_text',
    prompt: 'Codex asks to change files: edit the config. Answer it in the terminal.',
    timestamp: TS,
    kind: 'permission',
    terminalOnly: true,
    cancelDismissesOnly: true,
  };

  test('it offers no text input, says to answer in the terminal, and its X says it only dismisses', () => {
    const html = render(codexCard);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('Type your response');
    expect(html).toContain('Answer this in the terminal.');
    expect(html).toContain('aria-label="Dismiss (answer in the terminal)"');
    expect(html).not.toContain('Decline tool call');
  });

  test('a form card of the same kind says the same on its button and its X', () => {
    const html = render({
      ...codexCard,
      kind: 'multi_question',
      type: 'numbered',
      questions: [{ text: 'Pick?', multiSelect: false, options: [opt('Red', 'Red')] }],
    });
    expect(html).toContain('>Dismiss (answer in the terminal)</button>');
    expect(html).toContain('aria-label="Dismiss (answer in the terminal)"');
    expect(html).not.toContain('Decline tool call');
    // The sentence under the form does not offer a Cancel that answers: here Cancel only clears it.
    expect(html).toContain(
      'This question can only be answered in the terminal; Cancel only clears it from here.',
    );
    expect(html).not.toContain('(or Cancel)');
  });

  test("Claude's terminal-only card is untouched: it still says Decline tool call, and a plain free-text card still has its input", () => {
    const claudeTerminalOnly = { ...codexCard, cancelDismissesOnly: undefined };
    const html = render(claudeTerminalOnly);
    expect(html).toContain('aria-label="Decline tool call"');
    expect(html).not.toContain('Dismiss (answer in the terminal)');
    // The control: a card that takes text keeps its input row.
    const free = render({ ...codexCard, terminalOnly: undefined, cancelDismissesOnly: undefined });
    expect(free).toContain('<input');
  });

  test('the daemon field reaches the card through the wire mapping, and its absence stays absent', () => {
    const wire: Question = {
      id: 'q' as Question['id'],
      text: 'Codex asks for approval',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      terminalOnly: true,
      cancelDismissesOnly: true,
    };
    const mapped = mapQuestionToUIQuestion(wire, 's' as UIQuestion['sessionId'], TS);
    expect(mapped.cancelDismissesOnly).toBe(true);
    const { cancelDismissesOnly: _dropped, ...claude } = wire;
    expect(Object.keys(mapQuestionToUIQuestion(claude, 's' as UIQuestion['sessionId'], TS))).not.toContain(
      'cancelDismissesOnly',
    );
  });
});

describe('QuestionCard (#1127)', () => {
  const plan: UIQuestion = {
    id: 'plan' as UIQuestion['id'],
    sessionId: 's' as UIQuestion['sessionId'],
    type: 'multi_option',
    prompt: 'Plan ready for review',
    timestamp: TS,
    kind: 'plan_approval',
    detail: '# Create hello.txt\n\n1. Write the file\n2. Check it',
    structuredOptions: [
      opt('Approve, auto-accept edits', '1', true),
      opt('Approve, approve edits manually', '2', true),
      opt('Keep planning', '3', false, true),
    ],
  };

  test('a plan card shows the whole plan, line breaks kept, under "Plan review"', () => {
    const html = render(plan);
    expect(html).toContain('Plan review');
    expect(html).toContain('# Create hello.txt\n\n1. Write the file\n2. Check it');
    expect(html).toContain('whitespace-pre-wrap');
  });

  test('a plan card gives no "Allow once" or "Cancel" hints; its X says it keeps planning (T3)', () => {
    const html = render(plan);
    expect(html).not.toContain('Allow once');
    expect(html).not.toContain('>Cancel<');
    expect(html).toContain('aria-label="Keep planning"');
  });

  test('a binary card keeps its hints and its Cancel (Esc) label', () => {
    const html = render({
      ...plan,
      kind: undefined,
      detail: undefined,
      prompt: 'Allow Bash: ls',
      structuredOptions: [opt('Yes', '1', true), opt('No', '2', false, true)],
    });
    expect(html).toContain('Allow once');
    expect(html).toContain('aria-label="Cancel (Esc)"');
  });

  const form: UIQuestion = {
    id: 'auq' as UIQuestion['id'],
    sessionId: 's' as UIQuestion['sessionId'],
    type: 'numbered',
    prompt: 'Color: Which color?',
    timestamp: TS,
    kind: 'multi_question',
    questions: [
      { text: 'Which color?', multiSelect: false, options: [opt('Red', '1'), opt('Green', '2')] },
      { text: 'Which fruits?', multiSelect: true, options: [opt('Apple', '1'), opt('Cherry', '2')] },
    ],
  };

  test('a single-select question has a free-text field bounded to 2000 characters; a multi-select has none', () => {
    const html = render(form);
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('maxLength="2000"');
    expect(inputs[0]).toContain('aria-label="Your own answer to: Which color?"');
    expect(html).toContain('aria-label="Dismiss question"');
  });

  test('a terminal-only card says so and offers no Submit (S7)', () => {
    const html = render({ ...form, terminalOnly: true });
    expect(html).toContain('This question can only be answered in the terminal (or Cancel).');
    expect(html).not.toContain('>Submit<');
    expect(html).toMatch(/<input[^>]* disabled=""/);
  });

  test('a terminal-only card says its Cancel declines the tool call (#1155)', () => {
    const html = render({ ...form, terminalOnly: true });
    // The form's button and the header's X both carry it.
    expect(html).toContain('>Decline tool call</button>');
    expect(html).toContain('aria-label="Decline tool call"');
    expect(html).not.toContain('Dismiss question');
  });
});

/**
 * #1155: the hint beside each option says what the daemon grants, read from
 * `standingGrant`, never from the label's wording. Real component, real
 * wire-to-UI mapping (`mapQuestionToUIQuestion`), static markup.
 */
describe('QuestionCard option hints (#1155)', () => {
  /** Each option row's label and hint, in order. */
  function rows(html: string): Array<[string, string | null]> {
    return [
      ...html.matchAll(
        /<span class="text-sm font-semibold">([^<]*)<\/span>(?:<span class="ml-auto[^"]*">([^<]*)<\/span>)?/g,
      ),
    ].map((m) => [m[1] ?? '', m[2] ?? null]);
  }

  /** A wire `Question` as the daemon sends it, mapped as App.tsx maps it. */
  function card(options: Question['options']): UIQuestion {
    return mapQuestionToUIQuestion(
      {
        id: 'q-1155' as Question['id'],
        text: 'Allow Bash: touch e5-marker.txt',
        options,
        allowsFreeText: false,
        isAnswered: false,
      },
      's' as UIQuestion['sessionId'],
      TS,
    );
  }

  const wire = (
    label: string,
    value: string,
    flags: Partial<Question['options'][number]> = {},
  ): Question['options'][number] => ({
    label,
    value,
    isRecommended: value === '1',
    isYes: false,
    isNo: false,
    ...flags,
  });

  test('a standing option says "This session"; "Allow once" is only for the plain Yes', () => {
    const html = render(
      card([
        wire('Yes', '1', { isYes: true }),
        wire('Yes, allow touch e5-marker.txt for this session', '2', {
          isYes: true,
          suggestionIndex: 0,
          standingGrant: 'addRules',
        }),
        wire('Yes, and switch to acceptEdits mode', '3', {
          isYes: true,
          suggestionIndex: 1,
          standingGrant: 'setMode',
        }),
        wire('No', '4', { isNo: true }),
      ]),
    );
    expect(rows(html)).toEqual([
      ['Yes', 'Allow once'],
      ['Yes, allow touch e5-marker.txt for this session', 'This session'],
      ['Yes, and switch to acceptEdits mode', 'This session'],
      ['No', 'Cancel'],
    ]);
  });

  test("Codex's \"Yes, for this session\" (standingGrant 'session', #1178) reads \"This session\", not \"Allow once\"", () => {
    const html = render(
      card([
        wire('Yes', 'accept', { isYes: true }),
        wire('Yes, for this session', 'acceptForSession', {
          isYes: true,
          standingGrant: 'session',
        }),
        wire('No', 'cancel', { isNo: true }),
      ]),
    );
    expect(rows(html)).toEqual([
      ['Yes', 'Allow once'],
      ['Yes, for this session', 'This session'],
      ['No', 'Cancel'],
    ]);
  });

  test('a Yes read off the screen with no standingGrant gets no hint, whatever its wording', () => {
    // A hook-less prompt's options come from the screen: the daemon does not
    // know what they grant (Claude may write a settings file), so neither
    // "Allow once" nor "This session" would be true.
    const html = render(
      card([
        wire('Yes', '1', { isYes: true }),
        wire('Yes, and always allow access to tmp/ from this project', '2', { isYes: true }),
        wire('No', '3', { isNo: true }),
      ]),
    );
    expect(rows(html)).toEqual([
      ['Yes', 'Allow once'],
      ['Yes, and always allow access to tmp/ from this project', null],
      ['No', 'Cancel'],
    ]);
    expect(html).not.toContain('Remember for session');
  });
});
