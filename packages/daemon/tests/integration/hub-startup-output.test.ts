import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { installFakeAgents } from '../helpers/fake-agent-clis.ts';
import { makeIsolatedDirs, spawnHub } from './hub-test-utils.ts';

for (const exitEarly of [false, true]) {
  test(`spawnHub preserves bounded diagnostics after ${exitEarly ? 'early exit' : 'killing a stalled launcher'}`, async () => {
    const dirs = makeIsolatedDirs();
    const agents = installFakeAgents(dirs.home, {});
    const launcher = path.join(dirs.work, 'owned-launcher.ts');
    const record = path.join(dirs.work, 'launcher-process.json');
    // This controlled subprocess tests the real helper's failure boundary. It
    // deliberately never writes readiness; it does not simulate hub behavior.
    fs.writeFileSync(
      launcher,
      `import * as fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid: process.pid, execPath: process.execPath, bunVersion: Bun.version}));
console.log('STDOUT_HEAD_' + 'x'.repeat(2048) + 'OWNED_STDOUT_TAIL');
console.error('STDERR_HEAD_' + 'y'.repeat(2048) + 'OWNED_STDERR_TAIL');
${exitEarly ? 'process.exit(7);' : 'await new Promise(() => { setInterval(() => {}, 1000); });'}
`,
      { mode: 0o600 },
    );
    try {
      let message = '';
      try {
        // Only this intentionally stalled fixture uses a short deadline. The
        // helper's ordinary 15-second readiness deadline remains unchanged.
        await spawnHub(dirs, agents.env, launcher, undefined, 200);
      } catch (error) {
        message = (error as Error).message;
      }
      const child = JSON.parse(fs.readFileSync(record, 'utf8')) as {
        pid: number;
        execPath: string;
        bunVersion: string;
      };
      expect(child.bunVersion, 'launcher must use the runner Bun version').toBe(Bun.version);
      expect(fs.realpathSync(child.execPath)).toBe(fs.realpathSync(process.execPath));
      let alive = true;
      try {
        process.kill(child.pid, 0);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
        alive = false;
      }
      expect(alive, 'failed launcher must be killed and awaited before rejection').toBe(false);
      expect(message).toStartWith(
        exitEarly ? 'Hub exited early with code 7' : 'Timed out waiting for hub status file',
      );
      expect(message, 'failure must retain the actual stdout diagnostic tail').toContain(
        'OWNED_STDOUT_TAIL',
      );
      expect(message, 'failure must retain the actual stderr diagnostic tail').toContain(
        'OWNED_STDERR_TAIL',
      );
      expect(message, 'diagnostic tails must have a fixed bound').not.toContain('STDOUT_HEAD_');
      expect(message, 'diagnostic tails must have a fixed bound').not.toContain('STDERR_HEAD_');
      expect(
        message.length,
        'combined failure diagnostics must remain bounded',
      ).toBeLessThanOrEqual(3200);
    } finally {
      fs.rmSync(dirs.home, { recursive: true, force: true });
      fs.rmSync(dirs.work, { recursive: true, force: true });
    }
  });
}
