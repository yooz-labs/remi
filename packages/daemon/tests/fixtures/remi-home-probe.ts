/**
 * Run by `remi-home.test.ts` as `bun test <this file>` with `REMI_HOME`
 * exported (#1155). Not named `*.test.ts`, so the suite itself never
 * collects it. Passes only when the `bunfig.toml` preload
 * (`tests/unset-remi-home.ts`) removed the variable first.
 */
import { expect, test } from 'bun:test';

test('the test process does not see an exported REMI_HOME', () => {
  expect(process.env['REMI_HOME']).toBeUndefined();
});
