/**
 * #1126 review (T2): the per-mode hold policy. Swapping the two modes' hold
 * length, routing or hook registration used to pass the whole suite; the
 * pure function pins each value, and the source checks pin that `cli.ts` (the
 * hook registration) and `harness/claude-session.ts` (the session gate, since
 * #1164) read all of them from it (a precedent: advertise-decision.test.ts).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { permissionHoldPolicy } from '../../src/cli/hold-policy.ts';

const PROMPTS = { hold_seconds: 90, daemon_hold_seconds: 3540 };

describe('permissionHoldPolicy (#1126)', () => {
  test('wrapper mode: hold_seconds, a local terminal, a 600 s registration', () => {
    expect(permissionHoldPolicy(true, PROMPTS)).toEqual({
      hasLocalTerminal: true,
      holdMs: 90_000,
      permissionRequestTimeoutSec: 600,
      hookTimeoutMs: 600_000,
    });
  });

  test('daemon or hub mode: daemon_hold_seconds, no terminal, a 3600 s registration', () => {
    expect(permissionHoldPolicy(false, PROMPTS)).toEqual({
      hasLocalTerminal: false,
      holdMs: 3_540_000,
      permissionRequestTimeoutSec: 3600,
      hookTimeoutMs: 3_600_000,
    });
  });

  test('in both modes the hold ends before the registered timeout', () => {
    for (const local of [true, false]) {
      const p = permissionHoldPolicy(local, { hold_seconds: 110, daemon_hold_seconds: 3540 });
      expect(p.holdMs).toBeLessThan(p.hookTimeoutMs);
    }
  });
});

describe('cli.ts and harness/claude-session.ts take every per-mode value from the policy', () => {
  const cli = fs.readFileSync(path.resolve(import.meta.dir, '../../src/cli.ts'), 'utf8');
  // The session gate's wiring moved behind the harness seam in #1164.
  const claudeSession = fs.readFileSync(
    path.resolve(import.meta.dir, '../../src/harness/claude-session.ts'),
    'utf8',
  );

  test('the session gate: hold, hook timeout and subagent routing', () => {
    expect(claudeSession).toContain(
      'const holdPolicy = permissionHoldPolicy(passThrough, deps.prompts());',
    );
    expect(claudeSession).toContain('holdMs: holdPolicy.holdMs,');
    expect(claudeSession).toContain('hookTimeoutMs: holdPolicy.hookTimeoutMs,');
    expect(claudeSession).toContain('hasLocalTerminal: holdPolicy.hasLocalTerminal,');
  });

  test('the hook registration: 3600 s for the daemon branch, 600 s for the wrapper branch', () => {
    const wrapperStart = cli.indexOf('// Wrapper mode: spawn Claude immediately');
    expect(wrapperStart).toBeGreaterThan(0);
    const daemonPart = cli.slice(0, wrapperStart);
    const wrapperPart = cli.slice(wrapperStart);
    expect(daemonPart).toContain('permissionHoldPolicy(false, remiConfig.prompts)');
    expect(daemonPart).not.toContain('permissionHoldPolicy(true, remiConfig.prompts)');
    expect(wrapperPart).toContain('permissionHoldPolicy(true, remiConfig.prompts)');
    expect(wrapperPart).not.toContain('permissionHoldPolicy(false, remiConfig.prompts)');
  });
});
