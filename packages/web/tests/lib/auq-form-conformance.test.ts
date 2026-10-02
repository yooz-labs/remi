/**
 * Two-sided conformance (ADR 0014) for the AskUserQuestion form (#1127
 * review T2): the web form's `auqFormComplete` enables Submit exactly when
 * the daemon's `askUserQuestionDecision` would accept `auqFormSelections`,
 * over every combination of picks and typed text for a two-question card.
 *
 * Both ends are real: the card's steps come from the daemon's card builder
 * (`extractToolQuestion`) through the web mapping (`mapQuestionToUIQuestion`),
 * exactly what the app renders, and the verdict is the daemon's own
 * validation of what the app would send.
 */

import { describe, expect, test } from 'bun:test';
import type { Question, UUID } from '@remi/shared';
import { askUserQuestionDecision } from '../../../daemon/src/hooks/structured-answers.ts';
import { extractToolQuestion } from '../../../daemon/src/hooks/tool-question.ts';
import { AUQ_FREE_TEXT_MAX, auqFormComplete, auqFormSelections } from '../../src/lib/auq-form';
import { mapQuestionToUIQuestion } from '../../src/lib/question-mapping';

const INPUT = {
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
      multiSelect: false,
    },
    {
      question: 'Which fruits do you like?',
      header: 'Fruits',
      options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
      multiSelect: true,
    },
  ],
};

/** Every subset of `n` option indices. */
function subsets(n: number): number[][] {
  const out: number[][] = [];
  for (let mask = 0; mask < 1 << n; mask++) {
    out.push([...Array(n).keys()].filter((i) => (mask & (1 << i)) !== 0));
  }
  return out;
}

describe('the web form and the daemon agree on every answer (#1127 review T2)', () => {
  const tool = extractToolQuestion('AskUserQuestion', INPUT);
  if (tool === null) throw new Error('the card did not build');
  const question: Question = {
    id: 'q' as UUID,
    text: tool.text,
    options: tool.options,
    allowsFreeText: false,
    isAnswered: false,
    kind: 'multi_question',
    ...(tool.questions ? { questions: tool.questions } : {}),
  };
  const steps = mapQuestionToUIQuestion(question, 's' as UUID).questions ?? [];

  test('the card the app renders has both questions', () => {
    expect(steps.map((s) => [s.text, s.multiSelect, s.options.length])).toEqual([
      ['Which color do you prefer?', false, 3],
      ['Which fruits do you like?', true, 3],
    ]);
  });

  test('Submit is enabled exactly when the daemon accepts the answer, over every state', () => {
    const texts = [undefined, '', '   ', 'Teal', 'x'.repeat(AUQ_FREE_TEXT_MAX + 1)];
    let states = 0;
    const mismatches: string[] = [];
    for (const pick0 of subsets(3)) {
      for (const pick1 of subsets(3)) {
        for (const text0 of texts) {
          for (const text1 of [undefined, 'Mango']) {
            const selected = new Map([
              [0, new Set(pick0)],
              [1, new Set(pick1)],
            ]);
            const typed = new Map<number, string>();
            if (text0 !== undefined) typed.set(0, text0);
            if (text1 !== undefined) typed.set(1, text1);
            const complete = auqFormComplete(steps, selected, typed);
            const verdict = askUserQuestionDecision(
              INPUT,
              auqFormSelections(steps, selected, typed),
            );
            states++;
            if (complete !== verdict.ok) {
              mismatches.push(
                JSON.stringify({ pick0, pick1, text0: text0?.slice(0, 8), text1, complete }),
              );
            }
          }
        }
      }
    }
    expect(states).toBe(640);
    expect(mismatches).toEqual([]);
  });
});
