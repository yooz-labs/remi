/**
 * Source pin (#1271 review): `remi stop` kills the hub 5 s after SIGTERM, and the hub's cleanup
 * stops the relay (up to ORDERLY_CLOSE_GRACE_MS, #1225) and drains its pushes in flight (up to
 * PUSH_DRAIN_TIMEOUT_MS, #1223). In sequence the two could use most of that 5 s, so the drain runs
 * beside `registry.stopAll()`, and the drain after the session shutdown gets only what is left of
 * the same budget. `cli.ts` is a script, so this reads its source, as the repo's other wiring pins
 * do.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../helpers/strip-comments.ts';

const cli = stripComments(readFileSync(join(import.meta.dir, '../../src/cli.ts'), 'utf8'));

function cleanupBody(): string {
  const from = cli.indexOf('async function cleanup(): Promise<void> {');
  expect(from).toBeGreaterThan(-1);
  const to = cli.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return cli.slice(from, to);
}

test('the push drain runs beside the adapters stopping, within one budget', () => {
  const body = cleanupBody();
  const drainStarts = body.indexOf('const draining = drainPushDeliveries(PUSH_DRAIN_TIMEOUT_MS);');
  const stops = body.indexOf('await registry.stopAll();');
  const drained = body.indexOf('await draining;');
  expect(drainStarts, 'the drain starts before the adapters stop').toBeGreaterThan(-1);
  expect(stops).toBeGreaterThan(drainStarts);
  expect(drained, 'and is awaited after them').toBeGreaterThan(stops);
  // The last drain (pushes the session shutdown started) gets what is left of the same budget.
  const last = body.lastIndexOf('drainPushDeliveries(');
  expect(body.slice(last)).toMatch(
    /^drainPushDeliveries\(Math\.max\(0, drainUntil - Date\.now\(\)\)\)/,
  );
  expect(body).toContain('const drainUntil = Date.now() + PUSH_DRAIN_TIMEOUT_MS;');
});
