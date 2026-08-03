/**
 * The authorization axis of epic #976's risk x authorization matrix, made
 * structural.
 *
 * ADR 0015's amendment states the rule this module exists to enforce:
 * **authorization can never be established by text alone.** Conversation text
 * buys at most `implicit`; `explicit` comes only from a channel where a human
 * acted — an answer to a card remi presented, or a code-verified session
 * precedent derived from one.
 *
 * That rule was previously a convention: `capGradeForTextProvenance` existed and
 * callers were expected to remember it. This module removes the remembering. An
 * `AuthorizationAssessment` cannot be constructed except through a factory, and
 * the text factory caps INSIDE itself, so a text-derived assessment above
 * `implicit` is unrepresentable rather than merely rejected.
 *
 * The private member is what makes that hold. TypeScript's type system is
 * structural, so a plain interface with the same fields could be forged by any
 * object literal; a class with a private field is NOMINAL, and no literal
 * satisfies it.
 *
 * Nothing here calls a model, reads config, or touches I/O — it is a pure
 * decision function, so it can be tested exhaustively without an engine.
 *
 * **The guarantee is compile-time only, and does not survive an `any`
 * boundary.** `Object.create(AuthorizationAssessment.prototype)` and
 * `JSON.parse(...)` both return `any`, so either can produce a value that
 * satisfies this type with no diagnostic, no cast and no suppression comment —
 * verified in review, `instanceof` even reports true for the first. That is a
 * TypeScript limitation, not a hole to patch here: `matrixDecision` performs no
 * runtime validation, deliberately, because a brand check would be trivially
 * satisfiable by the same forgery.
 *
 * What it means for whoever wires this in: an assessment must never cross a
 * serialization boundary. Do not persist one, send one over IPC, or rebuild one
 * from a log or replay — derive it fresh, at the decision point, from a
 * `PrecedentMatch` or a graded string. If a future design needs to carry
 * authorization across such a boundary, carry the EVIDENCE (the precedent
 * record) and re-derive, never the conclusion.
 */

import {
  type AuthorizationGrade,
  capGradeForTextProvenance,
  gradeRank,
} from './authority-grade.ts';
import type { PrecedentMatch } from './precedent.ts';
import type { RiskBand } from './risk-bands.ts';

/**
 * How an assessment came to be. Present ONLY when a human acted through a
 * non-text channel; `null` for anything derived from conversation text.
 *
 * `config` and `card-answer` are deliberately absent. A `config.toml` allow
 * approves at 0ms before the matrix is consulted at all, and a live card answer
 * resolves its own hook through `resolveHeld` rather than arriving here. Neither
 * can reach this decision, so modelling them would be inventing channels to
 * reason about.
 *
 * `scoped` is likewise unbuilt: no channel can currently mint it, and machinery
 * for a grade nothing produces is machinery nobody can test.
 */
export type AuthorizationWitness = { readonly kind: 'precedent'; readonly matchedAt: number };

/** What the matrix is allowed to conclude. Never `deny` — see `matrixDecision`. */
export type MatrixDecision = 'approve' | 'escalate';

export class AuthorizationAssessment {
  /**
   * Nominal-typing marker. Its presence is the reason an assessment cannot be
   * forged by an object literal, which is the whole enforcement mechanism —
   * do not remove it, and do not add a public constructor.
   */
  private readonly brand = 'authorization-assessment';

  private constructor(
    readonly grade: AuthorizationGrade,
    readonly witness: AuthorizationWitness | null,
  ) {
    void this.brand;
  }

  /**
   * An assessment derived from conversation text — the graded ladder's output.
   *
   * Caps through `capGradeForTextProvenance` here, inside the factory, so the
   * ceiling is a property of construction rather than of every call site. A
   * caller cannot opt out, forget, or be refactored around it.
   */
  static fromText(grade: AuthorizationGrade): AuthorizationAssessment {
    return new AuthorizationAssessment(capGradeForTextProvenance(grade), null);
  }

  /**
   * An assessment backed by a session precedent: the user answered this exact
   * operation earlier, through a card.
   *
   * The only mint for `explicit`, and it takes a `PrecedentMatch` — a value only
   * `PrecedentStore.matchApproved` produces — so the witness cannot be
   * fabricated by a caller that merely believes it has authorization.
   */
  static fromPrecedent(match: PrecedentMatch): AuthorizationAssessment {
    // Only an EXACT APPROVAL authorizes. Both halves matter and neither is
    // hypothetical: `PrecedentMatch` also describes DENIAL matches, and those
    // are deliberately `substring` (ADR 0010 — deny matching is broad). A broad
    // match is the right shape for refusing and exactly the wrong shape for
    // authorizing, so a denial record, or an approval that only matched loosely,
    // yields no authorization at all rather than a downgraded one.
    if (match.decision !== 'approved' || match.matchKind !== 'exact') {
      return AuthorizationAssessment.none();
    }
    return new AuthorizationAssessment('explicit', {
      kind: 'precedent',
      matchedAt: match.recordedAt,
    });
  }

  /** No authorization at all — the honest default when nothing is known. */
  static none(): AuthorizationAssessment {
    return new AuthorizationAssessment('none', null);
  }
}

/**
 * The matrix itself: may `band` be approved on the strength of `assessment`?
 *
 * | band | approves on |
 * |---|---|
 * | `critical` | never, at any grade |
 * | `high` | a non-text witness AND `explicit` |
 * | `moderate` | `implicit` |
 * | `low` | never reaches here — a group covered it at 0ms |
 *
 * `high` checks the witness AND the rank, which is deliberate redundancy: a
 * future factory bug that let text reach `explicit` would still fail closed,
 * because text carries no witness. Both conditions must break for the ceiling
 * to break.
 *
 * Returns only approve/escalate. Denial belongs to the deny floor, which runs
 * earlier and answers a different question — this function's job is whether the
 * user must be asked, never whether the operation is forbidden.
 */
export function matrixDecision(
  band: RiskBand,
  assessment: AuthorizationAssessment,
): MatrixDecision {
  if (band === 'critical') return 'escalate';
  if (band === 'high') {
    return assessment.witness !== null && gradeRank(assessment.grade) >= gradeRank('explicit')
      ? 'approve'
      : 'escalate';
  }
  if (band === 'moderate') {
    return gradeRank(assessment.grade) >= gradeRank('implicit') ? 'approve' : 'escalate';
  }
  // `low` is unreachable in production (`classifyRisk` cannot return it), but
  // returning `approve` here would make a future `low` silently approvable on
  // no authorization at all. Escalating is the honest answer for a band this
  // function was never given a rule for.
  return 'escalate';
}
