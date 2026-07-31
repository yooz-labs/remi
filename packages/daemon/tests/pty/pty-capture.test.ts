import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ptyCapture } from '../../src/pty/pty-capture.ts';

describe('ptyCapture (#627 diagnostic)', () => {
  let dir: string;
  const prev = process.env['REMI_PTY_CAPTURE'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'remi-pty-capture-'));
  });

  afterEach(() => {
    // delete (not = undefined): assigning undefined to an env var coerces to the
    // string "undefined" (truthy), which would leave capture enabled.
    // biome-ignore lint/performance/noDelete: env vars must be truly unset
    if (prev === undefined) delete process.env['REMI_PTY_CAPTURE'];
    else process.env['REMI_PTY_CAPTURE'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test('no-op (writes nothing) when REMI_PTY_CAPTURE is unset', () => {
    // biome-ignore lint/performance/noDelete: env vars must be truly unset (= undefined coerces to "undefined")
    delete process.env['REMI_PTY_CAPTURE'];
    expect(ptyCapture.enabled).toBe(false);
    // Must not throw and must not create any file.
    ptyCapture.in('x');
    ptyCapture.out(new TextEncoder().encode('y'));
  });

  test('records IN and OUT lines with direction + JSON-escaped payload', () => {
    const file = join(dir, 'cap.log');
    process.env['REMI_PTY_CAPTURE'] = file;
    expect(ptyCapture.enabled).toBe(true);

    ptyCapture.in('\x1b[B'); // a down-arrow keystroke
    ptyCapture.in('\r'); // enter
    ptyCapture.out(new TextEncoder().encode('\x1b[2K> option')); // a rendered frame

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    // IN lines: marker + ms timestamp + provenance (#934) + JSON of the raw
    // bytes (escapes visible). `bunfig.toml`'s `[test].preload` sets
    // REMI_TEST_HARNESS unconditionally for every `bun test` run (see
    // src/debug/provenance.ts and tests/debug/test-harness-marker.ts), so
    // every line here reads 'test' -- proving the stamp, not just its
    // presence.
    expect(lines[0]).toMatch(/^IN \d+ test "\\u001b\[B"$/);
    expect(lines[1]).toMatch(/^IN \d+ test "\\r"$/);
    expect(lines[2]).toMatch(/^OUT \d+ test ".*option"$/);
  });

  test('decodes Uint8Array output to text', () => {
    const file = join(dir, 'cap2.log');
    process.env['REMI_PTY_CAPTURE'] = file;
    ptyCapture.out(new TextEncoder().encode('héllo'));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines[0]).toMatch(/^OUT \d+ test "héllo"$/);
  });

  test('an ambient non-test NODE_ENV cannot defeat the "test" stamp (#934 regression)', () => {
    // This is the exact scenario a review caught: the first version of
    // debugProvenance() read NODE_ENV === 'test', relying on "bun test sets
    // NODE_ENV=test" -- true only when NODE_ENV is unset beforehand. A
    // developer whose shell already exports NODE_ENV=production (or
    // development, a shared .envrc, a container default) got a record
    // stamped 'live' for a genuinely synthetic write, silently recreating
    // #934 while the field made it look solved. debugProvenance() no longer
    // reads NODE_ENV at all -- mutating it here must have NO effect.
    const file = join(dir, 'cap3.log');
    process.env['REMI_PTY_CAPTURE'] = file;
    const prevNodeEnv = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      ptyCapture.in('x');
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      // Still 'test': REMI_TEST_HARNESS (set by bunfig.toml's preload,
      // independent of NODE_ENV) is what this reads.
      expect(lines[0]).toMatch(/^IN \d+ test "x"$/);
    } finally {
      if (prevNodeEnv === undefined) {
        // biome-ignore lint/performance/noDelete: env vars must be truly unset
        delete process.env['NODE_ENV'];
      } else {
        process.env['NODE_ENV'] = prevNodeEnv;
      }
    }
  });

  test('stamps "live" when REMI_TEST_HARNESS is absent (simulates a real, non-test process)', () => {
    const file = join(dir, 'cap4.log');
    process.env['REMI_PTY_CAPTURE'] = file;
    const prevMarker = process.env['REMI_TEST_HARNESS'];
    try {
      // biome-ignore lint/performance/noDelete: env vars must be truly unset
      delete process.env['REMI_TEST_HARNESS'];
      ptyCapture.in('x');
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines[0]).toMatch(/^IN \d+ live "x"$/);
    } finally {
      if (prevMarker === undefined) {
        // biome-ignore lint/performance/noDelete: env vars must be truly unset
        delete process.env['REMI_TEST_HARNESS'];
      } else {
        process.env['REMI_TEST_HARNESS'] = prevMarker;
      }
    }
  });
});
