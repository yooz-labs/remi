/**
 * #729 end to end: a real process whose stdout is a log file opened for
 * append (as launchd and `remi start` open it) finds that file by its
 * descriptor and keeps it bounded while it runs, without reopening anything.
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

test('a process keeps the log file behind its own stdout bounded while it writes', async () => {
  const live = path.join(sandbox, 'remi-stdout.log');
  const script = `
    import { guardLogFiles, logFilesBehind } from ${JSON.stringify(ROTATION)};
    const files = logFilesBehind([1, 2], [${JSON.stringify(live)}]);
    process.stderr.write(JSON.stringify(files) + '\\n');
    const stop = guardLogFiles(files, { maxBytes: 4096, intervalMs: 20 });
    const line = 'x'.repeat(1023) + '\\n';
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      process.stdout.write(line);
      await Bun.sleep(5);
    }
    stop();
  `;
  const fd = fs.openSync(live, 'a');
  try {
    const child = Bun.spawn(['bun', '-e', script], { stdout: fd, stderr: 'pipe', cwd: sandbox });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(stderr.trim().split('\n')[0] ?? '[]')).toEqual([live]);
  } finally {
    fs.closeSync(fd);
  }
  // About 300 KB was written; the live file and both backups stay near the bound.
  expect(fs.existsSync(`${live}.1`)).toBe(true);
  expect(fs.statSync(live).size).toBeLessThan(64 * 1024);
  expect(fs.statSync(`${live}.1`).size).toBeLessThan(64 * 1024);
}, 30000);
