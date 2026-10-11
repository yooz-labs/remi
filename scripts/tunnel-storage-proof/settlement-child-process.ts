// Owned subprocess harness: bounded raw diagnostics and exact death/reaping, including failures.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';

export type ChildReceipt = {
  pid: number;
  exit: number;
  signal: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  awaitedExit: boolean;
  missingAfterExit: boolean;
  stdout: string;
  stderr: string;
};
const executable = () =>
  Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, '--no-env-file', Bun.main];

export async function settlementProcess(
  args: string[],
  children: ChildReceipt[],
  killStage?: string,
  contention?: (pid: number) => Promise<void>,
): Promise<string> {
  const proc = Bun.spawn([...executable(), '--owned-spike', '--settlement-child', ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: os.tmpdir() },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = proc.stdout.getReader();
  let output = '';
  let detail = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let awaitedExit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stderr = (async () => {
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stderrBytes += chunk.value.byteLength;
        if (stderrBytes > 8192) {
          proc.kill('SIGKILL');
          throw new Error('settlement stderr overflow');
        }
        detail += Buffer.from(chunk.value).toString();
      }
      return null;
    } catch (error) {
      return error;
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  })();
  const read = async () => {
    const chunk = await reader.read();
    if (!chunk.done) {
      stdoutBytes += chunk.value.byteLength;
      if (stdoutBytes > 4096) {
        proc.kill('SIGKILL');
        throw new Error('settlement stdout overflow');
      }
      output += Buffer.from(chunk.value).toString();
    }
    return chunk.done;
  };
  const work = (async () => {
    if (killStage) {
      while (!output.includes('\n')) assert(!(await read()), 'settlement child reached checkpoint');
      const checkpoint = JSON.parse(output.trim());
      assert.equal(checkpoint.checkpoint, killStage, 'settlement actual checkpoint');
      assert.equal(checkpoint.pid, proc.pid, 'settlement actual owned PID');
      await contention?.(proc.pid);
      proc.kill('SIGKILL');
    }
    while (!(await read())) {
      /* bounded owned output */
    }
    const exit = await proc.exited;
    awaitedExit = true;
    assert.equal(await stderr, null, 'settlement bounded stderr');
    assert.equal(exit, killStage ? 137 : 0, `settlement child exit: ${detail}`);
    assert.equal(proc.signalCode, killStage ? 'SIGKILL' : null, 'settlement exact child signal');
    return output;
  })();
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('settlement child deadline')), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!awaitedExit) proc.kill('SIGKILL');
    const exit = await proc.exited;
    awaitedExit = true;
    await Promise.allSettled([work, stderr]);
    let missingAfterExit = false;
    try {
      process.kill(proc.pid, 0);
    } catch (error) {
      missingAfterExit = (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    const receipt = {
      pid: proc.pid,
      exit,
      signal: proc.signalCode,
      stdoutBytes,
      stderrBytes,
      awaitedExit,
      missingAfterExit,
      stdout: output,
      stderr: detail,
    };
    children.push(receipt);
    fs.writeSync(1, `${JSON.stringify({ ownedSettlementChild: receipt })}\n`);
    await reader.cancel();
    reader.releaseLock();
    assert(missingAfterExit, 'settlement child awaited and ESRCH');
  }
}
