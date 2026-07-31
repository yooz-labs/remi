/**
 * Tests for the debug-sink provenance stamp (#934).
 *
 * `debugProvenance()` is the shared signal every debug sink (hook-diag,
 * question-trace, pty-capture) stamps onto its records so a synthetic write
 * from the test suite is distinguishable from a real one by data, not by a
 * path convention or a hardcoded id. It reads `REMI_TEST_HARNESS` (set
 * unconditionally by `tests/debug/test-harness-marker.ts` via `bunfig.toml`'s
 * `[test].preload`) lazily, not cached, so mutating env within this same
 * process and re-invoking the function is a faithful test of the real
 * behavior.
 *
 * An earlier version of `debugProvenance()` read `NODE_ENV === 'test'`
 * instead, on the claim that `bun test` sets `NODE_ENV=test` for the whole
 * process. A review caught that this is only true when `NODE_ENV` is UNSET
 * beforehand -- an ambient `NODE_ENV=production` (or any non-'test' value)
 * defeated it, silently recreating #934 while `_provenance: 'live'` made it
 * look solved. The "ambient NODE_ENV cannot defeat the stamp" test below is
 * the regression test for exactly that: it is what would have caught the
 * bug before it shipped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { debugProvenance } from '../../src/debug/provenance.ts';

describe('debugProvenance (#934)', () => {
  const prevMarker = process.env['REMI_TEST_HARNESS'];
  const prevNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    if (prevMarker === undefined) {
      // biome-ignore lint/performance/noDelete: env vars must be truly unset
      delete process.env['REMI_TEST_HARNESS'];
    } else {
      process.env['REMI_TEST_HARNESS'] = prevMarker;
    }
    if (prevNodeEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env vars must be truly unset
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = prevNodeEnv;
    }
  });

  test('reads "test" under bun test (REMI_TEST_HARNESS set by bunfig.toml preload), unmodified', () => {
    // No mutation here: this is what every OTHER test in this repo actually
    // runs under, so it is the real-world case, not a simulated one.
    expect(process.env['REMI_TEST_HARNESS']).toBeTruthy();
    expect(debugProvenance()).toBe('test');
  });

  test('reads "live" when REMI_TEST_HARNESS is unset', () => {
    // biome-ignore lint/performance/noDelete: env vars must be truly unset
    delete process.env['REMI_TEST_HARNESS'];
    expect(debugProvenance()).toBe('live');
  });

  test('reads "live" when REMI_TEST_HARNESS is an empty string', () => {
    process.env['REMI_TEST_HARNESS'] = '';
    expect(debugProvenance()).toBe('live');
  });

  test('is read lazily per call, not cached at import time', () => {
    // biome-ignore lint/performance/noDelete: env vars must be truly unset
    delete process.env['REMI_TEST_HARNESS'];
    expect(debugProvenance()).toBe('live');
    process.env['REMI_TEST_HARNESS'] = '1';
    expect(debugProvenance()).toBe('test');
  });

  test('REGRESSION (#934): an ambient non-test NODE_ENV cannot defeat the "test" stamp', () => {
    // This is the exact bug review found: the first implementation read
    // NODE_ENV === 'test', which a pre-existing ambient NODE_ENV=production
    // (or development, or anything else) silently defeats -- "bun test sets
    // NODE_ENV=test" is only true when NODE_ENV was unset beforehand.
    // debugProvenance() no longer reads NODE_ENV at all: mutating it here,
    // to a real-world value a developer's shell plausibly already exports,
    // must have NO effect on the result.
    process.env['NODE_ENV'] = 'production';
    expect(debugProvenance()).toBe('test');

    process.env['NODE_ENV'] = 'development';
    expect(debugProvenance()).toBe('test');

    // biome-ignore lint/performance/noDelete: env vars must be truly unset
    delete process.env['NODE_ENV'];
    expect(debugProvenance()).toBe('test');
  });

  test('a truthy-but-not-"1" marker still reads "test" (fails toward test, not live)', () => {
    // The check is deliberately a truthiness test, not `=== '1'`: an
    // ambiguous non-empty value must resolve toward the safe direction
    // ('test'), never toward 'live'.
    process.env['REMI_TEST_HARNESS'] = 'true';
    expect(debugProvenance()).toBe('test');
  });
});
