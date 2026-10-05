/** `limit()`: a Worker variable overrides a default only when it is a sane positive integer. */

import { describe, expect, test } from 'bun:test';
import { LIMIT_DEFAULTS, limit } from '../src/limits.ts';

describe('limit()', () => {
  test('an unset variable is the default', () => {
    expect(limit({}, 'MAX_CLIENTS')).toBe(LIMIT_DEFAULTS.MAX_CLIENTS);
  });

  test('a positive integer overrides the default', () => {
    expect(limit({ MAX_CLIENTS: '3' }, 'MAX_CLIENTS')).toBe(3);
  });

  test('anything else falls back to the default', () => {
    for (const bad of ['', '0', '-1', '1.5', 'many', '1e3', ' 4', '99999999', '1000001']) {
      expect([bad, limit({ MAX_CLIENTS: bad }, 'MAX_CLIENTS')]).toEqual([
        bad,
        LIMIT_DEFAULTS.MAX_CLIENTS,
      ]);
    }
  });
});
