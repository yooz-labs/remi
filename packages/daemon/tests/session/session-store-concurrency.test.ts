import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Regression test for #1080: two daemons sharing one sessions.json can both
 * read the same old snapshot and atomically replace it, losing the other's
 * record. The per-process tmp file fixed torn writes, but only a lock around
 * the complete read-modify-write transaction fixes lost updates. This drives
 * REAL concurrent subprocesses (no mocks) and asserts every record survives.
 */
describe('SessionStore multi-process concurrency (#461)', () => {
  test('concurrent writers retain every unique session record', async () => {
    const worker = path.join(import.meta.dir, 'store-concurrency-worker.ts');
    const WORKERS = 6;
    const ITERATIONS = 60;
    const ROUNDS = 5;

    for (let round = 1; round <= ROUNDS; round++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-store-conc-'));
      const filePath = path.join(dir, 'sessions.json');
      try {
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
            throw new Error(
              `round ${round}, worker ${i} exited with code ${code}: ${stderr.trim()}`,
            );
          }
        }
        expect(results.every((r) => r.code === 0)).toBe(true);

        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as {
          version: number;
          sessions: Array<{ remiSessionId: string; claudeSessionId: string | null }>;
        };
        expect(data.version).toBe(1);
        expect(data.sessions).toHaveLength(WORKERS * ITERATIONS);
        expect(new Set(data.sessions.map((session) => session.remiSessionId)).size).toBe(
          WORKERS * ITERATIONS,
        );
        expect(data.sessions.every((session) => session.claudeSessionId !== null)).toBe(true);

        // Neither the lock nor the atomic-write temporary file is part of the
        // steady-state store after all writers have completed.
        const leftovers = fs
          .readdirSync(dir)
          .filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'));
        expect(leftovers).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120000);
});
