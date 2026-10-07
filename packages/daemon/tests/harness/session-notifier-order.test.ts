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
 * Before the move this file pinned the same order wherever the registration
 * lived (it was in the Claude launch, before the tracker and the hook bridge);
 * the move tightened it to the shell.
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
  test('exactly one place registers it, and it is the shell', () => {
    const count = (text: string) => text.split(REGISTRATION).length - 1;
    expect(count(cli)).toBe(1);
    expect(count(claudeSession)).toBe(0);
  });

  test('the shell registers it before it asks the harness to build the session', () => {
    const shellStart = cli.indexOf('async function createNewSession(');
    const shellEnd = cli.indexOf('\n}\n', shellStart);
    expect(shellStart).toBeGreaterThan(0);
    const shell = cli.slice(shellStart, shellEnd);
    const registered = shell.indexOf(REGISTRATION);
    const created = shell.indexOf('harness.createSession({');
    expect(registered).toBeGreaterThan(0);
    expect(created).toBeGreaterThan(registered);
  });

  test('the Claude launch still reads the registry lazily, for its terminal-notice closures', () => {
    expect(claudeSession).toContain(
      'sessionNotifiers.get(sid)?.pushTerminalNotice(sid, question, reason)',
    );
    expect(claudeSession).toContain(
      'sessionNotifiers.get(sid)?.dismissTerminalNotice(sid, questionId)',
    );
  });

  test('a commented-out registration does not satisfy the pin', () => {
    expect(stripComments(`// ${REGISTRATION}`)).not.toContain(REGISTRATION);
  });
});
