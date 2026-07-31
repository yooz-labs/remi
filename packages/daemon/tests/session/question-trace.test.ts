/**
 * Tests for the opt-in question-lifecycle trace (#808).
 *
 * Real filesystem I/O, no mocks, real subprocesses (mirrors the pattern in
 * `session-store-concurrency.test.ts`): `os.homedir()` in Bun is resolved
 * once at process startup, so pointing the trace module at a throwaway
 * directory requires a FRESH subprocess with `HOME` set in its spawn env —
 * mutating `process.env.HOME` inside this test process has no effect on
 * `os.homedir()`. This also means the real behavior (HOME as set by the
 * caller's shell/service-manager) is exactly what gets exercised.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKER = path.join(import.meta.dir, 'question-trace-worker.ts');

function readTraceLines(home: string): Record<string, unknown>[] {
  const tracePath = path.join(home, '.remi', 'question-trace.jsonl');
  if (!fs.existsSync(tracePath)) return [];
  return fs
    .readFileSync(tracePath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

async function runWorker(home: string, traceEnabled: boolean): Promise<number> {
  // Rebuild from scratch (rather than `delete`) so a disabled run can never
  // inherit REMI_QUESTION_TRACE from the parent test process's own env.
  const { REMI_QUESTION_TRACE: _inherited, ...rest } = process.env;
  const env = { ...rest, HOME: home, ...(traceEnabled ? { REMI_QUESTION_TRACE: '1' } : {}) };
  const proc = Bun.spawn(['bun', WORKER], { env, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`worker exited ${code}: ${stderr}`);
  }
  return code;
}

describe('traceQuestionEvent (#808)', () => {
  function makeTmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-question-trace-test-'));
  }

  test('disabled by default: REMI_QUESTION_TRACE unset writes no file', async () => {
    const tmpHome = makeTmpHome();
    try {
      await runWorker(tmpHome, false);
      expect(fs.existsSync(path.join(tmpHome, '.remi', 'question-trace.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('REMI_QUESTION_TRACE=1 appends one JSONL record per call, with the given fields', async () => {
    const tmpHome = makeTmpHome();
    try {
      await runWorker(tmpHome, true);
      const lines = readTraceLines(tmpHome);
      expect(lines).toHaveLength(2);

      const [added, removed] = lines as [Record<string, unknown>, Record<string, unknown>];
      expect(added).toMatchObject({
        action: 'add',
        sessionId: 'session-1',
        questionId: 'question-1',
        signal: 'permission_request',
      });
      expect(typeof added['ts']).toBe('string');
      expect(Number.isNaN(Date.parse(added['ts'] as string))).toBe(false);
      // #934: this worker runs as a `Bun.spawn`'d subprocess that inherits
      // NODE_ENV=test from the parent `bun test` process (runWorker's env
      // rebuild only strips REMI_QUESTION_TRACE, nothing else), so the
      // provenance stamp reads 'test' here -- the field a reader/corpus
      // filters on to exclude exactly this kind of synthetic record.
      expect(added['provenance']).toBe('test');

      expect(removed).toMatchObject({
        action: 'remove',
        sessionId: 'session-1',
        questionId: 'question-1',
        agentId: 'agent-1',
        isSubagent: true,
        toolName: 'Bash',
        signal: 'PostToolUse-subagent',
        throughFunnel: true,
      });
      expect(removed['provenance']).toBe('test');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('a write failure (unwritable ~/.remi) is swallowed, never crashes the process', async () => {
    const tmpHome = makeTmpHome();
    try {
      // Pre-create ~/.remi as a FILE (not a directory) so mkdirSync/appendFileSync
      // both fail with a real filesystem error -- no mocking of fs needed.
      fs.writeFileSync(path.join(tmpHome, '.remi'), 'not a directory');
      const code = await runWorker(tmpHome, true);
      expect(code).toBe(0);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
