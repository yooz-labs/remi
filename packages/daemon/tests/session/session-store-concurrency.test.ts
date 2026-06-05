import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Regression test for #461: two daemons sharing one ~/.remi raced on a fixed
 * `sessions.json.tmp` path — whichever process renamed second hit ENOENT
 * because the other had already moved the shared tmp away. The fix scopes the
 * tmp file per process (`sessions.json.<pid>.tmp`), so concurrent writers can
 * never collide. This drives REAL concurrent subprocesses (no mocks): on the
 * pre-fix code some workers crash with ENOENT; with the fix all exit cleanly.
 */
describe('SessionStore multi-process concurrency (#461)', () => {
  let filePath: string;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-store-conc-'));
    filePath = path.join(dir, 'sessions.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('concurrent writers never crash on the tmp-rename race', async () => {
    const worker = path.join(import.meta.dir, 'store-concurrency-worker.ts');
    const WORKERS = 6;
    const ITERATIONS = 60;

    const procs = Array.from({ length: WORKERS }, () =>
      Bun.spawn(['bun', worker, filePath, String(ITERATIONS)], {
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );

    const results = await Promise.all(
      procs.map(async (proc, i) => ({ i, code: await proc.exited, proc })),
    );

    // Surface the first crashing worker's stderr for a useful failure message.
    for (const { i, code, proc } of results) {
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`worker ${i} exited with code ${code}: ${stderr.trim()}`);
      }
    }
    expect(results.every((r) => r.code === 0)).toBe(true);

    // The final file must be intact and valid (no torn write).
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as { version: number; sessions: unknown[] };
    expect(data.version).toBe(1);
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(data.sessions.length).toBeGreaterThan(0);

    // Every writer completes its rename, so no per-process tmp files linger.
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  }, 30000);
});
