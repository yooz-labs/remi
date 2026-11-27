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
import { stripComments } from '../helpers/strip-comments.ts';

const PROMPTS = { hold_seconds: 90, daemon_hold_seconds: 3540 };

describe('permissionHoldPolicy (#1837)', () => {
  test('wrapper holds structured questions longer and registers 3600 seconds', () => {
    const p = permissionHoldPolicy(true, PROMPTS);
    expect(p.hasLocalTerminal).toBe(true);
    expect(p.holdMsFor('Bash')).toBe(90_000);
    expect(p.holdMsFor('AskUserQuestion')).toBe(3_540_000);
    expect(p.holdMsFor('ExitPlanMode')).toBe(3_540_000);
    expect(p.permissionRequestTimeoutSec).toBe(3600);
    expect(p.hookTimeoutMs).toBe(3_600_000);
    expect(p.terminalPromptMs).toBe(90_000);
  });

  test('daemon and hub hold all tools for daemon_hold_seconds', () => {
    const p = permissionHoldPolicy(false, PROMPTS);
    expect(p.hasLocalTerminal).toBe(false);
    for (const tool of ['Bash', 'AskUserQuestion', 'ExitPlanMode']) {
      expect(p.holdMsFor(tool)).toBe(3_540_000);
    }
    expect(p.permissionRequestTimeoutSec).toBe(3600);
    expect(p.hookTimeoutMs).toBe(3_600_000);
    expect(p.terminalPromptMs).toBe(90_000);
  });

  test('both configured hold overrides are honored and stay below the hook timeout', () => {
    for (const local of [true, false]) {
      const p = permissionHoldPolicy(local, { hold_seconds: 17, daemon_hold_seconds: 123 });
      expect(p.holdMsFor('Bash')).toBe(local ? 17_000 : 123_000);
      expect(p.terminalPromptMs).toBe(17_000);
      for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
        expect(p.holdMsFor(tool)).toBe(123_000);
        expect(p.holdMsFor(tool)).toBeLessThan(p.hookTimeoutMs);
      }
    }
  });
});

describe('cli.ts and harness/claude-session.ts take every per-mode value from the policy', () => {
  const cli = fs.readFileSync(path.resolve(import.meta.dir, '../../src/cli.ts'), 'utf8');
  // The session gate's wiring moved behind the harness seam in #1164. Read
  // with comments removed, so a commented-out line cannot satisfy a pin.
  // `cli.ts` is read raw: its second test splits the file at a comment marker.
  const claudeSession = stripComments(
    fs.readFileSync(path.resolve(import.meta.dir, '../../src/harness/claude-session.ts'), 'utf8'),
  );

  test('the session gate: hold, hook timeout and subagent routing', () => {
    expect(claudeSession).toContain(
      'const holdPolicy = permissionHoldPolicy(passThrough, deps.prompts());',
    );
    expect(claudeSession).toContain('holdMs: holdPolicy.holdMsFor,');
    expect(claudeSession).toContain('hookTimeoutMs: holdPolicy.hookTimeoutMs,');
    expect(claudeSession).toContain('terminalPromptMs: holdPolicy.terminalPromptMs,');
    expect(claudeSession).toContain('hasLocalTerminal: holdPolicy.hasLocalTerminal,');
  });

  test('hook registration requires the policy timeout', () => {
    const manager = stripComments(
      fs.readFileSync(
        path.resolve(import.meta.dir, '../../src/hooks/hook-config-manager.ts'),
        'utf8',
      ),
    );
    expect(manager).toContain('opts: { permissionRequestTimeout: number },');
    expect(manager).toContain('this.permissionRequestTimeout = opts.permissionRequestTimeout;');
  });

  test('the hook registration: 3600 s for both branches', () => {
    const wrapperStart = cli.indexOf('// Wrapper mode: spawn Claude immediately');
    expect(wrapperStart).toBeGreaterThan(0);
    const daemonPart = cli.slice(0, wrapperStart);
    const wrapperPart = cli.slice(wrapperStart);
    expect(daemonPart).toContain('permissionHoldPolicy(false, remiConfig.prompts)');
    expect(daemonPart).not.toContain('permissionHoldPolicy(true, remiConfig.prompts)');
    expect(wrapperPart).toContain('permissionHoldPolicy(true, remiConfig.prompts)');
    expect(wrapperPart).not.toContain('permissionHoldPolicy(false, remiConfig.prompts)');
    for (const part of [daemonPart, wrapperPart]) {
      expect(stripComments(part)).toMatch(
        /permissionRequestTimeout:\s*permissionHoldPolicy\((?:true|false), remiConfig\.prompts\)\s*\.permissionRequestTimeoutSec/,
      );
    }
  });
});
