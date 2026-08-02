/**
 * Tests for the #976 prerequisite precedent module: a per-session store of
 * operations a HUMAN actually answered, keyed on answer provenance (ADR
 * 0015 "Amendment, 2026-08-02"), with an allow/deny matching asymmetry
 * mirroring ADR 0010 (allow precise, deny broad).
 *
 * No mocks: every function under test is pure or operates on a real
 * in-memory class instance, exactly like `authority.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import {
  type PrecedentRecord,
  PrecedentStore,
  findApprovedPrecedent,
  findDeniedPrecedent,
  parsePermissionQuestionText,
} from '../../src/auto-approve/precedent.ts';

describe('PrecedentStore', () => {
  test('starts empty', () => {
    const store = new PrecedentStore();
    expect(store.size).toBe(0);
    expect(store.matchApproved('Bash', 'Bash: git status')).toBeNull();
  });

  test('records an approval and matches it exactly', () => {
    const store = new PrecedentStore();
    store.record('Bash', 'Bash: git status', 'approved');
    expect(store.size).toBe(1);
    const match = store.matchApproved('Bash', 'Bash: git status');
    expect(match).not.toBeNull();
    expect(match?.decision).toBe('approved');
    expect(match?.matchKind).toBe('exact');
    expect(match?.matchedSignature).toBe('Bash: git status');
  });

  test('records a denial and matches it broadly', () => {
    const store = new PrecedentStore();
    store.record('Bash', 'Bash: rm -rf ./build', 'denied');
    // Broad: a LONGER command embedding the denied one still matches.
    const match = store.matchDenied('Bash', 'Bash: rm -rf ./build/dist');
    expect(match).not.toBeNull();
    expect(match?.decision).toBe('denied');
    expect(match?.matchKind).toBe('substring');
  });

  test('ignores a blank tool name or signature', () => {
    const store = new PrecedentStore();
    store.record('', 'Bash: git status', 'approved');
    store.record('Bash', '', 'approved');
    store.record('Bash', '   ', 'approved');
    expect(store.size).toBe(0);
  });

  test('normalizes whitespace on record (surrounding + collapsed internal)', () => {
    const store = new PrecedentStore();
    store.record('Bash', '  Bash:   git   status  ', 'approved');
    const match = store.matchApproved('Bash', 'Bash: git status');
    expect(match).not.toBeNull();
  });

  test('evicts the oldest entry once over maxEntries (cap/eviction)', () => {
    const store = new PrecedentStore(2);
    store.record('Bash', 'Bash: one', 'approved');
    store.record('Bash', 'Bash: two', 'approved');
    store.record('Bash', 'Bash: three', 'approved');
    expect(store.size).toBe(2);
    expect(store.matchApproved('Bash', 'Bash: one')).toBeNull();
    expect(store.matchApproved('Bash', 'Bash: two')).not.toBeNull();
    expect(store.matchApproved('Bash', 'Bash: three')).not.toBeNull();
  });

  test('clear() drops every recorded precedent (session rotation)', () => {
    const store = new PrecedentStore();
    store.record('Bash', 'Bash: git status', 'approved');
    store.record('Bash', 'Bash: rm -rf ./build', 'denied');
    store.clear();
    expect(store.size).toBe(0);
    expect(store.matchApproved('Bash', 'Bash: git status')).toBeNull();
    expect(store.matchDenied('Bash', 'Bash: rm -rf ./build')).toBeNull();
  });

  test('a different tool never matches, even with an identical signature string', () => {
    const store = new PrecedentStore();
    store.record('Bash', 'git status', 'approved');
    expect(store.matchApproved('Read', 'git status')).toBeNull();
  });

  test('matchApproved returns the MOST RECENT matching record', () => {
    const store = new PrecedentStore();
    store.record('Bash', 'Bash: git status', 'denied'); // stale/superseded
    store.record('Bash', 'Bash: git status', 'approved'); // the real precedent
    const match = store.matchApproved('Bash', 'Bash: git status');
    expect(match?.decision).toBe('approved');
  });
});

describe('findApprovedPrecedent — precise (ADR 0010: allow-shaped)', () => {
  function record(
    signature: string,
    decision: 'approved' | 'denied' = 'approved',
  ): PrecedentRecord {
    return { toolName: 'Bash', signature, decision, recordedAt: Date.now() };
  }

  test('exact match approves', () => {
    const records = [record('Bash: git push origin main')];
    expect(findApprovedPrecedent(records, 'Bash', 'Bash: git push origin main')).not.toBeNull();
  });

  // THE critical precision case: a differing flag must NOT match. If this
  // ever goes green with matchKind other than a genuine exact hit, approval
  // precedent would silently authorize a more dangerous variant of an
  // approved command family (ADR 0010's exact failure mode for allow).
  test('a differing FLAG does not match', () => {
    const records = [record('Bash: git push origin main')];
    expect(findApprovedPrecedent(records, 'Bash', 'Bash: git push --force origin main')).toBeNull();
  });

  test('a differing PATH does not match', () => {
    const records = [record('Bash: rm ./build/old.txt')];
    expect(findApprovedPrecedent(records, 'Bash', 'Bash: rm ./build/new.txt')).toBeNull();
  });

  test('an ADDED redirection does not match', () => {
    const records = [record('Bash: echo hi')];
    expect(findApprovedPrecedent(records, 'Bash', 'Bash: echo hi > out.txt')).toBeNull();
  });

  test('a shorter command that is a prefix of an approved one does not match', () => {
    const records = [record('Bash: rm -rf ./build/dist')];
    expect(findApprovedPrecedent(records, 'Bash', 'Bash: rm -rf ./build')).toBeNull();
  });

  test('a longer command that embeds an approved one does not match', () => {
    const records = [record('Bash: rm -rf ./build')];
    expect(findApprovedPrecedent(records, 'Bash', 'Bash: rm -rf ./build/dist')).toBeNull();
  });

  test('a denied record never satisfies an approval lookup', () => {
    const records = [record('Bash: git status', 'denied')];
    expect(findApprovedPrecedent(records, 'Bash', 'Bash: git status')).toBeNull();
  });

  test('surrounding/collapsed whitespace differences still match (normalization)', () => {
    const records = [record('Bash: git   status')];
    expect(findApprovedPrecedent(records, 'Bash', '  Bash: git status  ')).not.toBeNull();
  });

  test('different tool, same text, does not match', () => {
    const records = [record('git status')];
    expect(findApprovedPrecedent(records, 'Read', 'git status')).toBeNull();
  });

  test('empty records array never matches', () => {
    expect(findApprovedPrecedent([], 'Bash', 'Bash: git status')).toBeNull();
  });
});

describe('findDeniedPrecedent — broad (ADR 0010: a stop rule over-reaches)', () => {
  function denied(signature: string): PrecedentRecord {
    return { toolName: 'Bash', signature, decision: 'denied', recordedAt: Date.now() };
  }

  test('exact match denies', () => {
    const records = [denied('Bash: rm -rf ./build')];
    expect(findDeniedPrecedent(records, 'Bash', 'Bash: rm -rf ./build')).not.toBeNull();
  });

  test('a longer command embedding a denied one still matches (broad)', () => {
    const records = [denied('Bash: rm -rf ./build')];
    const match = findDeniedPrecedent(records, 'Bash', 'Bash: rm -rf ./build/dist/assets');
    expect(match).not.toBeNull();
    expect(match?.matchKind).toBe('substring');
  });

  test('a shorter query embedded IN a denied one still matches (broad, other direction)', () => {
    const records = [denied('Bash: rm -rf ./build/dist/assets')];
    expect(findDeniedPrecedent(records, 'Bash', 'Bash: rm -rf ./build')).not.toBeNull();
  });

  test('an unrelated command does not match', () => {
    const records = [denied('Bash: rm -rf ./build')];
    expect(findDeniedPrecedent(records, 'Bash', 'Bash: git status')).toBeNull();
  });

  test('an approved record never satisfies a denial lookup', () => {
    const records: PrecedentRecord[] = [
      { toolName: 'Bash', signature: 'Bash: rm -rf ./build', decision: 'approved', recordedAt: 0 },
    ];
    expect(findDeniedPrecedent(records, 'Bash', 'Bash: rm -rf ./build')).toBeNull();
  });

  test('different tool never matches even on an identical string', () => {
    const records = [denied('rm -rf ./build')];
    expect(findDeniedPrecedent(records, 'Read', 'rm -rf ./build')).toBeNull();
  });
});

describe('parsePermissionQuestionText', () => {
  test('main-agent, with a detail (the common Bash shape)', () => {
    expect(parsePermissionQuestionText('Allow Bash: git push origin main')).toEqual({
      toolName: 'Bash',
      signature: 'Bash: git push origin main',
    });
  });

  test('main-agent, no detail', () => {
    expect(parsePermissionQuestionText('Allow Read')).toEqual({
      toolName: 'Read',
      signature: 'Read',
    });
  });

  test('subagent, with a detail', () => {
    expect(parsePermissionQuestionText('code-reviewer · Bash: git push origin main')).toEqual({
      toolName: 'Bash',
      signature: 'Bash: git push origin main',
    });
  });

  test('subagent, no detail', () => {
    expect(parsePermissionQuestionText('code-reviewer · Read')).toEqual({
      toolName: 'Read',
      signature: 'Read',
    });
  });

  test('a colon inside the detail does not confuse tool-name extraction', () => {
    expect(parsePermissionQuestionText('Allow Bash: echo "a: b"')).toEqual({
      toolName: 'Bash',
      signature: 'Bash: echo "a: b"',
    });
  });

  test('unrecognized text (no "Allow " prefix, no agent separator) returns null', () => {
    // This is the question-bearing-tool shape (ExitPlanMode / AskUserQuestion),
    // e.g. "Plan ready for review. How do you want to proceed?" -- deliberately
    // unhandled, see the module doc for why its only caller never reaches here.
    expect(
      parsePermissionQuestionText('Plan ready for review. How do you want to proceed?'),
    ).toBeNull();
  });

  test('empty string returns null', () => {
    expect(parsePermissionQuestionText('')).toBeNull();
  });

  test('"Allow " with nothing after it returns null', () => {
    expect(parsePermissionQuestionText('Allow ')).toBeNull();
  });
});
