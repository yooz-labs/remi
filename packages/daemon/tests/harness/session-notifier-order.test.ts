/**
 * Where a session's APNS dispatcher is registered in `sessionNotifiers`
 * (#1165 E, #1176 item 6).
 *
 * The registration must precede anything that can fire a decision, because
 * the hook bridge's `pushTerminalNotice` closures and `onQuestionResolved`
 * read `sessionNotifiers.get(sid)` when a prompt is released or resolved.
 * Registering it is neutral work (a per-session dispatcher, not Claude's), so
 * the shell, `createNewSession` in `cli.ts`, owns it.
 *
 * Source-text pins: the files are read through `stripComments`, so a
 * commented-out copy of the statement cannot satisfy them. The behavioral
 * counterpart is `tests/integration/session-notifier-registration.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '../helpers/strip-comments.ts';

const SRC = resolve(import.meta.dir, '..', '..', 'src');
const REGISTRATION = 'sessionNotifiers.set(sessionId, notifications);';

function source(...segments: string[]): string {
  return stripComments(readFileSync(resolve(SRC, ...segments), 'utf8'));
}

const cli = source('cli.ts');
const claudeSession = source('harness', 'claude-session.ts');

describe('the session notifier registration', () => {
  test('exactly one place registers it', () => {
    const count = (text: string) => text.split(REGISTRATION).length - 1;
    expect(count(cli) + count(claudeSession)).toBe(1);
  });

  test('it precedes everything in the launch that can fire a decision', () => {
    // In the shell: before the harness is asked to build the session.
    const shellStart = cli.indexOf('async function createNewSession(');
    const shellEnd = cli.indexOf('\n}\n', shellStart);
    expect(shellStart).toBeGreaterThan(0);
    const shell = cli.slice(shellStart, shellEnd);
    const inShell = shell.indexOf(REGISTRATION);
    if (inShell >= 0) {
      expect(inShell).toBeLessThan(shell.indexOf('harness.createSession({'));
      return;
    }
    // Still in the Claude launch: before the tracker and the hook bridge.
    const registered = claudeSession.indexOf(REGISTRATION);
    expect(registered).toBeGreaterThan(0);
    expect(registered).toBeLessThan(claudeSession.indexOf('new QuestionPresenceTracker('));
    expect(registered).toBeLessThan(claudeSession.indexOf('setupHookBridge('));
  });

  test('a commented-out registration does not satisfy the pin', () => {
    expect(stripComments(`// ${REGISTRATION}`)).not.toContain(REGISTRATION);
  });
});
