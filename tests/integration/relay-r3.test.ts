/** R3 composes the actual source hub, Worker and shared client; no deployed service or model. */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CAPABILITY_HEADER } from '../../packages/daemon/src/auth/capability-token.ts';
import { reserveRange } from '../../packages/daemon/tests/session/port-test-helpers.ts';
import { type TestWorker, startWorker } from '../../packages/signaling/tests/e2e/harness.ts';

const homes: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const workers: TestWorker[] = [];
const sockets: WebSocket[] = [];
const CLI = resolve(import.meta.dir, '../../packages/daemon/src/cli.ts');
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const proc of processes.splice(0)) {
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await proc.exited;
  }
  for (const worker of workers.splice(0)) await worker.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'remi-r3-'));
  chmodSync(dir, 0o700);
  homes.push(dir);
  mkdirSync(join(dir, 'bin'), { mode: 0o700 });
  for (const command of ['claude', 'codex'])
    writeFileSync(join(dir, 'bin', command), '#!/bin/sh\nexit 88\n', { mode: 0o700 });
  return dir;
}
function spawn(dir: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: dir,
    env: {
      HOME: dir,
      REMI_HOME: join(dir, 'state'),
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
      NODE_ENV: 'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  processes.push(proc);
  return proc;
}
async function hub() {
  const dir = home();
  const worker = await startWorker();
  workers.push(worker);
  const range = reserveRange(1);
  const port = range.base;
  range.release();
  const proc = spawn(dir, [
    'serve',
    '--relay',
    '--signaling-url',
    worker.wsUrl,
    '--port',
    String(port),
    '--no-mdns',
    '--no-telegram',
  ]);
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const deadline = Date.now() + 10000;
  while (true) {
    if (proc.exitCode !== null) throw new Error(`hub exited: ${await stdout} ${await stderr}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('hub startup deadline');
    await Bun.sleep(10);
  }
  return {
    dir,
    port,
    worker,
    proc,
    capability: readFileSync(join(dir, 'state/capability.key'), 'utf8').trim(),
  };
}
async function control(port: number, capability?: string) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/relay-control`,
    (capability ? { headers: { [CAPABILITY_HEADER]: capability } } : undefined) as never,
  );
  sockets.push(ws);
  return new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
}
test('hub relay control requires capability and is reachable with the actual local token', async () => {
  const running = await hub();
  expect(await control(running.port)).toBe(false);
  expect(await control(running.port, 'wrong')).toBe(false);
  expect(await control(running.port, running.capability)).toBe(true);
}, 20000);
test('retired code command exits visibly before any model invocation', async () => {
  const proc = spawn(home(), ['code']);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(1);
  expect(`${out}${err}`).toContain('remi pair');
}, 10000);
test('noninteractive pair refuses before dialing or starting a model', async () => {
  const proc = spawn(home(), ['pair']);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(1);
  expect(`${out}${err}`).toContain('interactive terminal');
}, 10000);
