#!/usr/bin/env bun
/**
 * Regenerates the checked-in golden protocol fixtures (#895) from
 * `builders.ts`. Run after a deliberate wire-shape change to a message type
 * (new/removed/renamed field); `protocol-fixtures.test.ts` fails first and
 * tells you which type(s) drifted before you run this.
 *
 * Usage: bun packages/shared/tests/fixtures/protocol/generate.ts
 *        bunx biome check --write packages/shared/tests/fixtures/protocol/
 *
 * (the second command is not optional: biome collapses short JSON arrays
 * onto one line, which `JSON.stringify(value, null, 2)` below does not, so
 * a freshly generated fixture fails `bunx biome check .` until reformatted)
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_BUILDERS } from './builders.ts';

const DIR = dirname(fileURLToPath(import.meta.url));

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(DIR, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

for (const [type, build] of Object.entries(FIXTURE_BUILDERS)) {
  writeJson(type, build());
}

// A message type deliberately absent from the registry, pinning the
// forward-compat contract: `deserialize` must return null for it rather
// than throwing, so an OLDER client talking to a NEWER daemon (or vice
// versa) degrades gracefully on a type it doesn't recognize.
writeJson('__unknown_type__', {
  type: 'not_a_real_message_type',
  id: 'fixture-bogus-id',
  timestamp: '2026-01-01T00:00:00.000Z',
});

console.log(`Wrote ${Object.keys(FIXTURE_BUILDERS).length + 1} protocol fixtures to ${DIR}`);
