/**
 * SubagentAlerter (#807): matching + rate limiting for the after-the-fact
 * destructive-command notification.
 *
 * No mocks: the alerter is pure apart from an injectable clock, and delivery is
 * deliberately NOT its job (the caller pushes), so these are real unit tests
 * over real behavior with no transport to fake.
 */

import { describe, expect, test } from 'bun:test';

import { SubagentAlerter, alertBody, alertTitle } from '../../src/auto-approve/subagent-alert.ts';

/** Patterns matching the shipped default plus two broad opt-ins. */
const PATTERNS = ['rm -rf', 'push --force', 'sudo ', 'curl'];

function bash(command: string): Record<string, unknown> {
  return { command };
}

describe('SubagentAlerter matching', () => {
  test('matches a destructive command anywhere in the string, not just as a prefix', () => {
    const a = new SubagentAlerter(PATTERNS);
    // The compound-command case substring matching exists for: a prefix
    // matcher would miss this entirely.
    const alert = a.check('Bash', bash('cd /tmp && rm -rf build'), 'agent-1', 'general-purpose');
    expect(alert).not.toBeNull();
    expect(alert?.pattern).toBe('rm -rf');
  });

  test('returns null when nothing matches', () => {
    const a = new SubagentAlerter(PATTERNS);
    expect(a.check('Bash', bash('git status'), 'agent-1', 'reviewer')).toBeNull();
  });

  test('an empty pattern list never alerts', () => {
    const a = new SubagentAlerter([]);
    expect(a.check('Bash', bash('rm -rf /'), 'agent-1', undefined)).toBeNull();
  });

  test('carries the agent identity through for the notification', () => {
    const a = new SubagentAlerter(PATTERNS);
    const alert = a.check('Bash', bash('sudo rm x'), 'agent-abc', 'pr-review');
    expect(alert?.agentId).toBe('agent-abc');
    expect(alert?.agentType).toBe('pr-review');
  });

  test('truncates a long command for display but keeps the full one distinct', () => {
    const a = new SubagentAlerter(PATTERNS);
    const long = `rm -rf ${'a'.repeat(400)}`;
    const alert = a.check('Bash', bash(long), 'agent-1', undefined);
    expect(alert?.detail.length).toBeLessThan(long.length);
    expect(alert?.detail.endsWith('...')).toBe(true);

    // Two commands sharing a 160-char prefix are DIFFERENT events: keying the
    // rate limit on the truncated detail would collapse them and silently drop
    // the second.
    const other = `rm -rf ${'a'.repeat(400)}b`;
    expect(a.check('Bash', bash(other), 'agent-1', undefined)).not.toBeNull();
  });

  test('a non-Bash tool matches on the bare tool name', () => {
    const a = new SubagentAlerter(['Write']);
    expect(a.check('Write', { file_path: '/tmp/x' }, 'agent-1', undefined)?.pattern).toBe('Write');
    expect(a.check('Read', { file_path: '/tmp/x' }, 'agent-1', undefined)).toBeNull();
  });
});

describe('SubagentAlerter rate limiting', () => {
  test('collapses a repeat of the same command inside the window', () => {
    let now = 1_000_000;
    const a = new SubagentAlerter(PATTERNS, { nowMs: () => now });

    expect(a.check('Bash', bash('rm -rf build'), 'agent-1', undefined)).not.toBeNull();
    // A retry loop over one command must not become a push storm.
    now += 1_000;
    expect(a.check('Bash', bash('rm -rf build'), 'agent-1', undefined)).toBeNull();
    now += 60_000;
    expect(a.check('Bash', bash('rm -rf build'), 'agent-1', undefined)).toBeNull();
  });

  test('alerts again once the window lapses', () => {
    let now = 1_000_000;
    const a = new SubagentAlerter(PATTERNS, { nowMs: () => now });

    expect(a.check('Bash', bash('rm -rf build'), 'agent-1', undefined)).not.toBeNull();
    now += 5 * 60_000 + 1;
    // The same destructive command later is a NEW event worth knowing about.
    expect(a.check('Bash', bash('rm -rf build'), 'agent-1', undefined)).not.toBeNull();
  });

  test('different commands matching the same pattern each alert', () => {
    const now = 1_000_000;
    const a = new SubagentAlerter(PATTERNS, { nowMs: () => now });

    expect(a.check('Bash', bash('rm -rf build'), 'agent-1', undefined)).not.toBeNull();
    expect(a.check('Bash', bash('rm -rf dist'), 'agent-1', undefined)).not.toBeNull();
  });

  test('throttling is per command, not per agent: a fleet running one command alerts once', () => {
    const now = 1_000_000;
    const a = new SubagentAlerter(PATTERNS, { nowMs: () => now });

    // Ten agents each running the identical benign-but-matched command is the
    // exact fleet shape that would otherwise produce ten identical banners.
    expect(
      a.check('Bash', bash('curl https://api.github.com'), 'agent-1', undefined),
    ).not.toBeNull();
    for (let i = 2; i <= 10; i++) {
      expect(
        a.check('Bash', bash('curl https://api.github.com'), `agent-${i}`, undefined),
      ).toBeNull();
    }
  });

  test('the tracked-key map stays bounded across many distinct commands', () => {
    let now = 1_000_000;
    const a = new SubagentAlerter(PATTERNS, { nowMs: () => now });
    for (let i = 0; i < 600; i++) {
      now += 1;
      expect(a.check('Bash', bash(`rm -rf dir-${i}`), 'agent-1', undefined)).not.toBeNull();
    }
    // Eviction is oldest-first, so the most recent entry must still be
    // throttled -- proving the map was trimmed rather than cleared wholesale.
    expect(a.check('Bash', bash('rm -rf dir-599'), 'agent-1', undefined)).toBeNull();
  });

  test('reset clears throttle state', () => {
    const now = 1_000_000;
    const a = new SubagentAlerter(PATTERNS, { nowMs: () => now });
    expect(a.check('Bash', bash('rm -rf build'), 'agent-1', undefined)).not.toBeNull();
    expect(a.check('Bash', bash('rm -rf build'), 'agent-1', undefined)).toBeNull();
    a.reset();
    expect(a.check('Bash', bash('rm -rf build'), 'agent-1', undefined)).not.toBeNull();
  });
});

describe('alert copy', () => {
  test('body states the command already ran, so the banner is not read as a prompt', () => {
    const a = new SubagentAlerter(PATTERNS);
    const alert = a.check('Bash', bash('rm -rf build'), 'agent-1', 'pr-review');
    if (alert === null) throw new Error('expected an alert');
    expect(alertTitle(alert)).toContain('pr-review');
    const body = alertBody(alert);
    expect(body).toContain('was allowed to run');
    expect(body).toContain('rm -rf build');
  });

  test('title falls back when the hook carried no agent type', () => {
    const a = new SubagentAlerter(PATTERNS);
    const alert = a.check('Bash', bash('rm -rf build'), 'agent-1', undefined);
    if (alert === null) throw new Error('expected an alert');
    expect(alertTitle(alert)).toContain('Background agent');
  });
});
