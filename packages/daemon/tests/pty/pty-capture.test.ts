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
    // IN lines: marker + ms timestamp + JSON of the raw bytes (escapes visible).
    expect(lines[0]).toMatch(/^IN \d+ "\\u001b\[B"$/);
    expect(lines[1]).toMatch(/^IN \d+ "\\r"$/);
    expect(lines[2]).toMatch(/^OUT \d+ ".*option"$/);
  });

  test('decodes Uint8Array output to text', () => {
    const file = join(dir, 'cap2.log');
    process.env['REMI_PTY_CAPTURE'] = file;
    ptyCapture.out(new TextEncoder().encode('héllo'));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines[0]).toMatch(/^OUT \d+ "héllo"$/);
  });
});
