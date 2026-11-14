import { expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId } from '@remi/shared';
import { MessageAPI } from '../../src/api/message-api.ts';
import type { AwakeConfig } from '../../src/config/config.ts';
import { AwakeHolder, type AwakeHolderResult } from '../../src/power/awake-holder.ts';
import { AwakeSession } from '../../src/power/awake-session.ts';

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

async function waitUntil(check: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The command name of a live pid, so cleanup never signals a reused pid. */
function commandOf(pid: number): string {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** Kill a caffeinate this test started (through a child) if it is still that caffeinate. */
function killOurCaffeinate(pid: number | undefined): void {
  if (pid === undefined || !isAlive(pid) || !commandOf(pid).endsWith('caffeinate')) return;
  process.kill(pid, 'SIGKILL');
}

const holderModuleUrl = new URL('../../src/power/awake-holder.ts', import.meta.url).href;

interface OwnerProcess {
  readonly child: ChildProcess;
  readonly ready: Promise<{ pid: number; holderPid: number }>;
  output(): string;
}

/** Run a holder-owning Bun program that prints `{pid, holderPid}` as its first line. */
function spawnOwner(program: string, env: Record<string, string> = {}): OwnerProcess {
  const child = spawn(process.execPath, ['-e', program], {
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...env },
  });
  let output = '';
  const ready = new Promise<{ pid: number; holderPid: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('holder owner did not become ready')), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(JSON.parse(output.slice(0, newline)) as { pid: number; holderPid: number });
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`holder owner exited before ready (${code})`));
    });
  });
  return { child, ready, output: () => output };
}

const sessionConfig: AwakeConfig = {
  level1: true,
  question_hold_minutes: 1,
  idle_grace_seconds: 1,
  stuck_busy_minutes: 1,
  ttl_minutes: 1,
};

/** The real holder, counting how often the session asks it to start. */
class CountingHolder extends AwakeHolder {
  starts = 0;

  override async start(): Promise<AwakeHolderResult> {
    this.starts += 1;
    return super.start();
  }
}

