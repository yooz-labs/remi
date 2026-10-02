/**
 * The AskUserQuestion form's answer (#1127): Submit is enabled exactly when
 * the daemon would accept the answer, and free text answers a single-select
 * question instead of an option. Pure functions; no mocks.
 */

import { describe, expect, test } from 'bun:test';
import {
  AUQ_FREE_TEXT_MAX,
  EMPTY_AUQ_FORM,
  auqFormComplete,
  auqFormSelections,
  pickAuqOption,
  typeAuqText,
} from '../../src/lib/auq-form';
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

  test('text longer than the daemon accepts is incomplete (#1127 review S3)', () => {
    expect(AUQ_FREE_TEXT_MAX).toBe(2000);
    const ok = texts([[0, 'x'.repeat(AUQ_FREE_TEXT_MAX)]]);
    const tooLong = texts([[0, 'x'.repeat(AUQ_FREE_TEXT_MAX + 1)]]);
    expect(auqFormComplete(STEPS, picks([[1, [0]]]), ok)).toBe(true);
    expect(auqFormComplete(STEPS, picks([[1, [0]]]), tooLong)).toBe(false);
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

describe('pickAuqOption and typeAuqText (#1127 review T2)', () => {
  test('a single-select pick replaces the previous pick and clears typed text', () => {
    let form = typeAuqText(EMPTY_AUQ_FORM, 0, 'Teal');
    form = pickAuqOption(form, 0, 1, false);
    expect([...(form.selected.get(0) ?? [])]).toEqual([1]);
    expect(form.typed.has(0)).toBe(false);
    form = pickAuqOption(form, 0, 0, false);
    expect([...(form.selected.get(0) ?? [])]).toEqual([0]);
  });

  test('typed text clears a single-select pick; blank text does not', () => {
    let form = pickAuqOption(EMPTY_AUQ_FORM, 0, 1, false);
    form = typeAuqText(form, 0, '   ');
    expect([...(form.selected.get(0) ?? [])]).toEqual([1]);
    form = typeAuqText(form, 0, 'Teal');
    expect(form.selected.has(0)).toBe(false);
    expect(form.typed.get(0)).toBe('Teal');
  });

  test('a multi-select toggles its picks and leaves other questions alone', () => {
    let form = typeAuqText(EMPTY_AUQ_FORM, 0, 'Teal');
    form = pickAuqOption(form, 1, 0, true);
    form = pickAuqOption(form, 1, 2, true);
    form = pickAuqOption(form, 1, 0, true);
    expect([...(form.selected.get(1) ?? [])]).toEqual([2]);
    expect(form.typed.get(0)).toBe('Teal');
  });

  test('the form never holds a pick and text together for a single-select question', () => {
    let form = EMPTY_AUQ_FORM;
    const moves: Array<(f: typeof form) => typeof form> = [
      (f) => pickAuqOption(f, 0, 0, false),
      (f) => typeAuqText(f, 0, 'x'),
      (f) => pickAuqOption(f, 0, 2, false),
      (f) => typeAuqText(f, 0, ''),
      (f) => typeAuqText(f, 0, 'y'),
    ];
    for (const move of moves) {
      form = move(form);
      const picks = form.selected.get(0)?.size ?? 0;
      const text = (form.typed.get(0) ?? '').trim();
      expect(picks > 0 && text.length > 0).toBe(false);
    }
  });
});
