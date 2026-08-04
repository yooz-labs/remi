/**
 * #976: the authorization axis, and specifically the claim that the provenance
 * ceiling is STRUCTURAL rather than conventional.
 *
 * The interesting tests here are the ones that assert something cannot be
 * built. ADR 0015's rule is that text alone never establishes `explicit`; the
 * point of this module is that a caller cannot get it wrong, so the tests have
 * to check the construction surface, not just the outputs.
 */
import { describe, expect, test } from 'bun:test';
import {
  AUTHORIZATION_GRADES,
  type AuthorizationGrade,
} from '../../src/auto-approve/authority-grade.ts';
import {
  AuthorizationAssessment,
  matrixDecision,
} from '../../src/auto-approve/authorization-assessment.ts';
import type { PrecedentMatch } from '../../src/auto-approve/precedent.ts';
import type { RiskBand } from '../../src/auto-approve/risk-bands.ts';

const APPROVED_PRECEDENT: PrecedentMatch = {
  decision: 'approved',
  matchedSignature: 'Bash: git push origin main',
  matchKind: 'exact',
  recordedAt: 1_700_000_000_000,
};

describe('#976 the provenance ceiling is a property of construction', () => {
  test('NO text grade, however high, produces an explicit assessment', () => {
    for (const grade of AUTHORIZATION_GRADES) {
      const assessment = AuthorizationAssessment.fromText(grade);
      // The cap happens inside the factory, so this holds for every input --
      // including a model that hallucinates `scoped`.
      expect(['none', 'topical', 'implicit']).toContain(assessment.grade);
      expect(assessment.witness).toBeNull();
    }
  });

  test('only a precedent mints explicit, and it carries a witness', () => {
    const assessment = AuthorizationAssessment.fromPrecedent(APPROVED_PRECEDENT);
    expect(assessment.grade).toBe('explicit');
    expect(assessment.witness).toEqual({
      kind: 'precedent',
      matchedAt: APPROVED_PRECEDENT.recordedAt,
    });
  });

  test('an assessment cannot be forged by an object literal (nominal typing)', () => {
    // The private brand is what makes the class nominal. Without it a literal
    // would satisfy the type structurally and the ceiling would be advisory.
    // @ts-expect-error -- a literal must NOT be assignable to the class type
    const forged: AuthorizationAssessment = { grade: 'explicit', witness: null };
    expect(forged.grade).toBe('explicit'); // it exists at runtime; the TYPE is the guard
  });

  test('the constructor is private -- factories are the only way in', () => {
    // @ts-expect-error -- `new` must not be reachable from outside the module
    const direct = new AuthorizationAssessment('explicit', null);
    expect(direct).toBeDefined();
  });
});

describe('#976 only an exact APPROVAL authorizes', () => {
  test('a denial record mints no authorization', () => {
    const denial: PrecedentMatch = {
      decision: 'denied',
      matchedSignature: 'Bash: git push',
      matchKind: 'substring',
      recordedAt: 1,
    };
    expect(AuthorizationAssessment.fromPrecedent(denial).grade).toBe('none');
    expect(AuthorizationAssessment.fromPrecedent(denial).witness).toBeNull();
  });

  test('a SUBSTRING approval mints no authorization', () => {
    // Denial matching is broad by design (ADR 0010). Broad is right for
    // refusing and exactly wrong for authorizing, so a loose approval match
    // must not become a witness.
    const loose: PrecedentMatch = {
      decision: 'approved',
      matchedSignature: 'Bash: git',
      matchKind: 'substring',
      recordedAt: 1,
    };
    expect(AuthorizationAssessment.fromPrecedent(loose).grade).toBe('none');
    expect(matrixDecision('high', AuthorizationAssessment.fromPrecedent(loose))).toBe('escalate');
  });
});

describe('#976 matrixDecision', () => {
  const cases: Array<[RiskBand, AuthorizationAssessment, 'approve' | 'escalate', string]> = [
    [
      'critical',
      AuthorizationAssessment.fromPrecedent(APPROVED_PRECEDENT),
      'escalate',
      'critical never approves, even on a human witness',
    ],
    [
      'critical',
      AuthorizationAssessment.fromText('implicit'),
      'escalate',
      'critical never approves on text',
    ],
    [
      'high',
      AuthorizationAssessment.fromPrecedent(APPROVED_PRECEDENT),
      'approve',
      'high approves on a witness',
    ],
    [
      'high',
      AuthorizationAssessment.fromText('implicit'),
      'escalate',
      'high refuses the best text can offer',
    ],
    ['high', AuthorizationAssessment.none(), 'escalate', 'high refuses nothing'],
    [
      'moderate',
      AuthorizationAssessment.fromText('implicit'),
      'approve',
      'moderate approves on implicit',
    ],
    [
      'moderate',
      AuthorizationAssessment.fromText('topical'),
      'escalate',
      'topical is below the bar',
    ],
    ['moderate', AuthorizationAssessment.none(), 'escalate', 'moderate refuses nothing'],
    [
      'low',
      AuthorizationAssessment.fromPrecedent(APPROVED_PRECEDENT),
      'escalate',
      'low has no rule, so it escalates',
    ],
  ];
  for (const [band, assessment, expected, why] of cases) {
    test(`${band} + ${assessment.grade} -> ${expected} (${why})`, () => {
      expect(matrixDecision(band, assessment)).toBe(expected);
    });
  }

  test("it never returns deny -- that is the deny floor's question, not this one", () => {
    for (const band of ['critical', 'high', 'moderate', 'low'] as RiskBand[]) {
      for (const g of AUTHORIZATION_GRADES) {
        expect(['approve', 'escalate']).toContain(
          matrixDecision(band, AuthorizationAssessment.fromText(g as AuthorizationGrade)),
        );
      }
    }
  });
});

describe('#976 the high-band redundancy is real, and now actually tested', () => {
  test('a witness-less explicit assessment still escalates at high', () => {
    // Review found this branch had ZERO coverage: every existing high-band case
    // goes through `fromText` (always witness=null AND capped below explicit,
    // so the rank check alone decides) or `fromPrecedent` (always explicit AND
    // witness-paired, so the rank check alone decides again). Removing the
    // witness check therefore turned 0 tests red, while the PR claimed 2 --
    // the redundancy was real by construction but unpinned by any test.
    //
    // Forging the impossible combination is the only way to isolate it. The
    // point of the redundancy is exactly this: if a future factory bug ever let
    // text reach `explicit`, the missing witness must still refuse.
    const forged = { grade: 'explicit', witness: null } as unknown as AuthorizationAssessment;
    expect(matrixDecision('high', forged)).toBe('escalate');
  });

  test('a witness alone, below explicit, also escalates at high', () => {
    // The other half of the AND: both conditions must hold, so neither alone
    // is sufficient.
    const forged = {
      grade: 'implicit',
      witness: { kind: 'precedent', matchedAt: 1 },
    } as unknown as AuthorizationAssessment;
    expect(matrixDecision('high', forged)).toBe('escalate');
  });
});

describe('#976 the measured failure it exists to block (#954)', () => {
  test('rm -rf ./build plus a casual topical mention stays escalated', () => {
    // #954: a topical mention flipped deny->approve 5/5 when the model decided
    // and graded at once. `rm` is `high`; text caps at `implicit`; high needs a
    // witness text cannot supply. Blocked on BOTH conditions, not one.
    const fromMention = AuthorizationAssessment.fromText('explicit'); // model over-grades
    expect(fromMention.grade).toBe('implicit'); // capped at construction
    expect(matrixDecision('high', fromMention)).toBe('escalate');
  });
});
