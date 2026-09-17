import { describe, expect, test } from 'bun:test';
import {
  OPERATION_EFFECT_REGISTRY,
  capabilityForProofLeaf,
  githubSubIssueActionEffect,
  isNeutralProofLeaf,
} from '../../src/auto-approve/operation-effects.ts';

describe('Phase 2 operation-effect registry (#1094)', () => {
  test('keeps capability families tied to their effects and groups', () => {
    expect(OPERATION_EFFECT_REGISTRY.local_read).toEqual({
      family: 'local_read',
      effects: ['filesystem_read'],
      approvalGroup: 'read-only',
    });
    expect(OPERATION_EFFECT_REGISTRY.bounded_interpreter_read).toEqual({
      family: 'bounded_interpreter_read',
      effects: ['filesystem_read', 'process_execution'],
      approvalGroup: 'read-only',
    });
    expect(OPERATION_EFFECT_REGISTRY.remote_mutation.approvalGroup).toBeNull();
  });

  test('maps all supported proof leaves through one registry', () => {
    for (const leaf of ['cat', 'find', 'awk:print-field', 'python:lock-inspection']) {
      expect(capabilityForProofLeaf(leaf)).not.toBeNull();
    }
    expect(capabilityForProofLeaf('git:status')?.approvalGroup).toBe('vcs-read');
    expect(capabilityForProofLeaf('gh:issue-list')?.approvalGroup).toBe('vcs-read');
    expect(capabilityForProofLeaf('gh:sub-issue-list')?.approvalGroup).toBe('gh-read');
    expect(capabilityForProofLeaf('future:unknown')).toBeNull();
  });

  test('treats only known sub-issue listing as read', () => {
    expect(githubSubIssueActionEffect('list')).toBe('read');
    for (const action of ['add', 'remove', 'reprioritize']) {
      expect(githubSubIssueActionEffect(action)).toBe('remote_mutation');
    }
    expect(githubSubIssueActionEffect('archive')).toBe('unknown');
    expect(githubSubIssueActionEffect(undefined)).toBe('unknown');
  });

  test('does not turn neutral shell bookkeeping into a capability', () => {
    expect(isNeutralProofLeaf('echo')).toBe(true);
    expect(isNeutralProofLeaf('printf')).toBe(true);
    expect(isNeutralProofLeaf('cat')).toBe(false);
  });
});
