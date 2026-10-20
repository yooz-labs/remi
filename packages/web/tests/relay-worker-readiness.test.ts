/** Actual Miniflare startup failure at the OS executable boundary must close its listeners. */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real Worker readiness failure disposes Miniflare listeners before rejecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remi1199-worker-readiness-'));
  const receipt = join(dir, 'receipt.json');
  const source = join(dir, 'probe.ts');
  const failingRuntime = join(dir, 'failing-runtime');
  writeFileSync(failingRuntime, '#!/bin/sh\n/bin/cat > /dev/null\nexit 1\n', { mode: 0o700 });
  const harness = join(import.meta.dir, '../../signaling/tests/e2e/harness.ts');
  writeFileSync(
    source,
    `
    import { writeFileSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
    import { startWorker } from ${JSON.stringify(harness)};
    function listeners() {
      if (process.platform === 'linux') {
        const inodes = new Set();
        for (const fd of readdirSync('/proc/self/fd')) {
          try { const match = readlinkSync('/proc/self/fd/' + fd).match(/^socket:\\[(\\d+)\\]$/); if (match) inodes.add(match[1]); }
          catch { /* a descriptor closed between enumeration and readlink */ }
        }
        return ['tcp', 'tcp6'].flatMap(name => readFileSync('/proc/self/net/' + name, 'utf8').trim().split('\\n').slice(1))
          .filter(line => { const fields = line.trim().split(/\\s+/); return fields[3] === '0A' && inodes.has(fields[9]); }).length;
      }
      const scan = Bun.spawnSync([${JSON.stringify(process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof')}, '-a', '-p', String(process.pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
      if (![0, 1].includes(scan.exitCode) || scan.stderr.toString().trim()) throw new Error('Owned listener scan failed');
      return scan.stdout.toString().split('\\n').filter(line => line.startsWith('n')).length;
    }
    const before = listeners();
    let rejected = false;
    try { await startWorker(); } catch { rejected = true; }
    writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ rejected, before, after: listeners() }));
    process.exit(0);
  `,
  );
  // The real OS child consumes startup config then fails before emitting readiness.
  const runner = Bun.spawn([process.execPath, source], {
    cwd: join(import.meta.dir, '../../..'),
    env: {
      HOME: dir,
      PATH: '/usr/bin:/bin',
      E2E_BUNDLER: 'esbuild',
      MINIFLARE_WORKERD_PATH: failingRuntime,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = Promise.all([
    new Response(runner.stdout).text(),
    new Response(runner.stderr).text(),
  ]);
  const timer = setTimeout(() => runner.kill('SIGTERM'), 10000);
  try {
    expect(await runner.exited).toBe(0);
    await output;
    const result = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(result.rejected).toBe(true);
    expect(result.after).toBe(result.before);
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
