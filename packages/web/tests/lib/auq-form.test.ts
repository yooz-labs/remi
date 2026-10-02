/**
 * The AskUserQuestion form's answer (#1127): Submit is enabled exactly when
 * the daemon would accept the answer, and free text answers a single-select
 * question instead of an option. Pure functions; no mocks.
 */

import { describe, expect, test } from 'bun:test';
import { auqFormComplete, auqFormSelections } from '../../src/lib/auq-form';
import type { UIQuestionStep } from '../../src/types';

const opt = (label: string, i: number) => ({
  label,
  value: String(i + 1),
  isRecommended: i === 0,
  isYes: false,
  isNo: false,
});
const COLOR: UIQuestionStep = {
  text: 'Which color?',
  multiSelect: false,
  options: ['Red', 'Green'].map(opt),
};
const FRUITS: UIQuestionStep = {
  text: 'Which fruits?',
  multiSelect: true,
  options: ['Apple', 'Banana', 'Cherry'].map(opt),
};
const STEPS = [COLOR, FRUITS];

const picks = (entries: Array<[number, number[]]>) =>
  new Map(entries.map(([qi, indices]) => [qi, new Set(indices)]));
const texts = (entries: Array<[number, string]>) => new Map(entries);

describe('auqFormComplete', () => {
  test('every question answered: one pick (or text) per single-select, at least one per multi-select', () => {
    expect(auqFormComplete(STEPS, picks([[0, [1]], [1, [0, 2]]]), texts([]))).toBe(true);
    expect(auqFormComplete(STEPS, picks([[1, [0]]]), texts([[0, 'Teal']]))).toBe(true);
  });

  test('a question left unanswered is incomplete', () => {
    expect(auqFormComplete(STEPS, picks([[0, [1]]]), texts([]))).toBe(false);
    expect(auqFormComplete(STEPS, picks([[0, [1]], [1, []]]), texts([]))).toBe(false);
    expect(auqFormComplete(STEPS, picks([[1, [0]]]), texts([[0, '   ']]))).toBe(false);
  });

  test('a pick and text together on a single-select is not one answer', () => {
    expect(auqFormComplete(STEPS, picks([[0, [1]], [1, [0]]]), texts([[0, 'Teal']]))).toBe(false);
  });

  test('text on a multi-select does not count; its picks do', () => {
    expect(auqFormComplete(STEPS, picks([[0, [0]]]), texts([[1, 'Mango']]))).toBe(false);
  });
});

describe('auqFormSelections', () => {
  test('picks in ascending order, text in place of an option', () => {
    expect(auqFormSelections(STEPS, picks([[1, [2, 0]]]), texts([[0, '  Teal  ']]))).toEqual([
      { questionIndex: 0, optionIndices: [], text: 'Teal' },
      { questionIndex: 1, optionIndices: [0, 2] },
    ]);
  });

  test('text typed for a multi-select is never sent', () => {
    expect(
      auqFormSelections(STEPS, picks([[0, [1]], [1, [1]]]), texts([[1, 'Mango']])),
    ).toEqual([
      { questionIndex: 0, optionIndices: [1] },
      { questionIndex: 1, optionIndices: [1] },
    ]);
  });
});
