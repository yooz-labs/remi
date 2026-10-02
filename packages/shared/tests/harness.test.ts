/**
 * Tests for the harness identity vocabulary (#1162, ADR 0032).
 *
 * Everything is imported through the package index, the only path consumers
 * use (there is deliberately no `package.json` exports entry for it).
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_HARNESS, HARNESS_IDS, identityFromClaudeId, isHarnessId } from '../src/index.ts';
import type { Decision, HarnessId, Question, SessionIdentity } from '../src/index.ts';

describe('HARNESS_IDS', () => {
  test('names exactly claude, codex and opencode, in that order', () => {
    expect([...HARNESS_IDS]).toEqual(['claude', 'codex', 'opencode']);
  });
});

describe('DEFAULT_HARNESS', () => {
  test('is claude, and is one of the named harnesses', () => {
    expect(DEFAULT_HARNESS).toBe('claude');
    expect(HARNESS_IDS).toContain(DEFAULT_HARNESS);
  });
});

describe('isHarnessId', () => {
  test('accepts every named harness', () => {
    for (const id of HARNESS_IDS) {
      expect(isHarnessId(id)).toBe(true);
    }
  });

  test('rejects anything else, including near misses and non-strings', () => {
    const rejected: unknown[] = [
      'Claude',
      'CLAUDE',
      ' claude',
      'claude ',
      'gpt',
      'cursor',
      '',
      null,
      undefined,
      0,
      1,
      true,
      {},
      ['claude'],
    ];
    for (const value of rejected) {
      expect(isHarnessId(value)).toBe(false);
    }
  });

  test('narrows an unknown value so it can index a HarnessId-keyed record', () => {
    const labels: Record<HarnessId, string> = {
      claude: 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode',
    };
    const stored: unknown = 'codex';
    // Only compiles because isHarnessId narrows `unknown` to HarnessId.
    expect(isHarnessId(stored) ? labels[stored] : null).toBe('Codex');
  });
});

describe('identityFromClaudeId', () => {
  test('wraps a Claude Code session id as a claude identity', () => {
    expect(identityFromClaudeId('3f9c2a1e-0000-4000-8000-000000000001')).toEqual({
      harness: 'claude',
      harnessSessionId: '3f9c2a1e-0000-4000-8000-000000000001',
    });
  });

  test('keeps a not-yet-known id as null, never the string "null" or undefined', () => {
    const identity: SessionIdentity = identityFromClaudeId(null);
    expect(identity).toEqual({ harness: 'claude', harnessSessionId: null });
    expect(Object.keys(identity).sort()).toEqual(['harness', 'harnessSessionId']);
  });

  test('uses the default harness', () => {
    expect(identityFromClaudeId('x').harness).toBe(DEFAULT_HARNESS);
  });
});

describe('Decision', () => {
  // Compile-time pin, enforced by `bun run typecheck` (test files are in its
  // include). `Decision` is an alias of `Question`, not a new shape (#1161
  // decided policy); if it ever becomes a distinct type, `Equal` resolves to
  // false and this assignment stops compiling. The runtime assertion below
  // only keeps the constant used.
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
  const decisionIsQuestion: Equal<Decision, Question> = true;

  test('is the same type as Question (checked at compile time)', () => {
    expect(decisionIsQuestion).toBe(true);
  });
});
