import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { runChild } from '../../../../scripts/ci/run-bun-test-with-diagnostics';

function sink() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return {
    stream,
    text: () => Buffer.concat(chunks).toString('utf8'),
    bytes: () => Buffer.concat(chunks),
  };
}

function bun(code: string): string[] {
  return [process.execPath, '-e', code];
}

test('forwards child stdout and stderr bytes unchanged and returns success', async () => {
  const out = sink();
  const err = sink();
  const code =
    "process.stdout.write(Buffer.from([0xff,0x00,0x41])); process.stderr.write('child-stderr\\n');";
  const result = await runChild(bun(code), {
    stdout: out.stream,
    stderr: err.stream,
  });

  expect(result.exitCode).toBe(0);
  expect([...out.bytes()]).toEqual([0xff, 0x00, 0x41]);
  expect(err.text()).toBe('child-stderr\n');
});

test('preserves a nonzero child exit code', async () => {
  const out = sink();
  const err = sink();
  const result = await runChild(bun("process.stdout.write('finished'); process.exit(23);"), {
    stdout: out.stream,
    stderr: err.stream,
  });

  expect(result.exitCode).toBe(23);
  expect(out.text()).toBe('finished');
  expect(err.text()).toBe('');
});

test('reports bounded proc metadata while a child is quiet', async () => {
  const out = sink();
  const err = sink();
  const stdoutPayload = 'quiet-child-stdout\n';
  const stderrPayload = 'packages/daemon/tests/cli/quiet.test.ts:\nquiet-child-stderr\n';
  const code = `process.stdout.write(${JSON.stringify(stdoutPayload)}); process.stderr.write(${JSON.stringify(stderrPayload)}); await Bun.sleep(280);`;
  const result = await runChild(bun(code), {
    stdout: out.stream,
    stderr: err.stream,
    diagnosticAfterMs: 40,
    diagnosticEveryMs: 40,
  });
  // Slow startup can produce earlier samples before the controlled header.
  // Require a genuine quiet-period sample after that header was observed.
  const diagnosticLines = err
    .text()
    .split('\n')
    .filter((line) => line.startsWith('[ci-test-diagnostic] '));
  const record = diagnosticLines
    .map((line) => JSON.parse(line.slice('[ci-test-diagnostic] '.length)))
    .find((sample) => sample.lastTestFile === 'packages/daemon/tests/cli/quiet.test.ts');

  expect(result.exitCode).toBe(0);
  expect(out.text()).toBe(stdoutPayload);
  expect(err.text()).toContain(stderrPayload);
  expect(record).toBeDefined();
  if (!record) throw new Error('quiet child emitted no diagnostic after its controlled header');
  expect(record.childPid).toEqual(expect.any(Number));
  expect(record.wrapperPid).toEqual(process.pid);
  expect(record.lastTestFile).toBe('packages/daemon/tests/cli/quiet.test.ts');
  expect(record.quietMs).toBeGreaterThanOrEqual(40);
  expect(record.streams.stdout).toEqual({
    bytesRead: Buffer.byteLength(stdoutPayload),
    bytesForwarded: Buffer.byteLength(stdoutPayload),
    pendingWriteBytes: 0,
    pendingWriteAgeMs: null,
    callbackPending: false,
    callbackWaitMs: null,
    drainPending: false,
    drainWaitMs: null,
  });
  expect(record.streams.stderr).toEqual({
    bytesRead: Buffer.byteLength(stderrPayload),
    bytesForwarded: Buffer.byteLength(stderrPayload),
    pendingWriteBytes: 0,
    pendingWriteAgeMs: null,
    callbackPending: false,
    callbackWaitMs: null,
    drainPending: false,
    drainWaitMs: null,
  });
  expect(diagnosticLines[0]).not.toContain(stdoutPayload);
  expect(diagnosticLines[0]).not.toContain('quiet-child-stderr');
  if (process.platform === 'linux') {
    expect(record.process.available).toBe(true);
    expect(record.process.state).toMatch(/^[RSDZTWtXxKWPPI]$/);
    expect(record.process.cpuTicks).toEqual(expect.any(Number));
    expect(record.process.threads).toBeGreaterThanOrEqual(1);
    expect(record.process.rssPages).toBeGreaterThanOrEqual(0);
    expect(record.wrapperProcess.available).toBe(true);
    expect(record.wrapperProcess.state).toMatch(/^[RSDZTWtXxKWPPI]$/);
    expect(record.wrapperProcess.cpuTicks).toEqual(expect.any(Number));
    expect(record.wrapperProcess.threads).toBeGreaterThanOrEqual(1);
    expect(record.wrapperProcess.rssPages).toBeGreaterThanOrEqual(0);
  } else {
    expect(record.process).toEqual({
      available: false,
      reason: 'unsupported',
      cpuDeltaTicks: null,
    });
    expect(record.wrapperProcess).toEqual({
      available: false,
      reason: 'unsupported',
      cpuDeltaTicks: null,
    });
  }
});

