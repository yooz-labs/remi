import { describe, expect, test } from 'bun:test';
import { buildAuthorityGradePrompt } from '../../src/auto-approve/authority-grade.ts';
import {
  buildShadowReviewPrompt,
  formatShadowReviewOperation,
  parseShadowRiskReview,
} from '../../src/auto-approve/risk-review.ts';

describe('phase 2 shadow risk/authorization review', () => {
  test('uses the measured authorization prompt verbatim', () => {
    const authority = 'Please inspect the repository.';
    const operation = 'Bash: git status';
    expect(buildShadowReviewPrompt(authority, operation)).toBe(
      buildAuthorityGradePrompt(authority, operation),
    );
  });

  test('does not drop non-Bash operation payloads from the grader', () => {
    expect(
      formatShadowReviewOperation('Write', {
        file_path: '/tmp/report.txt',
        content: 'the complete payload matters',
      }),
    ).toContain('the complete payload matters');
    expect(formatShadowReviewOperation('Bash', { command: 'git status' })).toBe('git status');
  });

  test('bounds long Bash operations to the same 2,000-character input budget', () => {
    const formatted = formatShadowReviewOperation('Bash', { command: 'x'.repeat(2100) });
    expect(formatted).toHaveLength(2000);
    expect(formatted.endsWith('...')).toBe(true);
  });

  test('parses a one-word grade and attaches the deterministic risk band', () => {
    expect(parseShadowRiskReview('moderate', ' implicit\n')).toEqual({
      riskBand: 'moderate',
      observedAuthorization: 'implicit',
      authorization: 'implicit',
      matrixDecision: 'approve',
    });
  });

  test('accepts the narrow JSON compatibility shape used by JSON-forcing transports', () => {
    expect(parseShadowRiskReview('moderate', '{"authorization":"topical"}')).toEqual({
      riskBand: 'moderate',
      observedAuthorization: 'topical',
      authorization: 'topical',
      matrixDecision: 'escalate',
    });
  });

  test('caps model text at implicit and never mints a high-risk approval', () => {
    expect(parseShadowRiskReview('high', 'explicit')).toEqual({
      riskBand: 'high',
      observedAuthorization: 'explicit',
      authorization: 'implicit',
      matrixDecision: 'escalate',
    });
    expect(parseShadowRiskReview('high', 'scoped')?.matrixDecision).toBe('escalate');
  });

  test('critical risk remains escalated at every observed grade', () => {
    expect(parseShadowRiskReview('critical', 'explicit')).toEqual({
      riskBand: 'critical',
      observedAuthorization: 'explicit',
      authorization: 'implicit',
      matrixDecision: 'escalate',
    });
  });

  test('rejects malformed, unknown, and decision-shaped output', () => {
    expect(parseShadowRiskReview('moderate', '')).toBeNull();
    expect(parseShadowRiskReview('moderate', 'I would approve this')).toBeNull();
    expect(parseShadowRiskReview('moderate', '{"decision":"approve"}')).toBeNull();
    expect(parseShadowRiskReview('moderate', '{"authorization":"maybe"}')).toBeNull();
  });
});
