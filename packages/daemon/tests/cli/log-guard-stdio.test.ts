/**
 * #729 end to end: a real process whose stdout is a log file opened for
 * append (as launchd and `remi start` open it) finds that file by its
 * descriptor and keeps it bounded while it runs, without reopening anything;
 * one whose stdout was opened without append leaves the file alone (#1262
 * review). The child is this same Bun (`process.execPath`), so a matrix run
 * tests each version's stdout.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROTATION = path.join(import.meta.dir, '../../src/cli/log-rotation.ts');

let sandbox: string;
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-log-guard-stdio-'));
});
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writerScript(live: string): string {
  return `
    import { guardLogFiles, planStdioLogGuard } from ${JSON.stringify(ROTATION)};
    const plan = planStdioLogGuard([1, 2], [${JSON.stringify(live)}]);
    process.stderr.write(JSON.stringify(plan) + '\\n');
    const stop = guardLogFiles(plan.guarded, { maxBytes: 4096, intervalMs: 20 });
    const line = 'x'.repeat(1023) + '\\n';
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      process.stdout.write(line);
      await Bun.sleep(5);
    }
    stop();
  `;
}

/** Run the writer with its stdout on `live`, opened with `flags`; returns its plan. */
async function runWriter(
  live: string,
  flags: string,
): Promise<{ guarded: string[]; notices: string[] }> {
  const fd = fs.openSync(live, flags);
  try {
    const child = Bun.spawn([process.execPath, '-e', writerScript(live)], {
      stdout: fd,
      stderr: 'pipe',
      cwd: sandbox,
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(stderr.trim().split('\n')[0] ?? '{}');
  } finally {
    fs.closeSync(fd);
  }
}

test('a process keeps the log file behind its own stdout bounded while it writes', async () => {
  const live = path.join(sandbox, 'remi-stdout.log');
  expect((await runWriter(live, 'a')).guarded).toEqual([live]);
  // About 300 KB was written; the live file and both backups stay near the bound.
  expect(fs.existsSync(`${live}.1`)).toBe(true);
  expect(fs.statSync(live).size).toBeLessThan(64 * 1024);
  expect(fs.statSync(`${live}.1`).size).toBeLessThan(64 * 1024);
}, 30000);

test('a process whose stdout was opened without append leaves the file alone', async () => {
  const live = path.join(sandbox, 'daemon.log');
  const plan = await runWriter(live, 'w');
  expect(plan.guarded).toEqual([]);
  expect(plan.notices).toHaveLength(1);
  // Never truncated: no NUL padding, and all of it is still there.
  expect(fs.existsSync(`${live}.1`)).toBe(false);
  const content = fs.readFileSync(live);
  expect(content.length).toBeGreaterThan(64 * 1024);
  expect(content.includes(0)).toBe(false);
}, 30000);
