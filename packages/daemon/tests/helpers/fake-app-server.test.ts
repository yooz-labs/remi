/**
 * The test doubles under test (epic #1175, phase 1 #1181): the helpers in
 * `fake-app-server.ts` are code the other tests trust, so what they promise is pinned here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socketDir } from './fake-app-server.ts';

describe('socketDir', () => {
  const made: string[] = [];
  const originalTmpdir = process.env['TMPDIR'];
  afterEach(() => {
    if (originalTmpdir === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
    else process.env['TMPDIR'] = originalTmpdir;
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('uses the temp directory when the socket path fits', () => {
    const base = mkdtempSync(join(tmpdir(), 'sd-'));
    made.push(base);
    process.env['TMPDIR'] = base;
    const dir = socketDir('sock-', 's.sock');
    made.push(dir);
    expect(dir.startsWith(base)).toBe(true);
  });

  test('falls back to /tmp when a long TMPDIR would overflow sun_path', () => {
    const base = join(mkdtempSync(join(tmpdir(), 'sd-')), 'x'.repeat(120));
    mkdirSync(base);
    made.push(base);
    process.env['TMPDIR'] = base;
    const dir = socketDir('sock-', 's.sock');
    made.push(dir);
    expect(dir.startsWith('/tmp/sock-')).toBe(true);
    expect(join(dir, 's.sock').length).toBeLessThanOrEqual(100);
    // The directory that was too long is not left behind.
    expect(readdirSync(base)).toEqual([]);
  });
});
