/** Real source hub + Worker with private state and inert CLI binaries. Never uses user credentials. */
import { afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CAPABILITY_HEADER } from '../../../daemon/src/auth/capability-token';
import { reserveRange } from '../../../daemon/tests/session/port-test-helpers';
import { type TestWorker, startWorker } from '../../../signaling/tests/e2e/harness';
import { Mailbox } from '../../../signaling/tests/e2e/endpoints';
const homes: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const workers: TestWorker[] = [];
const sockets: WebSocket[] = [];
const CLI = resolve(import.meta.dir, '../../../daemon/src/cli.ts');
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
export async function ownedRelayHub() {
  const dir = home();
  const worker = await startWorker();
  workers.push(worker);
  const port = await reserveRange(1, 50, '127.0.0.1');
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

export async function ownedRelayOffer() {
  const running = await ownedRelayHub();
  const ws = new WebSocket(`ws://127.0.0.1:${running.port}/relay-control`, {
    headers: { [CAPABILITY_HEADER]: running.capability },
  } as never);
  sockets.push(ws);
  const inbox = new Mailbox<Record<string, unknown>>();
  ws.onmessage = event => inbox.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('local control refused'));
  });
  await Bun.sleep(150);
  ws.send(JSON.stringify({ t: 'pair', id: 'owned-r4' }));
  const offer = await inbox.next();
  if (offer['t'] !== 'offer') throw new Error('expected real pairing offer');
  return { running, ws, inbox, offer };
}
