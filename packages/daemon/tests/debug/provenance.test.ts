/**
 * Tests for the debug-sink provenance stamp (#934).
 *
 * `debugProvenance()` is the shared signal every debug sink (hook-diag,
 * question-trace, pty-capture) stamps onto its records so a synthetic write
 * from the test suite is distinguishable from a real one by data, not by a
 * path convention or a hardcoded id. It reads `process.env.NODE_ENV` lazily
 * (not cached), so mutating it within this same process and re-invoking the
 * function is a faithful test of the real behavior.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { debugProvenance } from '../../src/debug/provenance.ts';

describe('debugProvenance (#934)', () => {
  const prevNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    if (prevNodeEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env vars must be truly unset
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = prevNodeEnv;
    }
  });

  test('reads "test" under bun test (NODE_ENV=test), unmodified', () => {
    // No mutation here: this is what every OTHER test in this repo actually
    // runs under, so it is the real-world case, not a simulated one.
    expect(process.env['NODE_ENV']).toBe('test');
    expect(debugProvenance()).toBe('test');
  });

  test('reads "live" when NODE_ENV is not "test"', () => {
    process.env['NODE_ENV'] = 'production';
    expect(debugProvenance()).toBe('live');
  });

  test('reads "live" when NODE_ENV is unset', () => {
    // biome-ignore lint/performance/noDelete: env vars must be truly unset
    delete process.env['NODE_ENV'];
    expect(debugProvenance()).toBe('live');
  });

  test('is read lazily per call, not cached at import time', () => {
    process.env['NODE_ENV'] = 'production';
    expect(debugProvenance()).toBe('live');
    process.env['NODE_ENV'] = 'test';
    expect(debugProvenance()).toBe('test');
  });
});
