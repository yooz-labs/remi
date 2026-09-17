import { describe, expect, test } from 'bun:test';
import {
  assessmentMatchesVerifiedEffectContract,
  makeVerifiedEffectContract,
  verifiedAssessmentsAgree,
  verifiedReadEffectContract,
} from '../../src/auto-approve/verified-dual-review.ts';

describe('verified dual-review reconciliation (#1096)', () => {
  test('derives a local Git read contract without inheriting remote family effects', () => {
    expect(verifiedReadEffectContract([{ name: 'git:status' }])).toEqual({
      effects: ['filesystem_read'],
      intents: ['local_read'],
      scopes: ['scratch', 'repository'],
    });
  });

  test('derives remote and bounded-interpreter effects from concrete proof leaves', () => {
    expect(verifiedReadEffectContract([{ name: 'git:ls-remote-heads' }])).toEqual({
      effects: ['network_read', 'remote_read'],
      intents: ['remote_read'],
      scopes: ['remote_repository'],
    });
    expect(verifiedReadEffectContract([{ name: 'awk:print-field' }])).toEqual({
      effects: ['filesystem_read', 'process_execution'],
      intents: ['local_read', 'interpreter'],
      scopes: ['scratch', 'repository'],
    });
  });

  test('rejects an unregistered or capability-free proof contract', () => {
    expect(verifiedReadEffectContract([{ name: 'future:unknown-leaf' }])).toBeNull();
    expect(verifiedReadEffectContract([{ name: 'echo' }])).toBeNull();
  });

  test('requires exact effects, approved scope, reversibility, and confidence floor', () => {
    const contract = makeVerifiedEffectContract(
      ['filesystem_read'],
      ['local_read'],
      ['repository'],
    );
    const assessment = {
      intent: 'local_read',
      effects: ['filesystem_read'],
      scope: 'repository',
      reversible: true,
      confidence: 0.85,
    } as const;
    expect(assessmentMatchesVerifiedEffectContract(assessment, contract)).toBe(true);
    expect(
      assessmentMatchesVerifiedEffectContract({ ...assessment, confidence: 0.849 }, contract),
    ).toBe(false);
    expect(
      assessmentMatchesVerifiedEffectContract(
        { ...assessment, effects: ['filesystem_read', 'network_read'] },
        contract,
      ),
    ).toBe(false);
    expect(
      assessmentMatchesVerifiedEffectContract({ ...assessment, reversible: false }, contract),
    ).toBe(false);
  });

  test('requires both model reports to agree on safety-relevant fields', () => {
    const first = {
      intent: 'local_read',
      effects: ['filesystem_read'],
      scope: 'repository',
      reversible: true,
      confidence: 0.9,
    } as const;
    expect(verifiedAssessmentsAgree(first, { ...first, confidence: 0.86 })).toBe(true);
    expect(verifiedAssessmentsAgree(first, { ...first, scope: 'scratch' })).toBe(false);
    expect(verifiedAssessmentsAgree(first, { ...first, effects: ['process_execution'] })).toBe(
      false,
    );
    expect(verifiedAssessmentsAgree(first, { ...first, reversible: false })).toBe(false);
  });
});
