/**
 * Tests that `HookServer`'s REMI_HOOK_DEBUG diagnostic dump stamps
 * `_provenance` on every line (#934).
 *
 * This is the exact scenario #934 describes: a test constructs a real
 * `HookServer` and POSTs a real HTTP request at it, indistinguishable from
 * Claude Code's own traffic by `handleRequest` -- except now the written
 * record says so itself. Real filesystem I/O, no mocks, a real subprocess
 * (mirrors `session/question-trace.test.ts`'s pattern): `HookServer` writes
 * to a path built from `os.homedir()`, which Bun resolves once at process
 * startup and will not pick up a later mutation of `process.env.HOME`
 * within this test process -- only a FRESH subprocess with `HOME` set in its
 * spawn env is redirected, which is also exactly what keeps this test from
 * ever touching the real `~/.remi/hook-diag.jsonl`.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKER = path.join(import.meta.dir, 'hook-diag-provenance-worker.ts');

function readDiagLines(home: string): Record<string, unknown>[] {
  const diagPath = path.join(home, '.remi', 'hook-diag.jsonl');
  if (!fs.existsSync(diagPath)) return [];
  return fs
    .readFileSync(diagPath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

async function runWorker(home: string, debugEnabled: boolean): Promise<void> {
  // Rebuild from scratch (rather than `delete`) so a disabled run can never
  // inherit REMI_HOOK_DEBUG from the parent test process's own env.
  const { REMI_HOOK_DEBUG: _inherited, ...rest } = process.env;
  const env = { ...rest, HOME: home, ...(debugEnabled ? { REMI_HOOK_DEBUG: '1' } : {}) };
  const proc = Bun.spawn(['bun', WORKER], { env, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`worker exited ${code}: ${stderr}`);
  }
}

describe('HookServer REMI_HOOK_DEBUG provenance stamp (#934)', () => {
  function makeTmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hook-diag-test-'));
  }

  test('disabled by default: REMI_HOOK_DEBUG unset writes no file', async () => {
    const tmpHome = makeTmpHome();
    try {
      await runWorker(tmpHome, false);
      expect(fs.existsSync(path.join(tmpHome, '.remi', 'hook-diag.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('REMI_HOOK_DEBUG=1 stamps _provenance: "test" on a test-originated POST', async () => {
    const tmpHome = makeTmpHome();
    try {
      await runWorker(tmpHome, true);
      const lines = readDiagLines(tmpHome);
      expect(lines).toHaveLength(1);
      const [record] = lines as [Record<string, unknown>];
      expect(record['hook_event_name']).toBe('Stop');
      expect(record['session_id']).toBe('test-session');
      // The discriminating assertion (#934): a record written by this test's
      // own HTTP POST carries _provenance: 'test', not 'live' -- the field
      // that lets a reader (and the corpus builder) tell it apart from a
      // real Claude Code capture without inspecting cwd/session_id at all.
      expect(record['_provenance']).toBe('test');
      expect(typeof record['_ts']).toBe('string');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