test('a non-darwin platform returns false without spawning anything', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'remi-awake-platform-'));
  const marker = join(directory, 'ran');
  const executable = join(directory, 'caffeinate');
  writeFileSync(executable, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(executable, 0o755);
  const holder = new AwakeHolder({ ttlSeconds: 60, executable, platform: 'linux' });
  try {
    expect(await holder.start()).toEqual({
      ok: false,
      failure: { kind: 'unsupported', platform: 'linux' },
    });
    expect(await holder.renew()).toEqual({
      ok: false,
      failure: { kind: 'unsupported', platform: 'linux' },
    });
    expect(holder.pid).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(marker)).toBe(false);
  } finally {
    holder.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

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
      expect(await holder.start()).toEqual({ ok: true });
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
      expect(await holder.start()).toEqual({ ok: true });
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
        if (!(await holder.start()).ok) process.exit(2);
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

  test('a normal exit of the holder owner releases the assertion through its exit handler', async () => {
    let target: ChildProcess | undefined;
    let owner: OwnerProcess | undefined;
    let holderPid: number | undefined;
    try {
      // -w is bound to a separate long-lived child, so only the exit handler can release it.
      target = await startSleepProcess();
      if (target.pid === undefined) throw new Error('sleep child has no pid');
      owner = spawnOwner(
        `
        import { AwakeHolder } from ${JSON.stringify(holderModuleUrl)};
        const holder = new AwakeHolder({ targetPid: Number(process.env.AWAKE_TARGET_PID), ttlSeconds: 60 });
        if (!(await holder.start()).ok) process.exit(2);
        process.stdout.write(JSON.stringify({ pid: process.pid, holderPid: holder.pid }) + '\\n');
        process.stdin.on('data', () => {});
        process.stdin.once('end', () => process.exit(0));
      `,
        { AWAKE_TARGET_PID: String(target.pid) },
      );
      const ready = await owner.ready;
      holderPid = ready.holderPid;
      await waitForAssertion(target.pid, true);
      console.info(
        `[AWAKE PGM] exit-handler owner=${ready.pid} target=${target.pid} caffeinate=${holderPid}`,
      );

      owner.child.stdin?.end();
      await waitForExit(owner.child);
      expect(owner.child.exitCode).toBe(0);
      await waitForAssertion(target.pid, false);
      await waitForPidToExit(holderPid);
      expect(isAlive(target.pid)).toBe(true);
    } finally {
      killOurCaffeinate(holderPid);
      if (owner && owner.child.exitCode === null && owner.child.signalCode === null) {
        owner.child.kill('SIGKILL');
      }
      if (owner) await waitForExit(owner.child);
      if (target && target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
      if (target) await waitForExit(target);
    }
  });

  test('a SIGINT that the holder owner handles does not release the hold', async () => {
    let owner: OwnerProcess | undefined;
    let holderPid: number | undefined;
    try {
      owner = spawnOwner(`
        import { AwakeHolder } from ${JSON.stringify(holderModuleUrl)};
        const holder = new AwakeHolder({ targetPid: process.pid, ttlSeconds: 60 });
        if (!(await holder.start()).ok) process.exit(2);
        // Wrapper mode forwards SIGINT to the PTY and keeps running.
        process.on('SIGINT', () => process.stdout.write('sigint handled\\n'));
        process.on('SIGTERM', () => process.exit(0));
        process.stdout.write(JSON.stringify({ pid: process.pid, holderPid: holder.pid }) + '\\n');
        setInterval(() => {}, 1000);
      `);
      const ready = await owner.ready;
      holderPid = ready.holderPid;
      await waitForAssertion(ready.pid, true);

      owner.child.kill('SIGINT');
      await waitUntil(
        () => owner?.output().includes('sigint handled') === true,
        'the SIGINT handler',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(assertionOutput()).toContain(`Created for PID: ${ready.pid}`);
      expect(isAlive(holderPid)).toBe(true);
      console.info(
        `[AWAKE PGM] sigint owner=${ready.pid} caffeinate=${holderPid} alive after SIGINT`,
      );

      owner.child.kill('SIGTERM');
      await waitForExit(owner.child);
      await waitForAssertion(ready.pid, false);
      await waitForPidToExit(holderPid);
    } finally {
      killOurCaffeinate(holderPid);
      if (owner && owner.child.exitCode === null && owner.child.signalCode === null) {
        owner.child.kill('SIGKILL');
      }
      if (owner) await waitForExit(owner.child);
    }
  });

  test('a killed caffeinate is restarted, and after a release new work holds again', async () => {
    let target: ChildProcess | undefined;
    let holder: AwakeHolder | undefined;
    let awake: AwakeSession | undefined;
    const started: number[] = [];
    try {
      target = await startSleepProcess();
      const targetPid = target.pid;
      if (targetPid === undefined) throw new Error('sleep child has no pid');
      const messageApi = new MessageAPI({ sessionId: generateId() });
      const logs: string[] = [];
      awake = new AwakeSession(generateId(), messageApi, sessionConfig, (m) => logs.push(m), {
        createHolder: (onUnexpectedExit) => {
          holder = new AwakeHolder({ targetPid, ttlSeconds: 60, onUnexpectedExit });
          return holder;
        },
        retryDelaysMs: [100, 200, 400],
      });
      messageApi.handleStatusChange('executing');
      await waitUntil(() => awake?.isHolding === true, 'the first hold');
      const first = holder?.pid ?? null;
      if (first === null) throw new Error('no caffeinate pid');
      started.push(first);
      await waitForAssertion(targetPid, true);

      process.kill(first, 'SIGKILL');
      await waitUntil(
        () => holder?.pid !== null && holder?.pid !== first,
        'the replacement caffeinate',
      );
      const second = holder?.pid ?? null;
      if (second === null) throw new Error('no replacement pid');
      started.push(second);
      await waitForPidToExit(first);
      await waitForAssertion(targetPid, true);
      expect(awake.isHolding).toBe(true);
      expect(logs.filter((m) => m.includes('killed by SIGKILL'))).toHaveLength(1);

      messageApi.handleStatusChange('idle');
      await waitUntil(() => awake?.isHolding === false, 'the release after grace', 3_000);
      await waitForAssertion(targetPid, false);
      messageApi.handleStatusChange('executing');
      await waitUntil(() => awake?.isHolding === true, 'the next hold');
      const third = holder?.pid ?? null;
      if (third === null) throw new Error('no caffeinate for the next hold');
      started.push(third);
      await waitForAssertion(targetPid, true);
      console.info(`[AWAKE PGM] restarted caffeinate pids: ${started.join(', ')}`);
    } finally {
      awake?.dispose();
      for (const pid of started) await waitForPidToExit(pid);
      if (target && target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
      if (target) await waitForExit(target);
    }
  });

  test('a caffeinate that keeps exiting is retried three times, then waits for the next hold', async () => {
    const messageApi = new MessageAPI({ sessionId: generateId() });
    const logs: string[] = [];
    let holder: CountingHolder | undefined;
    const awake = new AwakeSession(generateId(), messageApi, sessionConfig, (m) => logs.push(m), {
      createHolder: (onUnexpectedExit) => {
        holder = new CountingHolder({
          ttlSeconds: 60,
          executable: '/usr/bin/false',
          onUnexpectedExit,
        });
        return holder;
      },
      retryDelaysMs: [10, 20, 40],
    });
    try {
      messageApi.handleStatusChange('executing');
      await waitUntil(() => holder?.starts === 4, 'four start attempts');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(holder?.starts).toBe(4);
      expect(awake.isHolding).toBe(false);
      expect(logs.filter((m) => m.includes('restarting it up to 3 times'))).toHaveLength(1);
      expect(logs.some((m) => m.includes('caffeinate unavailable'))).toBe(false);

      messageApi.handleStatusChange('idle');
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      messageApi.handleStatusChange('executing');
      await waitUntil(() => (holder?.starts ?? 0) >= 5, 'a start at the next hold');
      await waitUntil(
        () => logs.filter((m) => m.includes('restarting it up to 3 times')).length === 2,
        'the second episode log',
      );
    } finally {
      awake.dispose();
    }
  });

  test('EACCES on spawn latches the hold off with a log that names the cause', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'remi-awake-eacces-'));
    const executable = join(directory, 'caffeinate');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o644);
    const messageApi = new MessageAPI({ sessionId: generateId() });
    const logs: string[] = [];
    let holder: CountingHolder | undefined;
    const awake = new AwakeSession(generateId(), messageApi, sessionConfig, (m) => logs.push(m), {
      createHolder: (onUnexpectedExit) => {
        holder = new CountingHolder({ ttlSeconds: 60, executable, onUnexpectedExit });
        return holder;
      },
      retryDelaysMs: [10, 20, 40],
    });
    try {
      messageApi.handleStatusChange('executing');
      await waitUntil(
        () => logs.some((m) => m.includes('caffeinate unavailable')),
        'the unavailable log',
      );
      expect(logs.filter((m) => m.includes('caffeinate unavailable'))).toEqual([
        expect.stringContaining('(EACCES); hold disabled'),
      ]);
      messageApi.handleStatusChange('thinking');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(holder?.starts).toBe(1);
      expect(awake.isHolding).toBe(false);
    } finally {
      awake.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
