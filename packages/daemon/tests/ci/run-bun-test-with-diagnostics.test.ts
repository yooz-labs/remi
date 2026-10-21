import { expect, test } from 'bun:test';
import { constants, closeSync, openSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { runChild, sampleProc } from '../../../../scripts/ci/run-bun-test-with-diagnostics';

function sink(observe?: (chunk: Buffer) => void) {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => {
    chunks.push(Buffer.from(chunk));
    observe?.(chunk);
  });
  return {
    stream,
    text: () => Buffer.concat(chunks).toString('utf8'),
    bytes: () => Buffer.concat(chunks),
  };
}

function checkpointSink(
  emit: (stage: string) => void = (stage) => {
    writeSync(2, `[log-file-child-stage] ${stage}\n`);
  },
) {
  let line = '';
  let oversized = false;
  return sink((chunk) => {
    for (const character of chunk.toString('utf8')) {
      if (character === '\n') {
        const match = oversized
          ? null
          : /^\[log-file-stage\] (module-body|setup:(?:entered|tempdir|reset)|first:(?:entered|opened|read))$/.exec(
              line,
            );
        if (match?.[1]) emit(match[1]);
        line = '';
        oversized = false;
      } else if (line.length < 128) {
        line += character;
      } else {
        oversized = true;
      }
    }
  });
}

function bun(code: string): string[] {
  return [process.execPath, '-e', code];
}

function readKernelWaitChannel(pid: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(`/proc/${pid}/wchan`, constants.O_RDONLY | constants.O_NONBLOCK);
    const bytes = Buffer.alloc(65);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead > 64) return null;
    const value = bytes.toString('latin1', 0, bytesRead).trim();
    return /^[A-Za-z0-9_.]{1,64}$/.test(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Wait-channel introspection is best-effort in the Linux control.
      }
    }
  }
}

