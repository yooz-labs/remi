/**
 * Tests for the pending-question label builder (#786/#787): pure function,
 * no fs/network involved.
 */

import { describe, expect, test } from 'bun:test';
import type { Question } from '@remi/shared';
import {
  PENDING_QUESTION_LABEL_MAX,
  buildPendingQuestionLabel,
} from '../../src/session/pending-question-label.ts';

function mkQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    text: 'Allow this action?',
    options: [],
    allowsFreeText: false,
    isAnswered: false,
    ...overrides,
  };
}

describe('buildPendingQuestionLabel (#786/#787)', () => {
  test('a plain permission-request question becomes "Permission: <tool>"', () => {
    const q = mkQuestion({
      text: 'Allow Bash: git push origin main',
      source: 'permission_request',
    });
    expect(buildPendingQuestionLabel(q)).toBe('Permission: Bash');
  });

  test('a tool with no command summary still extracts cleanly', () => {
    const q = mkQuestion({ text: 'Allow Write', source: 'permission_request' });
    expect(buildPendingQuestionLabel(q)).toBe('Permission: Write');
  });

  test('a subagent-prefixed permission-request question extracts the tool, not the agent', () => {
    const q = mkQuestion({
      text: 'code-reviewer · Bash: git push origin main',
      source: 'permission_request',
    });
    expect(buildPendingQuestionLabel(q)).toBe('Permission: Bash');
  });

  test('a subagent-prefixed permission-request question with no command', () => {
    const q = mkQuestion({ text: 'code-reviewer · Bash', source: 'permission_request' });
    expect(buildPendingQuestionLabel(q)).toBe('Permission: Bash');
  });

  test('an AskUserQuestion/ExitPlanMode-style permission_request (already phrased as a question) falls back to text', () => {
    // toolQuestion branch of buildPermissionQuestion: no "Allow " prefix, no
    // agent separator either (main agent) -- extractPermissionToolName must
    // return null and NOT fabricate a "Permission: " label.
    const q = mkQuestion({
      text: 'Exit plan mode and start implementing?',
      source: 'permission_request',
    });
    expect(buildPendingQuestionLabel(q)).toBe('Exit plan mode and start implementing?');
  });

  test('a StopFailure question (no source) uses the text verbatim', () => {
    const q = mkQuestion({ text: 'Session stop failed (timeout). Retry?' });
    expect(buildPendingQuestionLabel(q)).toBe('Session stop failed (timeout). Retry?');
  });

  test('a PTY-fallback question (source pty) uses the text verbatim', () => {
    const q = mkQuestion({ text: 'Overwrite existing file?', source: 'pty' });
    expect(buildPendingQuestionLabel(q)).toBe('Overwrite existing file?');
  });

  test('a summary, when present, is preferred over text for non-permission questions', () => {
    const q = mkQuestion({
      text: 'Allow Bash: git push --force origin main',
      summary: 'Force-push to main?',
      source: 'pty',
    });
    expect(buildPendingQuestionLabel(q)).toBe('Force-push to main?');
  });

  test('a multi_question AskUserQuestion joins sub-question headers', () => {
    const q = mkQuestion({
      kind: 'multi_question',
      questions: [
        { header: 'Framework', text: 'Which framework?', multiSelect: false, options: [] },
        { header: 'Language', text: 'Which language?', multiSelect: false, options: [] },
      ],
    });
    expect(buildPendingQuestionLabel(q)).toBe('Framework, Language');
  });

  test('a multi_question sub-question with no header falls back to its text', () => {
    const q = mkQuestion({
      kind: 'multi_question',
      questions: [{ header: '', text: 'Pick an option', multiSelect: false, options: [] }],
    });
    expect(buildPendingQuestionLabel(q)).toBe('Pick an option');
  });

  test('long free text is truncated to PENDING_QUESTION_LABEL_MAX with an ellipsis', () => {
    const longText = `A${'b'.repeat(200)}?`;
    const q = mkQuestion({ text: longText, source: 'pty' });
    const label = buildPendingQuestionLabel(q);
    expect(label.length).toBe(PENDING_QUESTION_LABEL_MAX);
    expect(label.endsWith('…')).toBe(true);
  });

  test('whitespace runs (PTY column-aligned garble) collapse to single spaces', () => {
    const q = mkQuestion({ text: 'Do   you\n\nwant   to proceed?', source: 'pty' });
    expect(buildPendingQuestionLabel(q)).toBe('Do you want to proceed?');
  });
});
