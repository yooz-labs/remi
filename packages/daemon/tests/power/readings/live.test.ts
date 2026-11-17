import { expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { readAssertions } from '../../../src/power/readings/assertions.ts';
import { readRootDomain } from '../../../src/power/readings/root-domain.ts';
import { readThermal } from '../../../src/power/readings/thermal.ts';

if (process.platform !== 'darwin') {
  test.skip('macOS-only: live pmset, ioreg and notifyutil readings', () => {});
} else {
  test('readRootDomain reads SleepDisabled', async () => {
    const reading = await readRootDomain();
    expect(['yes', 'no']).toContain(reading.sleepDisabled);
    expect(['open', 'closed', 'absent']).toContain(reading.clamshell);
  });

  test('readThermal reads a level', async () => {
    const reading = await readThermal();
    if (reading.kind !== 'ok') throw new Error(`thermal unknown: ${reading.reason}`);
    expect(['nominal', 'moderate', 'heavy', 'trapping', 'sleeping']).toContain(reading.level);
  });

  test('readAssertions parses this Mac with at least one holder', async () => {
    const reading = await readAssertions();
    if (reading.kind !== 'ok') throw new Error(`assertions unknown: ${reading.reason}`);
    expect(reading.holders.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(reading.systemWide).length).toBeGreaterThanOrEqual(1);
  });

  test('a caffeinate bound to a child this test owns is read back with that child as its target', async () => {
    let child: ChildProcess | undefined;
    let caffeinate: ChildProcess | undefined;
    try {
      child = spawn('/bin/sleep', ['60'], { shell: false, stdio: 'ignore' });
      const childPid = child.pid;
      if (childPid === undefined) throw new Error('sleep child has no pid');
      caffeinate = spawn('/usr/bin/caffeinate', ['-i', '-t', '10', '-w', String(childPid)], {
        shell: false,
        stdio: 'ignore',
      });
      const caffeinatePid = caffeinate.pid;
      if (caffeinatePid === undefined) throw new Error('caffeinate has no pid');

      const deadline = Date.now() + 8_000;
      let found: unknown;
      while (Date.now() < deadline && !found) {
        const reading = await readAssertions();
        if (reading.kind !== 'ok') throw new Error(`assertions unknown: ${reading.reason}`);
        found = reading.holders.find(
          (holder) =>
            holder.process === 'caffeinate' &&
            holder.type === 'PreventUserIdleSystemSleep' &&
            holder.createdForPid === childPid,
        );
        if (!found) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(found).toMatchObject({
        pid: caffeinatePid,
        process: 'caffeinate',
        type: 'PreventUserIdleSystemSleep',
        createdForPid: childPid,
      });
    } finally {
      caffeinate?.kill('SIGKILL');
      child?.kill('SIGKILL');
    }
  });
}