test.skipIf(process.platform !== 'linux')(
  'samples wait metadata for a real blocked child and its direct child',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'remi-ci-wait-'));
    const fifo = path.join(directory, 'blocked-read');
    const nestedReady = path.join(directory, 'nested-ready');
    const out = sink();
    const err = sink();
    let captured:
      | {
          pid: number;
          waitChannel: string | null;
          kernelWaitChannel: string | null;
          childPid: number;
          childWaitChannel: string | null;
          childKernelWaitChannel: string | null;
        }
      | undefined;
    try {
      expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
      const nestedCode = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(nestedReady)}, 'ready'); fs.writeSync(1, 'fifo-child-ready\\n'); const fd = fs.openSync(${JSON.stringify(fifo)}, 'r'); fs.closeSync(fd);`;
      const parentCode = `const fs = require('node:fs'); const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(nestedCode)}], { stdout: 'inherit', stderr: 'inherit' }); while (!fs.existsSync(${JSON.stringify(nestedReady)})) await Bun.sleep(5); fs.writeSync(1, 'fifo-parent-ready\\n'); const fd = fs.openSync(${JSON.stringify(fifo)}, 'r'); fs.closeSync(fd); process.exitCode = await child.exited;`;
      const result = await runChild(bun(parentCode), {
        stdout: out.stream,
        stderr: err.stream,
        timeoutMs: 2_000,
        diagnosticAfterMs: 100,
        diagnosticEveryMs: 40,
        procSampler: async (pid, sampleOptions) => {
          const sample = await sampleProc(pid, sampleOptions);
          if (
            pid !== process.pid &&
            !captured &&
            out.text().includes('fifo-parent-ready') &&
            out.text().includes('fifo-child-ready') &&
            sample.available &&
            sample.state === 'S' &&
            sample.waitTopology
          ) {
            const childSample = sample.waitTopology.children?.[0];
            if (!childSample) return sample;
            const kernelWaitChannel = readKernelWaitChannel(pid);
            const childKernelWaitChannel = readKernelWaitChannel(childSample.pid);
            // Release the actual FIFO reader; runChild owns the deadline and cleanup if setup fails.
            const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
            closeSync(writer);
            captured = {
              pid,
              waitChannel: sample.waitChannel,
              kernelWaitChannel,
              childPid: childSample.pid,
              childWaitChannel: childSample.waitChannel,
              childKernelWaitChannel,
            };
          }
          return sample;
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.cleanupVerified).toBe(true);
      expect(captured).toBeDefined();
      const observed = captured;
      if (!observed) throw new Error('blocked child was not sampled');
      expect(observed.waitChannel).toBe(observed.kernelWaitChannel);
      expect(observed.childWaitChannel).toBe(observed.childKernelWaitChannel);
      if (observed.kernelWaitChannel !== null)
        expect(observed.kernelWaitChannel).toMatch(/^[A-Za-z0-9_.]{1,64}$/);
      if (observed.childKernelWaitChannel !== null)
        expect(observed.childKernelWaitChannel).toMatch(/^[A-Za-z0-9_.]{1,64}$/);
      const records = err
        .text()
        .split('\n')
        .filter((line) => line.startsWith('[ci-test-diagnostic] '))
        .map((line) => JSON.parse(line.slice('[ci-test-diagnostic] '.length)));
      const record = records.find((sample) => sample.process.waitTopology);
      expect(record).toBeDefined();
      if (!record) throw new Error('blocked child wait topology was unavailable');
      const topology = record.process.waitTopology;
      expect(record.process.waitChannel).toBe(observed.kernelWaitChannel);
      expect(topology.threads.length).toBeLessThanOrEqual(32);
      expect(topology.threadsTruncated).toBe(false);
      expect(
        topology.threads.some(
          (thread: { tid: number; state: string | null }) =>
            thread.tid === observed.pid && thread.state === 'S',
        ),
      ).toBe(true);
      expect(
        topology.threads.find((thread: { tid: number }) => thread.tid === observed.pid)
          ?.waitChannel,
      ).toBe(observed.kernelWaitChannel);
      expect(topology.children).not.toBeNull();
      if (!topology.children) throw new Error('direct child metadata was unavailable');
      expect(topology.children).toHaveLength(1);
      expect(topology.children[0]?.state).toBe('S');
      expect(topology.children[0]?.pid).toBe(observed.childPid);
      expect(topology.children[0]?.waitChannel).toBe(observed.childKernelWaitChannel);
      const childWaitChannel = topology.children[0]?.waitChannel;
      if (childWaitChannel !== null && childWaitChannel !== undefined)
        expect(childWaitChannel).toMatch(/^[A-Za-z0-9_.]{1,64}$/);
      expect(topology.childrenTruncated).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

for (const actions of [false, true]) {
  test(`logging boundary stages preserve the real cases (GitHub Actions=${actions})`, async () => {
    const loggingTest = path.resolve(import.meta.dir, '../cli/log-file.test.ts');
    const directory = await mkdtemp(path.join(tmpdir(), 'remi-ci-log-file-flags-'));
    const coverageDir = path.join(directory, 'coverage');
    const junitFile = path.join(directory, 'junit.xml');
    const out = sink();
    const err = checkpointSink();
    try {
      await mkdir(coverageDir);
      const result = await runChild(
        [
          process.execPath,
          'test',
          loggingTest,
          '--coverage',
          '--coverage-reporter=lcov',
          '--coverage-dir',
          coverageDir,
          '--reporter=junit',
          `--reporter-outfile=${junitFile}`,
        ],
        {
          env: { ...process.env, GITHUB_ACTIONS: String(actions) },
          stdout: out.stream,
          stderr: err.stream,
          timeoutMs: 2_000,
          captureLoggingStages: true,
        },
      );
      const text = `${out.text()}${err.text()}`.replace(/\x1b\[[0-9;]*m/g, '');
      expect(result.exitCode).toBe(0);
      expect(result.cleanupVerified).toBe(true);
      if (typeof constants.O_NOFOLLOW === 'number') {
        expect(result.loggingStageCleanupVerified).toBe(true);
        expect(result.loggingStages).not.toBeNull();
        if (!result.loggingStages) throw new Error('logging stage channel was unavailable');
        expect(result.loggingStages.truncated).toBe(false);
        expect(result.loggingStages.stages.length).toBeGreaterThan(0);
        expect(result.loggingStages.stages.every((stage) => stage.pid === result.pid)).toBe(true);
        expect(result.loggingStages.stages.map((stage) => stage.stage)).toContain('module-body');
        expect(
          result.loggingStages.stages.filter((stage) => stage.stage === 'setup:reset'),
        ).toHaveLength(14);
      } else {
        expect(result.loggingStageCleanupVerified).toBeNull();
        expect(result.loggingStages).toBeNull();
      }
      expect(text).toContain('14 pass');
      expect(text).toContain('0 fail');
      const lcov = await readFile(path.join(coverageDir, 'lcov.info'), 'utf8');
      const junit = await readFile(junitFile, 'utf8');
      expect(lcov).toContain('end_of_record');
      expect(junit).toMatch(/<testsuites?\b/);
      const stages = text.split('\n').filter((line) => line.startsWith('[log-file-stage] '));
      if (actions) {
        expect(stages).toContain('[log-file-stage] module-body');
        expect(stages.filter((line) => line.includes('first:'))).toEqual([
          '[log-file-stage] first:entered',
          '[log-file-stage] first:opened',
          '[log-file-stage] first:read',
        ]);
        expect(stages.filter((line) => line === '[log-file-stage] setup:entered')).toHaveLength(14);
        expect(stages.filter((line) => line === '[log-file-stage] setup:reset')).toHaveLength(14);
      } else {
        expect(stages).toEqual([]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
}

test('rejects inherited logging stages from a nested real logging-test process', async () => {
  const loggingTest = path.resolve(import.meta.dir, '../cli/log-file.test.ts');
  const out = sink();
  const err = sink();
  const result = await runChild(
    bun(
      `const child = Bun.spawn([process.execPath, 'test', ${JSON.stringify(loggingTest)}], { stdout: 'inherit', stderr: 'inherit' }); process.exitCode = await child.exited;`,
    ),
    {
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      stdout: out.stream,
      stderr: err.stream,
      timeoutMs: 10_000,
      captureLoggingStages: true,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.cleanupVerified).toBe(true);
  if (typeof constants.O_NOFOLLOW === 'number') {
    expect(result.loggingStageCleanupVerified).toBe(true);
    expect(result.loggingStages).toEqual({ stages: [], truncated: false });
  } else {
    expect(result.loggingStageCleanupVerified).toBeNull();
    expect(result.loggingStages).toBeNull();
  }
  expect(`${out.text()}${err.text()}`).toContain('[log-file-stage] module-body');
});

test.skipIf(
  typeof constants.O_NOFOLLOW !== 'number' ||
    typeof constants.O_NONBLOCK !== 'number' ||
    !Bun.which('mkfifo'),
)(
  'keeps the real logging test nonblocking when its owned stage file becomes a FIFO',
  async () => {
    const loggingTest = path.resolve(import.meta.dir, '../cli/log-file.test.ts');
    const out = sink();
    const err = sink();
    const startedAt = Date.now();
    const result = await runChild([process.execPath, 'test', loggingTest], {
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      stdout: out.stream,
      stderr: err.stream,
      timeoutMs: 500,
      captureLoggingStages: true,
      testOnlyReplaceLoggingStageFileWithFifo: true,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.exitCode).toBe(0);
    expect(result.cleanupVerified).toBe(true);
    expect(result.loggingStageCleanupVerified).toBe(true);
    expect(result.loggingStages).toBeNull();
    const text = `${out.text()}${err.text()}`;
    expect(text).toContain('[log-file-stage] module-body');
    expect(text).toContain('14 pass');
    expect(text).toContain('0 fail');
  },
  5_000,
);

test.skipIf(typeof constants.O_NOFOLLOW !== 'number')(
  'captures the real module-body stage before its quiet stderr checkpoint',
  async () => {
    const loggingTest = path.resolve(import.meta.dir, '../cli/log-file.test.ts');
    const directory = await mkdtemp(path.join(tmpdir(), 'remi-ci-stage-channel-'));
    const coverageDir = path.join(directory, 'coverage');
    const junitFile = path.join(directory, 'junit.xml');
    const release = path.join(directory, 'release');
    const out = sink();
    let pending = '';
    let stderrStageLines = 0;
    const observation: {
      stderrStageLinesAtSnapshot: number | null;
      sampledStages: { pid: number; stage: string }[] | null;
    } = { stderrStageLinesAtSnapshot: null, sampledStages: null };
    const err = sink((chunk) => {
      pending += chunk.toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.startsWith('[log-file-stage] ')) {
          stderrStageLines += 1;
          continue;
        }
        if (!line.startsWith('[ci-test-diagnostic] ')) continue;
        const record = JSON.parse(line.slice('[ci-test-diagnostic] '.length)) as {
          childPid: number;
          loggingStages: { stages: { pid: number; stage: string }[] } | null;
        };
        const stages = record.loggingStages?.stages ?? [];
        if (
          observation.sampledStages === null &&
          stages.some((stage) => stage.pid === record.childPid && stage.stage === 'module-body')
        ) {
          observation.sampledStages = stages;
          observation.stderrStageLinesAtSnapshot = stderrStageLines;
          writeFileSync(release, 'released');
        }
      }
    });
    try {
      await mkdir(coverageDir);
      const result = await runChild(
        [
          process.execPath,
          'test',
          loggingTest,
          '--coverage',
          '--coverage-reporter=lcov',
          '--coverage-dir',
          coverageDir,
          '--reporter=junit',
          `--reporter-outfile=${junitFile}`,
        ],
        {
          env: {
            ...process.env,
            GITHUB_ACTIONS: 'true',
          },
          stdout: out.stream,
          stderr: err.stream,
          timeoutMs: 5_000,
          diagnosticAfterMs: 20,
          diagnosticEveryMs: 10,
          captureLoggingStages: true,
          testOnlyLoggingStageHoldPath: release,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.cleanupVerified).toBe(true);
      expect(result.loggingStageCleanupVerified).toBe(true);
      expect(
        observation.sampledStages?.some(
          (stage) => stage.pid === result.pid && stage.stage === 'module-body',
        ),
      ).toEqual(true);
      expect(observation.stderrStageLinesAtSnapshot).toEqual(0);
      const diagnosticRecords = err
        .text()
        .split('\n')
        .filter((line) => line.startsWith('[ci-test-diagnostic] '))
        .map((line) => JSON.parse(line.slice('[ci-test-diagnostic] '.length)));
      expect(
        diagnosticRecords.some((record) =>
          record.loggingStages?.stages?.some(
            (stage: { pid: number; stage: string }) =>
              stage.pid === result.pid && stage.stage === 'module-body',
          ),
        ),
      ).toBe(true);
      expect(err.text()).toContain('[log-file-stage] module-body');
      expect(await readFile(path.join(coverageDir, 'lcov.info'), 'utf8')).toContain(
        'end_of_record',
      );
      expect(await readFile(junitFile, 'utf8')).toMatch(/<testsuites?\b/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

test('streams only static child checkpoints before the child can exit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remi-ci-stage-'));
  const release = path.join(directory, 'release');
  const stages: string[] = [];
  const out = sink();
  const err = checkpointSink((stage) => {
    stages.push(stage);
    writeFileSync(release, 'released');
  });
  try {
    const result = await runChild(
      bun(
        `const fs = require('node:fs');
         fs.writeSync(2, 'packages/daemon/tests/cli/log-file.test.ts:\\n');
         fs.writeSync(2, '[log-file-stage] unknown\\n');
         fs.writeSync(2, 'x'.repeat(129) + '[log-file-stage] first:read\\n');
         fs.writeSync(2, '[log-file-stage] first:');
         await Bun.sleep(20);
         fs.writeSync(2, 'opened\\n');
         while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10);`,
      ),
      { stdout: out.stream, stderr: err.stream, timeoutMs: 2_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.cleanupVerified).toBe(true);
    expect(stages).toEqual(['first:opened']);
    expect(err.text()).toContain('[log-file-stage] unknown');
    expect(err.text()).toContain('packages/daemon/tests/cli/log-file.test.ts:');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

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

test('samples topology before a delayed header and continues recording after it', async () => {
  const out = sink();
  const err = sink();
  const stdoutPayload = 'quiet-child-stdout\n';
  const stderrPayload = 'packages/daemon/tests/cli/quiet.test.ts:\nquiet-child-stderr\n';
  const code = `await Bun.sleep(180); process.stdout.write(${JSON.stringify(stdoutPayload)}); process.stderr.write(${JSON.stringify(stderrPayload)}); await Bun.sleep(180);`;
  const result = await runChild(bun(code), {
    stdout: out.stream,
    stderr: err.stream,
    diagnosticAfterMs: 40,
    diagnosticEveryMs: 40,
    timeoutMs: 2_000,
  });
  const diagnosticLines = err
    .text()
    .split('\n')
    .filter((line) => line.startsWith('[ci-test-diagnostic] '));
  const records = diagnosticLines.map((line) =>
    JSON.parse(line.slice('[ci-test-diagnostic] '.length)),
  );
  const beforeHeaderRecords = records.filter((sample) => sample.lastTestFile === null);
  const topologyRecord = records.find((sample) => sample.process.waitTopology);
  const record = records.find(
    (sample) => sample.lastTestFile === 'packages/daemon/tests/cli/quiet.test.ts',
  );

  expect(result.exitCode).toBe(0);
  expect(out.text()).toBe(stdoutPayload);
  expect(err.text()).toContain(stderrPayload);
  expect(beforeHeaderRecords.length).toBeGreaterThan(1);
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
    expect(topologyRecord).toBeDefined();
    if (!topologyRecord) throw new Error('first quiet sample did not include Linux topology');
    expect(topologyRecord.lastTestFile).toBeNull();
    expect(topologyRecord.process.waitTopology).toEqual(
      expect.objectContaining({
        threads: expect.any(Array),
        threadsTruncated: expect.any(Boolean),
        children: expect.any(Array),
        childrenTruncated: expect.any(Boolean),
      }),
    );
    expect(topologyRecord.process.waitTopology.threads.length).toBeLessThanOrEqual(32);
    expect(topologyRecord.process.waitTopology.children.length).toBeLessThanOrEqual(8);
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

test('an unavailable proc sample does not change a successful child result', async () => {
  const out = sink();
  const err = sink();
  const result = await runChild(bun("process.stdout.write('child-ok\\n'); await Bun.sleep(80);"), {
    stdout: out.stream,
    stderr: err.stream,
    diagnosticAfterMs: 20,
    diagnosticEveryMs: 20,
    procSampler: async (_pid, sampleOptions) => sampleProc(-1, sampleOptions),
  });
  const record = err
    .text()
    .split('\n')
    .filter((line) => line.startsWith('[ci-test-diagnostic] '))
    .map((line) => JSON.parse(line.slice('[ci-test-diagnostic] '.length)))[0];

  expect(result.exitCode).toBe(0);
  expect(out.text()).toBe('child-ok\n');
  expect(record).toBeDefined();
  if (!record) throw new Error('unavailable proc sample emitted no diagnostic');
  expect(record.process.available).toBe(false);
  expect(record.process.reason).toBe(process.platform === 'linux' ? 'unavailable' : 'unsupported');
  expect(record.process.waitTopology).toBeNull();
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

test('explicit child deadline kills and reaps a stubborn owned process without changing per-test timeouts', async () => {
  const out = sink();
  const err = sink();
  const start = performance.now();
  await expect(
    runChild(
      bun(
        "process.on('SIGTERM',()=>{});console.log('deadline-pid='+process.pid);await Bun.sleep(30000);",
      ),
      { stdout: out.stream, stderr: err.stream, timeoutMs: 100 },
    ),
  ).rejects.toThrow('deadline');
  const match = /deadline-pid=(\d+)/.exec(out.text());
  expect(match).not.toBeNull();
  expect(performance.now() - start).toBeLessThan(5_000);
  if (match?.[1]) expect(() => process.kill(Number(match[1]), 0)).toThrow();
}, 8_000);

test('a dead leader with a pipe-holding descendant is not a completed batch', async () => {
  const out = sink();
  const err = sink();
  const grandchild =
    "process.on('SIGTERM',()=>{});console.log('grandchild-pid='+process.pid);await Bun.sleep(30000);";
  const code = `Bun.spawn([process.execPath,'-e',${JSON.stringify(grandchild)}],{stdout:'inherit',stderr:'inherit'});await Bun.sleep(100);process.exit(0);`;
  const start = performance.now();
  await expect(
    runChild(bun(code), { stdout: out.stream, stderr: err.stream, timeoutMs: 300 }),
  ).rejects.toThrow();
  const match = /grandchild-pid=(\d+)/.exec(out.text());
  expect(match).not.toBeNull();
  expect(performance.now() - start).toBeLessThan(6_000);
  if (match?.[1]) expect(() => process.kill(Number(match[1]), 0)).toThrow();
}, 10_000);
