/**
 * Pure reconciliation helpers for the opt-in verified dual-review path.
 *
 * A model may describe an operation, but it cannot widen the deterministic
 * capability that selected the path. These helpers turn the proof/grant facts
 * into a small effect contract and require every model assessment to fit that
 * contract before the caller can approve anything. They contain no provider,
 * session, or authorization state and therefore cannot become a second policy
 * engine.
 */

import type { Intent, IntentAssessment, IntentEffect, IntentScope } from './intent-assessment.ts';
import { capabilityForProofLeaf, isNeutralProofLeaf } from './operation-effects.ts';
import type { ReadOnlyProofLeaf } from './read-only-proof.ts';

/** The confidence floor for either model in verified mode. */
export const VERIFIED_ASSESSMENT_CONFIDENCE_FLOOR = 0.85;

export interface VerifiedEffectContract {
  readonly effects: readonly IntentEffect[];
  readonly intents: readonly Intent[];
  readonly scopes: readonly IntentScope[];
}

/**
 * Build the minimal effect contract for a successful finite read proof.
 *
 * The capability registry intentionally has some family-level upper bounds
 * (for example, all Git reads share the `vcs-read` group). The verified
 * contract is more precise for the dual review: only the concrete proof leaves
 * that can contact GitHub are remote reads, and only the two bounded
 * interpreter leaves carry process execution. A registry miss is never
 * silently converted into a safe contract.
 */
export function verifiedReadEffectContract(
  leaves: readonly ReadOnlyProofLeaf[],
): VerifiedEffectContract | null {
  let hasCapability = false;
  let hasFilesystemRead = false;
  let hasRemoteRead = false;
  let hasBoundedInterpreter = false;

  for (const leaf of leaves) {
    if (isNeutralProofLeaf(leaf.name)) continue;
    const profile = capabilityForProofLeaf(leaf.name);
    if (profile === null || profile.approvalGroup === null) return null;
    hasCapability = true;
    if (profile.family === 'local_read' || profile.family === 'bounded_interpreter_read') {
      hasFilesystemRead = true;
    }
    // Git's registry profile is intentionally a family-level upper bound.
    // Only the concrete ls-remote proof leaf has a network effect; ordinary
    // Git reads remain local filesystem reads in the verified contract.
    if (profile.family === 'vcs_read' && leaf.name !== 'git:ls-remote-heads') {
      hasFilesystemRead = true;
    }
    if (profile.family === 'github_issue_read' || profile.family === 'github_read') {
      hasRemoteRead = true;
    }
    if (leaf.name === 'git:ls-remote-heads') hasRemoteRead = true;
    if (profile.family === 'bounded_interpreter_read') hasBoundedInterpreter = true;
  }

  if (!hasCapability) return null;

  const effects = new Set<IntentEffect>();
  if (hasFilesystemRead) effects.add('filesystem_read');
  if (hasRemoteRead) {
    effects.add('network_read');
    effects.add('remote_read');
  }
  if (hasBoundedInterpreter) effects.add('process_execution');
  if (effects.size === 0) return null;

  return makeVerifiedEffectContract(
    [...effects],
    hasRemoteRead
      ? ['remote_read']
      : hasBoundedInterpreter
        ? ['local_read', 'interpreter']
        : ['local_read'],
    hasRemoteRead ? ['remote_repository'] : ['scratch', 'repository'],
  );
}

/** Create a contract for a non-read family whose effect facts are deterministic. */
export function makeVerifiedEffectContract(
  effects: readonly IntentEffect[],
  intents: readonly Intent[],
  scopes: readonly IntentScope[],
): VerifiedEffectContract {
  return {
    effects: [...effects],
    intents: [...intents],
    scopes: [...scopes],
  };
}

export type EffectAssessmentLike = Pick<
  IntentAssessment,
  'intent' | 'effects' | 'scope' | 'reversible' | 'confidence'
>;

/** True only when an assessment exactly fits the deterministic effect contract. */
export function assessmentMatchesVerifiedEffectContract(
  assessment: EffectAssessmentLike,
  contract: VerifiedEffectContract,
): boolean {
  return (
    contract.intents.includes(assessment.intent) &&
    contract.scopes.includes(assessment.scope) &&
    assessment.reversible &&
    assessment.confidence >= VERIFIED_ASSESSMENT_CONFIDENCE_FLOOR &&
    exactEffectSet(assessment.effects, contract.effects)
  );
}

/** Require the two model reports to agree on every safety-relevant field. */
export function verifiedAssessmentsAgree(
  primary: EffectAssessmentLike,
  independent: EffectAssessmentLike,
): boolean {
  return (
    primary.intent === independent.intent &&
    primary.scope === independent.scope &&
    primary.reversible === independent.reversible &&
    exactEffectSet(primary.effects, independent.effects)
  );
}

function exactEffectSet(
  actual: readonly IntentEffect[],
  expected: readonly IntentEffect[],
): boolean {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length) return false;
  return expected.every((effect) => actual.includes(effect));
}
