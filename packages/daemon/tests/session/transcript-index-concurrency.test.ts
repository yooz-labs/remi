import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * TranscriptIndex is a second durable read-modify-write store. This uses real
 * subprocesses to prove that concurrent binding seeds/rotations do not lose
 * entries even though each writer has its own TranscriptIndex instance.
 */
describe('TranscriptIndex multi-process concurrency (#577)', () => {
  test('concurrent writers retain every unique binding', async () => {
    const worker = path.join(import.meta.dir, 'transcript-index-concurrency-worker.ts');
    const WORKERS = 4;
    const ITERATIONS = 40;
    const ROUNDS = 3;

    for (let round = 1; round <= ROUNDS; round++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tidx-conc-'));
      const filePath = path.join(dir, 'transcript-index.json');
      try {
        const procs = Array.from({ length: WORKERS }, () =>
          Bun.spawn(['bun', worker, filePath, String(ITERATIONS)], {
            stdout: 'pipe',
            stderr: 'pipe',
          }),
        );

        const results = await Promise.all(
          procs.map(async (proc, i) => ({
            i,
            code: await proc.exited,
            stderr: await new Response(proc.stderr).text(),
          })),
        );
        for (const result of results) {
          if (result.code !== 0 || result.stderr.trim() !== '') {
            throw new Error(
              `round ${round}, worker ${result.i} failed: code=${result.code} stderr=${result.stderr.trim()}`,
            );
          }
        }

        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
          version: number;
          entries: Array<{ remiSessionId: string; claudeSessionId: string }>;
        };
        const expected = WORKERS * ITERATIONS;
        expect(raw.version).toBe(1);
        expect(raw.entries).toHaveLength(expected);
        expect(new Set(raw.entries.map((entry) => entry.remiSessionId)).size).toBe(expected);
        expect(raw.entries.every((entry) => entry.claudeSessionId.startsWith('claude-'))).toBe(
          true,
        );

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
