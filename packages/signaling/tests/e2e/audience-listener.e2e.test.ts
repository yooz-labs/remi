import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, startWorker } from './harness.ts';
import {
  WORKER_LISTENER_SCRIPT,
  openWorkerListener,
  workerNodeEnvironment,
  workerTestNode,
} from './worker-listener.ts';

test('pinned audience remains actually bound before the real Worker starts', async () => {
  const worker = await startWorker({}, true, undefined, async (audience) => {
    const competitor = createServer();
    let occupied = false;
    try {
      await new Promise<void>((resolve, reject) => {
        competitor.once('error', reject);
        competitor.listen(Number(new URL(audience).port), '127.0.0.1', resolve);
      });
    } catch (error) {
      occupied = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
    } finally {
      if (competitor.listening)
        await new Promise<void>((resolve, reject) =>
          competitor.close((error) => (error ? reject(error) : resolve())),
        );
    }
    expect(
      occupied,
      'another listener cannot claim the pinned audience before runtime startup',
    ).toBe(true);
  });
  try {
    expect((await get(`${worker.url}/__owned_missing_resource`)).status).toBe(404);
  } finally {
    await worker.stop();
  }
}, 15000);

test('a failed pre-start observation releases the owned audience listener', async () => {
  const failure = new Error('owned observation failure');
  let audience: string | undefined;
  await expect(
    startWorker({}, true, undefined, (url) => {
      audience = url;
      throw failure;
    }),
  ).rejects.toBe(failure);
  if (!audience) throw new Error('Owned audience was not observed');
  const audiencePort = Number(new URL(audience).port);
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(audiencePort, '127.0.0.1', resolve);
    });
    expect(probe.listening).toBe(true);
  } finally {
    if (probe.listening)
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
  }
});

test('a fresh Worker runtime inherits the still-bound pinned origin', async () => {
  const path = mkdtempSync(join(tmpdir(), 'remi-audience-restart-'));
  let observations = 0;
  let current: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    const first = await startWorker({}, true, { path }, async (url) => {
      observations++;
      const competitor = createServer();
      try {
        await expect(
          new Promise<void>((resolve, reject) => {
            competitor.once('error', reject);
            competitor.listen(Number(new URL(url).port), '127.0.0.1', resolve);
          }),
        ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      } finally {
        if (competitor.listening)
          await new Promise<void>((resolve) => competitor.close(() => resolve()));
      }
    });
    current = first;
    const next = await first.restart();
    current = next;
    expect(next).not.toBe(first);
    expect(next.mf).not.toBe(first.mf);
    expect(next.url).toBe(first.url);
    expect(observations).toBe(2);
    await first.stop();
    expect((await get(`${next.url}/__owned_missing_resource`)).status).toBe(404);
    const bindings = await next.mf.getBindings();
    expect(bindings['PUSH_AUDIENCE']).toBe(next.url);
  } finally {
    await current?.stop();
    rmSync(path, { recursive: true, force: true });
  }
}, 15000);

test('the owned byte listener preserves a response after a client write-half-close', async () => {
  const home = mkdtempSync(join(tmpdir(), 'remi-half-close-'));
  const executable = workerTestNode();
  const proc = Bun.spawn([executable, WORKER_LISTENER_SCRIPT, '--half-close-proof', home], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: workerNodeEnvironment(executable),
  });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  let listener: Awaited<ReturnType<typeof openWorkerListener>> | undefined;
  const watchdog = setTimeout(() => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }, 8000);
  try {
    const deadline = performance.now() + 5000;
    while (!existsSync(join(home, 'backend.json'))) {
      if (proc.exitCode !== null || performance.now() >= deadline)
        throw new Error('Owned half-close backend missing');
      await Bun.sleep(2);
    }
    const backend = JSON.parse(readFileSync(join(home, 'backend.json'), 'utf8')) as {
      port: number;
    };
    listener = await openWorkerListener(0);
    await listener.forwardTo(`http://127.0.0.1:${backend.port}`);
    writeFileSync(
      join(home, 'target.json.next'),
      JSON.stringify({ port: Number(new URL(listener.url).port) }),
    );
    renameSync(join(home, 'target.json.next'), join(home, 'target.json'));
    expect(await proc.exited, await err).toBe(0);
    const result = JSON.parse(readFileSync(join(home, 'result.json'), 'utf8')) as {
      bytes: number;
      actual: string;
      expected: string;
    };
    expect(result.bytes).toBe(128 * 1024);
    expect(result.actual).toBe(result.expected);
    expect(await out).toBe('');
  } finally {
    clearTimeout(watchdog);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await proc.exited;
    await listener?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);
