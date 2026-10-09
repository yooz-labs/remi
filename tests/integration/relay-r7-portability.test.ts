/** Source guard: relay test homes must use the runtime's temporary directory. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixtures = [
  'tests/integration/relay-r3-revoke.test.ts',
  'tests/integration/relay-r3-input-log.test.ts',
  'tests/integration/relay-r3-fixture.ts',
  'tests/integration/relay-r3-url.test.ts',
  'tests/integration/relay-r3-child-generation.test.ts',
  'tests/integration/relay-r3-outbound-revoke.test.ts',
  'tests/integration/relay-r3-clock.test.ts',
  'packages/daemon/tests/remote/native-answer-ledger.test.ts',
  'packages/daemon/tests/remote/child-proxy-native-answer.test.ts',
];

test('relay fixtures do not assume a macOS temporary path (R7)', () => {
  for (const file of fixtures) {
    const source = readFileSync(resolve(import.meta.dir, '../..', file), 'utf8');
    expect(source).not.toMatch(/mkdtempSync\(['"]\/private\/tmp\//);
  }
});
