/**
 * Tests for the question-lifecycle trace's `promptId` + `callSite` fields
 * (#887, closing the "trace format gap" the issue named: pre-this-change,
 * `add`/`remove` records carried `questionId` top-level but no way to tell
 * WHICH internal code path performed a removal, nor which Claude Code turn a
 * record belonged to). Same real-subprocess pattern as `question-trace.test.ts`
 * (#808), which this suite deliberately does not touch or extend.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKER = path.join(import.meta.dir, 'question-trace-identity-worker.ts');

function readTraceLines(home: string): Record<string, unknown>[] {
  const tracePath = path.join(home, '.remi', 'question-trace.jsonl');
  if (!fs.existsSync(tracePath)) return [];
  return fs
    .readFileSync(tracePath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

async function runWorker(home: string): Promise<void> {
  const { REMI_QUESTION_TRACE: _inherited, ...rest } = process.env;
  const env = { ...rest, HOME: home, REMI_QUESTION_TRACE: '1' };
  const proc = Bun.spawn(['bun', WORKER], { env, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`worker exited ${code}: ${stderr}`);
  }
}

describe('question-trace promptId + callSite (#887)', () => {
  function makeTmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-question-trace-identity-test-'));
  }

  test('a hook-born record carries promptId and callSite', async () => {
    const tmpHome = makeTmpHome();
    try {
      await runWorker(tmpHome);
      const lines = readTraceLines(tmpHome);
      expect(lines).toHaveLength(3);

      const [added, removed, ptyOnly] = lines as [
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(added).toMatchObject({
        action: 'add',
        questionId: 'question-1',
        promptId: 'turn-abc',
        callSite: 'SessionRegistry.addQuestion',
      });
      expect(removed).toMatchObject({
        action: 'remove',
        questionId: 'question-1',
        promptId: 'turn-abc',
        callSite: 'AutoApproveGate.resolveSupersededQuestion',
      });
      // Both records share the same promptId -- the join key #887 asked for,
      // proving both belong to the same Claude turn without inferring it
      // from timestamps.
      expect(added['promptId']).toBe(removed['promptId']);

      // A genuinely hook-less question has no promptId at all: absent, not
      // null or an empty string.
      expect(ptyOnly).toMatchObject({ action: 'add', questionId: 'question-2' });
      expect('promptId' in ptyOnly).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
