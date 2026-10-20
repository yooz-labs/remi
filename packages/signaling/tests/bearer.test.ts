/**
 * The deployment bearer secret (#1200, A1 and A7). Behavior of the constant-time check, plus a
 * source-level guard that no route compares the secret with an ordinary operator, which no
 * behavioral test can see.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bearerAuthorized } from '../src/bearer.ts';

describe('bearerAuthorized', () => {
  const secret = 'owned-deployment-secret';
  test('accepts exactly the Bearer scheme with the whole secret', async () => {
    expect(await bearerAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(await bearerAuthorized(`Bearer ${secret}`, `  ${secret}\n`)).toBe(true);
  });
  test('refuses a missing, wrong, shorter, longer or differently spelled credential', async () => {
    for (const header of [
      null,
      '',
      'Bearer ',
      'Bearer',
      secret,
      `bearer ${secret}`,
      `Basic ${secret}`,
      `Bearer ${secret.slice(0, -1)}`,
      `Bearer ${secret}x`,
      `Bearer  ${secret}`,
      `Bearer ${secret.toUpperCase()}`,
    ])
      expect(await bearerAuthorized(header, secret), String(header)).toBe(false);
  });
  test('an unset or blank secret authorizes nothing, whatever is presented', async () => {
    for (const configured of [undefined, '', '   ', '\n'])
      for (const header of [null, 'Bearer ', 'Bearer x', `Bearer ${configured ?? ''}`])
        expect(await bearerAuthorized(header, configured), `${configured} ${header}`).toBe(false);
  });
});

describe('the push routes', () => {
  test('both compare the bearer through bearerAuthorized, never with an ordinary operator', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8');
    const code = source.split('\n').filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));
    expect(code.filter((l) => /\bbearerAuthorized\(/.test(l)).length).toBeGreaterThanOrEqual(2);
    const comparison = /===|!==|[^=!<>]==[^=]|!=[^=]|\.indexOf\(|\.includes\(|\.startsWith\(/;
    const offenders = code.filter(
      (l) => /PUSH_SECRET|authorization|Bearer/i.test(l) && comparison.test(l),
    );
    expect(offenders).toEqual([]);
  });
});
