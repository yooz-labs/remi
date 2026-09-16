/**
 * Advisory risk/authorization review for phase 2 of epic #1081.
 *
 * This module deliberately does NOT decide whether an operation runs. The
 * operation risk band comes from the deterministic classifier, and the model
 * is asked only to grade the user's conversation text against the measured
 * authorization ladder. The caller records the result as shadow telemetry;
 * the existing deny floor, risk ceiling, counterfactual, precedent and
 * deterministic policy paths remain authoritative.
 *
 * Keeping the two axes separate is important. The #954 measurement showed
 * that asking the model to decide and interpret authority in one response lets
 * topical mention move a verdict. The #976 grading sweep measured the
 * authorization question as a separate task. This module wires that measured
 * question into an opt-in, behavior-preserving review path.
 */

import {
  type AuthorizationGrade,
  buildAuthorityGradePrompt,
  parseAuthorizationGrade,
} from './authority-grade.ts';
import { AuthorizationAssessment, matrixDecision } from './authorization-assessment.ts';
import type { MatrixDecision } from './authorization-assessment.ts';
import { extractJsonObject } from './json-extract.ts';
import type { RiskBand } from './risk-bands.ts';

export type { RiskReviewMode } from './types.ts';

const MAX_REVIEW_OPERATION_CHARS = 2000;

/**
 * The parsed shadow result. `observedAuthorization` is what the model said;
 * `authorization` is the text-provenance-capped grade that the matrix is
 * allowed to see. Keeping both makes over-grading measurable without letting
 * a model response mint explicit/scoped authorization.
 */
export interface ShadowRiskReview {
  readonly riskBand: RiskBand;
  readonly observedAuthorization: AuthorizationGrade;
  readonly authorization: AuthorizationGrade;
  readonly matrixDecision: MatrixDecision;
}

/**
 * Render the complete operation for the grader. `signatureForOperation` is
 * intentionally incomplete for most tools because it is an authorization key
 * allowlist; using it here would hide Write/Edit payloads and read extents
 * from the reviewer. Bash keeps the measured sweep's raw command shape, while
 * other tools include their full JSON input (bounded like the primary prompt).
 */
export function formatShadowReviewOperation(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  if (toolName === 'Bash' && typeof toolInput['command'] === 'string') {
    const command = toolInput['command'];
    return command.length > MAX_REVIEW_OPERATION_CHARS
      ? `${command.slice(0, MAX_REVIEW_OPERATION_CHARS - 3)}...`
      : command;
  }
  let input = '{}';
  try {
    input = JSON.stringify(toolInput, null, 2);
  } catch {
    input = '[unserializable tool input]';
  }
  const truncated =
    input.length > MAX_REVIEW_OPERATION_CHARS
      ? `${input.slice(0, MAX_REVIEW_OPERATION_CHARS - 3)}...`
      : input;
  return `Tool: ${toolName}\nInput: ${truncated}`;
}

/**
 * Build the exact authorization prompt used by the measured #976 sweep.
 * Keeping this tiny wrapper at the production boundary makes it difficult for
 * the service and the sweep to drift onto different wording.
 */
export function buildShadowReviewPrompt(authority: string | undefined, operation: string): string {
  return buildAuthorityGradePrompt(authority ?? '', operation);
}

/**
 * Parse one shadow authorization response and attach the deterministic risk
 * axis. The normal response is the measured one-word grade. OpenAI-compatible
 * transports may still return a JSON object despite the prompt, so a narrow
 * `{grade: ...}` / `{authorization: ...}` compatibility shape is accepted;
 * arbitrary text and decision-shaped JSON remain invalid.
 *
 * Invalid output returns null. It never gets coerced to `none`, because a
 * caller needs to distinguish a genuine conservative grade from an unavailable
 * reviewer when measuring the path.
 */
export function parseShadowRiskReview(riskBand: RiskBand, raw: string): ShadowRiskReview | null {
  const observed = parseAuthorizationGrade(raw) ?? parseGradeObject(raw);
  if (observed === null) return null;

  // `fromText` is the provenance boundary. Do not replace this with the raw
  // grade or construct an assessment from a plain object: explicit/scoped
  // model text must collapse to implicit before matrixDecision sees it.
  const assessment = AuthorizationAssessment.fromText(observed);
  return {
    riskBand,
    observedAuthorization: observed,
    authorization: assessment.grade,
    matrixDecision: matrixDecision(riskBand, assessment),
  };
}

function parseGradeObject(raw: string): AuthorizationGrade | null {
  const parsed = extractJsonObject(raw);
  if (parsed === null) return null;
  const candidate = parsed['authorization'] ?? parsed['grade'];
  return typeof candidate === 'string' ? parseAuthorizationGrade(candidate) : null;
}
