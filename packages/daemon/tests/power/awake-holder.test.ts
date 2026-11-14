import { expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { AwakeHolder } from '../../src/power/awake-holder.ts';

function startSleepProcess(): Promise<ChildProcess> {
  const child = spawn('/bin/sleep', ['120'], { shell: false, stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

function pgrepChildren(executableName: string, parentPid = process.pid): string {
  const result = spawnSync('/usr/bin/pgrep', ['-P', String(parentPid), '-x', executableName], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '<none>';
}

const pgrepCaffeinateChildren = (parentPid = process.pid): string =>
  pgrepChildren('caffeinate', parentPid);
const pgrepSleepChildren = (parentPid = process.pid): string => pgrepChildren('sleep', parentPid);

function assertionOutput(): string {
  const result = spawnSync('/usr/bin/pmset', ['-g', 'assertions'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error(`pmset -g assertions failed (${result.status})`);
  return result.stdout;
}

async function waitForAssertion(pid: number, present: boolean): Promise<string> {
  const deadline = Date.now() + 8_000;
  let output = '';
  while (Date.now() < deadline) {
    output = assertionOutput();
    const found = output.includes(`Created for PID: ${pid}`);
    if (found === present) return output;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for assertion ${present ? 'to appear' : 'to disappear'} for PID ${pid}`,
  );
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function waitForPidToExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} remained after its holder was released`);
}

if (process.platform !== 'darwin') {
  test.skip('macOS-only: real caffeinate and pmset process-boundary checks', () => {});
} else {
  test('real caffeinate assertion appears for the child PID and disappears on release', async () => {
    let target: ChildProcess | undefined;
    let holder: AwakeHolder | undefined;
    try {
      const before = pgrepCaffeinateChildren();
      const sleepBefore = pgrepSleepChildren();
      console.info(`[AWAKE PGM] pgrep sleep before: ${sleepBefore}`);
      target = await startSleepProcess();
      if (target.pid === undefined) throw new Error('sleep child has no pid');
      expect(pgrepSleepChildren()).toBe(String(target.pid));
      holder = new AwakeHolder({ targetPid: target.pid, ttlSeconds: 60 });
      expect(await holder.start()).toBe(true);
      const holderPid = holder.pid;
      if (holderPid === null) throw new Error('caffeinate holder has no pid');
      const active = await waitForAssertion(target.pid, true);
      expect(active).toContain('PreventUserIdleSystemSleep');
      console.info(`[AWAKE PGM] pgrep before: ${before}`);
      console.info(`[AWAKE PGM] pgrep active: ${pgrepCaffeinateChildren()}`);
      console.info(`[AWAKE PGM] pgrep sleep active: ${pgrepSleepChildren()}`);
      console.info(`[AWAKE PGM] target=${target.pid} caffeinate=${holderPid}`);

      holder.release();
      await waitForAssertion(target.pid, false);
      await waitForPidToExit(holderPid);
      const after = pgrepCaffeinateChildren();
      console.info(`[AWAKE PGM] pgrep after release: ${after}`);
      expect(after).not.toContain(String(holderPid));
    } finally {
      holder?.dispose();
      if (target && target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
      if (target) await waitForExit(target);
      console.info(
        `[AWAKE PGM] pgrep after cleanup: caffeinate=${pgrepCaffeinateChildren()} sleep=${pgrepSleepChildren()}`,
      );
    }
  });

  test('SIGKILL of the target child releases its real caffeinate assertion', async () => {
    let target: ChildProcess | undefined;
    let holder: AwakeHolder | undefined;
    try {
      const before = pgrepCaffeinateChildren();
      console.info(`[AWAKE PGM] pgrep before target spawn: ${before}`);
      console.info(`[AWAKE PGM] pgrep sleep before target spawn: ${pgrepSleepChildren()}`);
      target = await startSleepProcess();
      if (target.pid === undefined) throw new Error('sleep child has no pid');
      expect(pgrepSleepChildren()).toBe(String(target.pid));
      holder = new AwakeHolder({ targetPid: target.pid, ttlSeconds: 60 });
      expect(await holder.start()).toBe(true);
      const holderPid = holder.pid;
      if (holderPid === null) throw new Error('caffeinate holder has no pid');
      await waitForAssertion(target.pid, true);
      console.info(`[AWAKE PGM] pgrep before target kill: ${pgrepCaffeinateChildren()}`);
      console.info(`[AWAKE PGM] target=${target.pid} caffeinate=${holderPid}`);

      target.kill('SIGKILL');
      await waitForExit(target);
      await waitForAssertion(target.pid, false);
      await waitForPidToExit(holderPid);
      const after = pgrepCaffeinateChildren();
      console.info(`[AWAKE PGM] pgrep after target kill: ${after}`);
      console.info(`[AWAKE PGM] pgrep sleep after target kill: ${pgrepSleepChildren()}`);
      expect(after).not.toContain(String(holderPid));
    } finally {
      holder?.dispose();
      if (target && target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
      if (target) await waitForExit(target);
    }
  });

  test('SIGTERM of the holder parent kills its caffeinate child', async () => {
    let parent: ChildProcess | undefined;
    let holderPid: number | undefined;
    try {
      const moduleUrl = new URL('../../src/power/awake-holder.ts', import.meta.url).href;
      const program = `
        import { AwakeHolder } from ${JSON.stringify(moduleUrl)};
        const holder = new AwakeHolder({ targetPid: process.pid, ttlSeconds: 60 });
        if (!(await holder.start())) process.exit(2);
        process.stdout.write(JSON.stringify({ pid: process.pid, holderPid: holder.pid }) + '\\n');
        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
      `;
      parent = spawn(process.execPath, ['-e', program], {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ready = await new Promise<{ pid: number; holderPid: number }>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(
          () => reject(new Error('holder child did not become ready')),
          5_000,
        );
        parent?.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          const newline = output.indexOf('\n');
          if (newline < 0) return;
          clearTimeout(timeout);
          resolve(JSON.parse(output.slice(0, newline)) as { pid: number; holderPid: number });
        });
        parent?.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        parent?.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`holder child exited before ready (${code})`));
        });
      });
      holderPid = ready.holderPid;
      if (!parent.pid || ready.pid !== parent.pid || holderPid <= 0) {
        throw new Error('holder child reported an invalid process id');
      }
      await waitForAssertion(ready.pid, true);
      console.info(
        `[AWAKE PGM] pgrep holder child before SIGTERM: ${pgrepCaffeinateChildren(ready.pid)}`,
      );

      parent.kill('SIGTERM');
      await waitForExit(parent);
      await waitForAssertion(ready.pid, false);
      await waitForPidToExit(holderPid);
      const after = pgrepCaffeinateChildren(ready.pid);
      console.info(`[AWAKE PGM] pgrep holder child after SIGTERM: ${after}`);
      expect(after).not.toContain(String(holderPid));
    } finally {
      if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      if (parent) await waitForExit(parent);
    }
  });
}
