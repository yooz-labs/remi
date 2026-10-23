/** Characterizes the actual pinned upstream BufferLine source; no production engine selection. */
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareOriginalEngine,
  writeOriginalBufferTests,
} from '../../../../scripts/terminal-engine/source';

test('pinned upstream buffer source passes its original 49 real buffer cases', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'remi-engine-source-')));
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    prepareOriginalEngine(home);
    const file = writeOriginalBufferTests(home);
    child = Bun.spawn([process.execPath, '--no-env-file', 'test', file], {
      cwd: home,
      env: {
        HOME: home,
        REMI_HOME: join(home, 'state'),
        TMPDIR: home,
        LANG: 'en_US.UTF-8',
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    watchdog = setTimeout(() => child?.kill('SIGKILL'), 7000);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, (stdout + stderr).slice(-4000));
    const plain = (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toMatch(/\b49 pass\b/);
    expect(plain).toMatch(/\b0 fail\b/);
    const childPid = child.pid;
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally {
    clearTimeout(watchdog);
    if (child?.exitCode === null) child.kill('SIGKILL');
    if (child) await child.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);
