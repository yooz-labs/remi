/** The actual owned TLS/PTY proof runs in a joined child, not a replacement transport. */
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('actual TLS sender retains nine native receipt and uncertain-disposal scenarios', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-tls-receipt-test-')));
  const root = resolve(import.meta.dir, '../../../..');
  const child = Bun.spawn(
    [process.execPath, '--no-env-file', 'scripts/terminal-view-tls-proof.ts'],
    {
      cwd: root,
      env: {
        HOME: home,
        REMI_HOME: join(home, 'state'),
        TMPDIR: home,
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 80000);
  let passed = false;
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, (stdout + stderr).slice(-5000));
    expect(stderr).toBe('');
    const data = JSON.parse(stdout);
    expect(data.status).toBe('passed');
    expect(data.version).toBe(Bun.version);
    expect(data.groups).toHaveLength(9);
    expect(
      data.groups.every(
        (group: { actualChildInputBytes: number }) => group.actualChildInputBytes === 0,
      ),
    ).toBe(true);
    assert.throws(
      () => process.kill(child.pid, 0),
      { code: 'ESRCH' },
      'TLS receipt proof process joined',
    );
    passed = true;
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    // Quarantined rows belonged to the now-dead proof child, never a personal process.
    if (passed) rmSync(home, { recursive: true, force: true });
  }
}, 90000);
