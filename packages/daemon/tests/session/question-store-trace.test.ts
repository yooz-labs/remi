/**
 * Trace-callSite regression test for the #888 QuestionStore extraction.
 *
 * SessionRegistry.addQuestion/removeQuestion/clearQuestions used to mutate
 * `currentQuestions` and emit trace records inline; #888 moved that logic
 * into QuestionStore, keeping SessionRegistry's methods as thin adapters.
 * This pins that the extraction is trace-observably a no-op for every
 * EXISTING call path: the same default `callSite` strings
 * ('SessionRegistry.addQuestion', its ':lru_eviction' eviction variant,
 * 'SessionRegistry.removeQuestion', 'SessionRegistry.clearQuestions') still
 * appear, unchanged, byte for byte.
 *
 * Same real-subprocess HOME-override pattern as `question-trace.test.ts`
 * (#808) and `question-trace-identity.test.ts` (#887), which this suite
 * deliberately does not touch or extend.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKER = path.join(import.meta.dir, 'question-store-trace-worker.ts');

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

describe('question-trace callSite defaults survive the #888 QuestionStore extraction', () => {
  function makeTmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-question-store-trace-test-'));
  }

  test('add/evict/remove/clear all carry the pre-#888 SessionRegistry callSite names', async () => {
    const tmpHome = makeTmpHome();
    try {
      await runWorker(tmpHome);
      const lines = readTraceLines(tmpHome);

      // 9 adds, 1 of which also evicts (callSite gets the ':lru_eviction'
      // suffix), 1 explicit remove, 7 remaining cleared by clearQuestions.
      const adds = lines.filter((l) => l['action'] === 'add');
      const removes = lines.filter((l) => l['action'] === 'remove');
      expect(adds).toHaveLength(9);
      expect(removes).toHaveLength(1 + 1 + 7); // eviction + explicit remove + clear

      for (const a of adds) {
        expect(a['callSite']).toBe('SessionRegistry.addQuestion');
      }

      const evictions = removes.filter((r) => r['signal'] === 'lru_eviction');
      expect(evictions).toHaveLength(1);
      expect(evictions[0]?.['callSite']).toBe('SessionRegistry.addQuestion:lru_eviction');

      // throughFunnel is always true for a SessionRegistry-routed remove
      // (#808), so distinguish the explicit removeQuestion call from the
      // clearQuestions batch by callSite instead.
      const explicit = removes.filter((r) => r['callSite'] === 'SessionRegistry.removeQuestion');
      const cleared = removes.filter((r) => r['callSite'] === 'SessionRegistry.clearQuestions');
      expect(explicit).toHaveLength(1);
      expect(cleared).toHaveLength(7);

      // Every removal funnels through SessionRegistry (#808 invariant,
      // unchanged by #888).
      for (const r of removes) {
        expect(r['throughFunnel']).toBe(true);
      }

      // #934: every removal record carries the removed Question's own
      // `source` -- the field #920 needed to say which card produced a given
      // PTY write and could not, because it did not exist on the trace at
      // all. The worker constructs every question with source: 'pty'
      // specifically so this is a real threaded value, not a coincidental
      // default.
      for (const r of removes) {
        expect(r['questionSource']).toBe('pty');
      }

      // #934: every line (add and remove alike) is provenance-stamped.
      // This whole file runs inside a `Bun.spawn`'d worker that inherits
      // NODE_ENV=test from the parent `bun test` process (never stripped by
      // `runWorker`'s env-rebuild), so every line reads 'test' here --
      // proving the stamp fires for direct QuestionStore/SessionRegistry
      // calls, not just HTTP-POSTed hook traffic.
      for (const line of lines) {
        expect(line['provenance']).toBe('test');
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
