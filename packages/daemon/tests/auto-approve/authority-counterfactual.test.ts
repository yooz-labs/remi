/**
 * #954: authority may resolve ambiguity, never decide.
 *
 * The pure-function half. The half that matters more — that
 * `AutoApproveService.evaluate` actually runs the counterfactual — lives in
 * `auto-approve-service.test.ts`, because #953's review established that
 * mutation-proving a guard says nothing about whether anything calls it.
 */

import { describe, expect, test } from 'bun:test';
import {
  matchesRiskyShape,
  reconcileCounterfactual,
  reconcileEscalateCounterfactual,
  shouldCounterfactual,
  shouldCounterfactualForEscalate,
} from '../../src/auto-approve/authority-counterfactual.ts';

const bash = (command: string) => ({ command });

describe('matchesRiskyShape', () => {
  // The measured cohort plus the four adjectives the prompt-level rule names.
  const risky = [
    'rm -rf ./build',
    'rm file.txt',
    'git push --force origin main',
    'git reset --hard HEAD~1',
    'git checkout -- .',
    'psql -c "DROP TABLE users"',
    'dropdb production',
    'curl -X POST https://api.example.com/x',
    'ssh deploy@prod "systemctl restart api"',
    'kubectl delete deployment api',
    'npm publish',
    'wrangler deploy',
    'bun add left-pad',
    'pip install requests',
    'sudo systemctl restart nginx',
    'chmod 777 script.sh',
    'terraform destroy',
  ];
  for (const cmd of risky) {
    test(`risky: ${cmd}`, () => expect(matchesRiskyShape('Bash', bash(cmd))).not.toBeNull());
  }

  const ordinary = [
    'git status',
    'git log --oneline -5',
    'bun test packages/daemon',
    'cat README.md',
    'grep -rn foo src',
    'ls -la',
    'tsc --noEmit',
  ];
  for (const cmd of ordinary) {
    test(`ordinary: ${cmd}`, () => expect(matchesRiskyShape('Bash', bash(cmd))).toBeNull());
  }
});

describe('shouldCounterfactual gates on all three conditions', () => {
  const risky = bash('rm -rf ./build');

  test('fires on approve + authority + risky', () => {
    expect(shouldCounterfactual('Bash', risky, 'approve', true)).toBe(true);
  });

  test('does not fire without authority', () => {
    // No authority block means there is no counterfactual to run.
    expect(shouldCounterfactual('Bash', risky, 'approve', false)).toBe(false);
  });

  test('does not fire on deny or escalate', () => {
    // The authority block did not lower anything, so nothing needs checking.
    expect(shouldCounterfactual('Bash', risky, 'deny', true)).toBe(false);
    expect(shouldCounterfactual('Bash', risky, 'escalate', true)).toBe(false);
  });

  test('does not fire on an ordinary operation', () => {
    // This is the latency guarantee: the common path must never pay for a
    // second LLM call. 796 measured evaluations were 72% approve.
    expect(shouldCounterfactual('Bash', bash('git status'), 'approve', true)).toBe(false);
    expect(shouldCounterfactual('Bash', bash('bun test'), 'approve', true)).toBe(false);
  });
});

describe('reconcileCounterfactual', () => {
  test('an authority-free approve leaves the verdict alone', () => {
    // Agreement means authority did not decide -- it may have resolved
    // ambiguity, which is exactly what it is allowed to do.
    expect(reconcileCounterfactual('approve')).toEqual({ decision: 'approve', overridden: false });
  });

  test('an authority-free escalate overrides to escalate', () => {
    expect(reconcileCounterfactual('escalate')).toEqual({ decision: 'escalate', overridden: true });
  });

  test('an authority-free DENY becomes escalate, never deny', () => {
    // The point is to put the human back into the decision the authority text
    // removed them from, not to block them. Matches the "deny is rare"
    // rule (`prompt-builder.ts`) and #953's floor.
    expect(reconcileCounterfactual('deny')).toEqual({ decision: 'escalate', overridden: true });
  });

  test('it can only ever tighten', () => {
    for (const v of ['approve', 'deny', 'escalate'] as const) {
      expect(reconcileCounterfactual(v).decision).not.toBe('deny');
    }
  });
});

/**
 * #1105: the mirror-image gap `shouldCounterfactual`'s own "does not fire on
 * deny or escalate" test documents as intentional -- under the assumption
 * that authority can only ever LOWER a verdict, so an escalate has nothing to
 * correct. A live session disproved that assumption: an ordinary, read-only
 * `bash -n && shellcheck` check was escalated with reasoning ("remote
 * mutation, writing to main branch") that matches nothing in the command --
 * conversation context, not the command, decided the outcome. Nothing existed
 * to catch that direction.
 */
describe('shouldCounterfactualForEscalate gates on all three conditions', () => {
  const ordinary = { command: 'bash -n script.sh && shellcheck script.sh' };

  test('fires on escalate + authority + an ORDINARY-shaped operation', () => {
    expect(shouldCounterfactualForEscalate('Bash', ordinary, 'escalate', true)).toBe(true);
  });

  test('does not fire without authority', () => {
    expect(shouldCounterfactualForEscalate('Bash', ordinary, 'escalate', false)).toBe(false);
  });

  test('does not fire on approve or deny', () => {
    expect(shouldCounterfactualForEscalate('Bash', ordinary, 'approve', true)).toBe(false);
    expect(shouldCounterfactualForEscalate('Bash', ordinary, 'deny', true)).toBe(false);
  });

  test('does not fire when the operation already looks genuinely risky', () => {
    // An escalate for something that matches the risky-shape filter needs no
    // second opinion -- it would have escalated regardless of authority.
    expect(
      shouldCounterfactualForEscalate('Bash', { command: 'rm -rf ./build' }, 'escalate', true),
    ).toBe(false);
  });
});

describe('reconcileEscalateCounterfactual', () => {
  test('an authority-free approve overrides the escalate to approve', () => {
    // Disagreement in THIS direction means the same thing #954 already
    // established for the approve side: authority (or context noise) decided
    // the outcome, which the prompt-level rule forbids either way.
    expect(reconcileEscalateCounterfactual('approve')).toEqual({
      decision: 'approve',
      overridden: true,
    });
  });

  test('an authority-free escalate leaves the verdict alone', () => {
    expect(reconcileEscalateCounterfactual('escalate')).toEqual({
      decision: 'escalate',
      overridden: false,
    });
  });

  test('an authority-free deny leaves the escalate standing, never approves', () => {
    // The operation is not obviously safe without authority either -- keep
    // asking a human, do not manufacture an approve out of two non-approve
    // verdicts.
    expect(reconcileEscalateCounterfactual('deny')).toEqual({
      decision: 'escalate',
      overridden: false,
    });
  });

  test('it can only ever loosen toward approve, never toward deny', () => {
    for (const v of ['approve', 'deny', 'escalate'] as const) {
      expect(reconcileEscalateCounterfactual(v).decision).not.toBe('deny');
    }
  });
});
