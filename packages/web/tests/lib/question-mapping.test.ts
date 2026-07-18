/**
 * Tests for the wire Question -> UIQuestion mapping (#718 review).
 * Pure function; no mocks.
 */

import { describe, expect, test } from 'bun:test';
import type { Question, QuestionOption, UUID } from '@remi/shared';
import { mapQuestionToUIQuestion } from '../../src/lib/question-mapping';

const SID = 'session-1' as UUID;

function opt(label: string, extras: Partial<QuestionOption> = {}): QuestionOption {
  return {
    label,
    value: label,
    isRecommended: false,
    isYes: false,
    isNo: false,
    ...extras,
  };
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1' as UUID,
    text: 'Allow Bash: ls',
    options: [],
    allowsFreeText: false,
    isAnswered: false,
    ...overrides,
  };
}

describe('mapQuestionToUIQuestion', () => {
  test('maps id, sessionId, prompt, options, and structuredOptions', () => {
    const q = question({
      options: [opt('Yes', { isYes: true, isRecommended: true }), opt('No', { isNo: true })],
    });
    const ui = mapQuestionToUIQuestion(q, SID);

    expect(ui.id).toBe(q.id);
    expect(ui.sessionId).toBe(SID);
    expect(ui.prompt).toBe('Allow Bash: ls');
    expect(ui.options).toEqual(['Yes', 'No']);
    expect(ui.structuredOptions).toEqual([
      { label: 'Yes', value: 'Yes', isYes: true, isNo: undefined, isRecommended: true, description: undefined },
      // isRecommended: false collapses to undefined (pre-existing `||`
      // pattern, unchanged by this extraction).
      { label: 'No', value: 'No', isYes: undefined, isNo: true, isRecommended: undefined, description: undefined },
    ]);
  });

  test('carries agentId through (undefined for main)', () => {
    expect(mapQuestionToUIQuestion(question(), SID).agentId).toBeUndefined();
    expect(mapQuestionToUIQuestion(question({ agentId: 'agent-1' }), SID).agentId).toBe('agent-1');
  });

  describe('question type classification', () => {
    test('no options -> free_text', () => {
      expect(mapQuestionToUIQuestion(question({ options: [] }), SID).type).toBe('free_text');
    });

    test('exactly 2 options with yes+no -> yes_no', () => {
      const q = question({ options: [opt('Yes', { isYes: true }), opt('No', { isNo: true })] });
      expect(mapQuestionToUIQuestion(q, SID).type).toBe('yes_no');
    });

    test('exactly 2 options without both yes+no -> multi_option', () => {
      const q = question({ options: [opt('Continue'), opt('Stop')] });
      expect(mapQuestionToUIQuestion(q, SID).type).toBe('multi_option');
    });

    test('3+ options with yes/no semantics -> multi_option', () => {
      const q = question({
        options: [opt('Yes', { isYes: true }), opt('Yes, always', { isYes: true }), opt('No', { isNo: true })],
      });
      expect(mapQuestionToUIQuestion(q, SID).type).toBe('multi_option');
    });

    test('3+ options with no yes/no semantics -> numbered', () => {
      const q = question({ options: [opt('dev'), opt('staging'), opt('prod')] });
      expect(mapQuestionToUIQuestion(q, SID).type).toBe('numbered');
    });
  });

  describe('optionsAreFallback (#718 review — critical)', () => {
    test('true is carried through', () => {
      const q = question({ optionsAreFallback: true });
      expect(mapQuestionToUIQuestion(q, SID).optionsAreFallback).toBe(true);
    });

    test('explicit false is carried through, NOT collapsed to undefined', () => {
      // The bug: `q.optionsAreFallback ? {...} : {}` drops an explicit
      // `false` (set by question-parser.ts's tryParseYesNo on a genuine
      // parsed y/n prompt), making it indistinguishable from "no signal" —
      // which the question-merge guard treats as "fall back to label
      // matching", misclassifying a real Yes/No prompt as the bland default.
      const q = question({
        options: [opt('Yes', { isYes: true }), opt('No', { isNo: true })],
        optionsAreFallback: false,
      });
      const ui = mapQuestionToUIQuestion(q, SID);
      expect(ui.optionsAreFallback).toBe(false);
      expect('optionsAreFallback' in ui).toBe(true);
    });

    test('absent (undefined) on the wire question stays absent on the UI question', () => {
      const ui = mapQuestionToUIQuestion(question(), SID);
      expect(ui.optionsAreFallback).toBeUndefined();
      expect('optionsAreFallback' in ui).toBe(false);
    });
  });

  test('threads kind/questions/submitLabel for a multi_question (AskUserQuestion)', () => {
    const q = question({
      kind: 'multi_question',
      submitLabel: 'Submit',
      questions: [
        {
          header: 'Collab PI',
          text: 'Who is the PI?',
          multiSelect: false,
          options: [opt('Scott', { description: 'EEGLAB founder' })],
        },
      ],
    });
    const ui = mapQuestionToUIQuestion(q, SID);

    expect(ui.kind).toBe('multi_question');
    expect(ui.submitLabel).toBe('Submit');
    expect(ui.questions).toHaveLength(1);
    expect(ui.questions?.[0]?.header).toBe('Collab PI');
    expect(ui.questions?.[0]?.options[0]?.description).toBe('EEGLAB founder');
  });

  test('omits kind/questions/submitLabel when absent', () => {
    const ui = mapQuestionToUIQuestion(question(), SID);
    expect(ui.kind).toBeUndefined();
    expect(ui.questions).toBeUndefined();
    expect(ui.submitLabel).toBeUndefined();
  });

  describe('timestamp (#798 part 4)', () => {
    test('prefers the wire message timestamp over local receipt time', () => {
      const wireTs = '2026-01-01T00:00:00.000Z';
      const ui = mapQuestionToUIQuestion(question(), SID, wireTs);
      expect(ui.timestamp).toBe(wireTs);
    });

    test('falls back to the current time when no wire timestamp is given', () => {
      const before = Date.now();
      const ui = mapQuestionToUIQuestion(question(), SID);
      const after = Date.now();
      const parsed = Date.parse(ui.timestamp);
      expect(parsed).toBeGreaterThanOrEqual(before);
      expect(parsed).toBeLessThanOrEqual(after);
    });

    test('falls back to the current time for a malformed wire timestamp', () => {
      const before = Date.now();
      const ui = mapQuestionToUIQuestion(question(), SID, 'not-a-date');
      const after = Date.now();
      const parsed = Date.parse(ui.timestamp);
      expect(parsed).toBeGreaterThanOrEqual(before);
      expect(parsed).toBeLessThanOrEqual(after);
    });
  });
});
