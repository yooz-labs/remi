/**
 * Teardown order of the secure push runtime in `cli.ts` (#1200, B3).
 *
 * Closing a session cancels its held prompts (`dispose` -> `cancelStale('session_closed')`), which
 * dismisses their lock-screen cards through the secure sender. A dismissal needs the runtime, so the
 * runtime must stay able to send dismissals until the teardown has run: it is retired first (nothing
 * new and nothing actionable can be sent), then the session is disposed, then the runtime finishes
 * after its dismissals are out. Finishing it first dropped every one of those dismissals and left a
 * pushed card with action buttons on the lock screen for up to the hold deadline.
 *
 * `cli.ts` is a script, so this reads its source, as the repo's other wiring pins do.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from './helpers/strip-comments.ts';

const source = stripComments(readFileSync(resolve(import.meta.dir, '../src/cli.ts'), 'utf8'));
function between(start: string, end: string, after = ''): string {
  const from = source.indexOf(start, after ? source.indexOf(after) : 0);
  expect(from, `start marker ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to, `end marker ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}
const sites = {
  'a session closing': between(
    'onSessionClosed: (sessionId, reason, pendingQuestionIds) => {',
    'onSessionOrphaned:',
  ),
  'the daemon cleaning up': between(
    'async function cleanup(): Promise<void> {',
    'installProcessGuards(',
  ),
  'a session whose creation failed': between(
    '  } catch (error) {',
    'throw error;',
    'async function createNewSession(',
  ),
};

describe('the secure push runtime outlives the teardown that dismisses its cards', () => {
  for (const [name, text] of Object.entries(sites)) {
    test(`${name}: retired first, finished only after the session is disposed`, () => {
      const dispose = text.search(/\.dispose\(\)/);
      expect(dispose, 'the teardown disposes the session').toBeGreaterThan(-1);
      // No call that finishes the runtime may run before the dispose that emits the dismissals.
      const earlyFinish = text
        .slice(0, dispose)
        .search(/\bfinishSecurePushRuntime\(|\bcloseSecurePushRuntime\(/);
      expect(earlyFinish, 'the runtime is not finished before the dispose').toBe(-1);
      const retire = text.indexOf('retireSecurePushRuntime(');
      expect(retire, 'the runtime is retired').toBeGreaterThan(-1);
      expect(retire).toBeLessThan(dispose);
      expect(text.slice(dispose)).toMatch(/\bcloseSecurePushRuntime\(/);
    });
  }
});

test('the closing step dismisses the cards the disposal did not, before it waits (#1200, B3)', () => {
  const body = between('async function closeSecurePushRuntime(', '\n}\n');
  const dismiss = body.indexOf('dismissUndismissedQuestions(');
  const drain = body.indexOf('.drain(');
  expect(dismiss, 'it dismisses the undismissed cards').toBeGreaterThan(-1);
  expect(drain, 'it waits for them').toBeGreaterThan(dismiss);
  expect(body.indexOf('finishSecurePushRuntime(')).toBeGreaterThan(drain);
});

test('a closing session dismisses the cards it held before its secure runtime closes (#1223)', () => {
  const text = sites['a session closing'];
  // The registry's pending ids are dismissed through the session's dispatcher, which sends the
  // secure dismissal too; the runtime must still be open for it, so the close comes after.
  const pending = text.indexOf('onQuestionResolved(sessionId, questionId,');
  const close = text.search(/\bcloseSecurePushRuntime\(/);
  expect(pending, 'the pending cards are dismissed').toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(pending);
});

test('a closing session closes its secure runtime even when the disposal throws (#1268 review)', () => {
  const text = sites['a session closing'];
  // The disposal runs in a try; the runtime's close belongs in its finally, or a throwing
  // dispose leaves the runtime open (and its pushed cards undismissed) until process cleanup.
  const start = text.indexOf('} finally {');
  expect(start, 'the teardown has a finally').toBeGreaterThan(-1);
  const block = text.slice(start, text.indexOf('\n      }', start));
  expect(block).toMatch(/\bcloseSecurePushRuntime\(/);
});