for (const actions of [false, true]) {
  test(`captures the real Bun stderr test header (GitHub Actions=${actions})`, async () => {
    expect(Bun.which('env')).toBeTruthy();
    const out = sink();
    const err = sink();
    const testFile = 'packages/daemon/tests/session-name.test.ts';
    const environment = actions ? ['GITHUB_ACTIONS=true'] : ['-u', 'GITHUB_ACTIONS'];
    const result = await runChild(['env', ...environment, process.execPath, 'test', testFile], {
      stdout: out.stream,
      stderr: err.stream,
      diagnosticAfterMs: 80,
      diagnosticEveryMs: 80,
    });

    expect(result.exitCode).toBe(0);
    expect(result.lastTestFile).toBe(testFile);
    expect(err.text()).toContain(`${testFile}:`);
    if (actions) expect(err.text()).toContain(`::group::${testFile}:`);
    else expect(err.text()).not.toContain('::group::');
  });
}

test('reports CPU ticks for an actual busy child without changing its exit', async () => {
  const out = sink();
  const err = sink();
  const code = 'const until=Date.now()+650; while(Date.now()<until) {}';
  const result = await runChild(bun(code), {
    stdout: out.stream,
    stderr: err.stream,
    diagnosticAfterMs: 60,
    diagnosticEveryMs: 100,
  });
  const records = err
    .text()
    .split('\n')
    .filter((line) => line.startsWith('[ci-test-diagnostic] '))
    .map((line) => JSON.parse(line.slice('[ci-test-diagnostic] '.length)));

  expect(result.exitCode).toBe(0);
  expect(records.length).toBeGreaterThan(0);
  if (process.platform === 'linux') {
    expect(
      records.some(
        (record) =>
          record.process.available &&
          record.process.cpuDeltaTicks !== null &&
          record.process.cpuDeltaTicks > 0,
      ),
    ).toBe(true);
  } else {
    expect(
      records.every(
        (record) =>
          record.process.reason === 'unsupported' && record.process.cpuDeltaTicks === null,
      ),
    ).toBe(true);
  }
});

test('wrapper cancellation forwards the signal then kills a stubborn owned child', async () => {
  const modulePath = new URL(
    '../../../../scripts/ci/run-bun-test-with-diagnostics.ts',
    import.meta.url,
  ).pathname;
  const inner =
    "process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); process.stdout.write('child-pid='+process.pid+'\\n'); await Bun.sleep(30000);";
  const outerCode = `import { runChild } from ${JSON.stringify(modulePath)}; const result=await runChild([process.execPath,'-e',${JSON.stringify(inner)}]); console.error('wrapper-result='+result.exitCode); process.exitCode=result.exitCode;`;
  const wrapper = Bun.spawn([process.execPath, '-e', outerCode], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = wrapper.stdout.getReader();
  let text = '';
  let childPid: number | null = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && childPid === null) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('child pid was not emitted')),
          deadline - Date.now(),
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
    const match = /child-pid=(\d+)/.exec(text);
    if (match) childPid = Number(match[1]);
  }
  expect(childPid).not.toBeNull();

  wrapper.kill('SIGTERM');
  const exitCode = await wrapper.exited;
  await reader.cancel();
  expect(exitCode).toBe(143);
  const wrapperStderr = await new Response(wrapper.stderr).text();
  expect(wrapperStderr).toContain('wrapper-result=143');

  if (childPid !== null) {
    let alive = true;
    const end = Date.now() + 2_000;
    while (alive && Date.now() < end) {
      try {
        process.kill(childPid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }
});

test('failed output forwarding cleans up the owned child and preserves the stream error', async () => {
  const err = sink();
  const temp = await mkdtemp(path.join(tmpdir(), 'ci-test-forward-failure-'));
  const pidFile = path.join(temp, 'child-pid');
  const failedDestination = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('destination write failed'));
    },
  });
  const code = `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); process.stderr.write('child started\\n'); process.stdout.write('trigger failure'); await Bun.sleep(30000);`;

  try {
    await expect(
      runChild(bun(code), {
        stdout: failedDestination,
        stderr: err.stream,
        diagnosticAfterMs: 80,
        diagnosticEveryMs: 80,
      }),
    ).rejects.toThrow('destination write failed');
    const childPid = Number(await readFile(pidFile, 'utf8'));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    let alive = true;
    const end = Date.now() + 2_000;
    while (alive && Date.now() < end) {
      try {
        process.kill(childPid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  } finally {
    await failedDestination.destroy();
    await rm(temp, { recursive: true, force: true });
  }
});

test('settles a delayed diagnostic write error before returning the child result', async () => {
  const out = sink();
  const events: string[] = [];
  let writes = 0;
  const delayedError = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      events.push('diagnostic write started');
      setTimeout(() => {
        events.push('diagnostic callback failed');
        callback(new Error('late diagnostic failure'));
      }, 120);
    },
  });
  let caught: unknown;
  const startedAt = Date.now();

  try {
    await runChild(bun('await Bun.sleep(80);'), {
      stdout: out.stream,
      stderr: delayedError,
      diagnosticAfterMs: 20,
      diagnosticEveryMs: 20,
    });
    events.push('runChild returned');
  } catch (error) {
    caught = error;
    events.push('runChild rejected');
  }

  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe('late diagnostic failure');
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
  expect(writes).toBe(1);
  expect(events).toEqual([
    'diagnostic write started',
    'diagnostic callback failed',
    'runChild rejected',
  ]);
});
