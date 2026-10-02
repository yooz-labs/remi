/**
 * Render smoke tests for the question card (#1127 review T2): the plan
 * card, the AskUserQuestion form's free-text field, and a terminal-only
 * card, rendered with the real component to static markup.
 */

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionCard } from '../../src/components/chat/QuestionCard';
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
  });

  test('a terminal-only card says so and offers no Submit (S7)', () => {
    const html = render({ ...form, terminalOnly: true });
    expect(html).toContain('This question can only be answered in the terminal (or Cancel).');
    expect(html).not.toContain('>Submit<');
    expect(html).toMatch(/<input[^>]* disabled=""/);
  });
});
