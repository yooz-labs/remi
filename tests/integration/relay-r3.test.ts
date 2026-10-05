/** R3 composes the actual source hub, Worker and shared client; no deployed service or model. */
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

import { deserialize, generateId, now, relayV2, serialize } from '@remi/shared';
import {
  Mailbox,
  Socket,
  admit,
  clientUrl,
  hex,
  newIdentity,
} from '../../packages/signaling/tests/e2e/endpoints.ts';
async function localSocket(running: Awaited<ReturnType<typeof hub>>) {
  const ws = new WebSocket(`ws://127.0.0.1:${running.port}/relay-control`, {
    headers: { [CAPABILITY_HEADER]: running.capability },
  } as never);
  sockets.push(ws);
  const inbox = new Mailbox<Record<string, unknown>>();
  ws.onmessage = (event) => inbox.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('local control refused'));
  });
  return { ws, inbox };
}
test('real source hub grants only after exact local confirmation and persists before encrypted ready', async () => {
  const running = await hub();
  const local = await localSocket(running);
  // Health precedes asynchronous control admission; ask only once it has had time to admit.
  await Bun.sleep(150);
  local.ws.send(JSON.stringify({ t: 'pair', id: 'pair-one' }));
  const offer = await local.inbox.next();
  expect(offer['t']).toBe('offer');
  const token = await relayV2.decodePairingToken(
    String(offer['token']),
    Math.floor(Date.now() / 1000),
  );
  const rid = await relayV2.ridOf(token.machinePublicKey);
  const device = await newIdentity();
  const socket = await Socket.open(clientUrl(running.worker, hex(rid)));
  sockets.push(socket.ws);
  await admit(socket, device, 'client', rid, await relayV2.admitTag(token.secret));
  expect((await socket.json())['t']).toBe('admitted');
  expect((await socket.json())['t']).toBe('open');
  const start = await relayV2.clientStart(
    {
      machinePublicKey: token.machinePublicKey,
      device: device.signer,
      mode: 'pair',
      pairingSecret: token.secret,
      random: relayV2.systemRandom,
      deviceName: 'owned test device',
    },
    Date.now(),
  );
  socket.sendText(start.hello);
  const auth = await start.onHelloAck(await socket.text(), Date.now());
  socket.sendText(auth.auth);
  const compare = await local.inbox.next();
  expect(compare['t']).toBe('compare');
  expect(compare['fingerprint']).toBe(auth.fingerprint);
  expect(existsSync(join(running.dir, 'state/authorized_keys.json'))).toBe(false);
  local.ws.send(
    JSON.stringify({
      t: 'confirm',
      id: 'pair-one',
      offerId: offer['offerId'],
      connectionId: compare['connectionId'],
      fingerprint: compare['fingerprint'],
      accept: true,
    }),
  );
  const ready = await socket.text();
  const grants = JSON.parse(readFileSync(join(running.dir, 'state/authorized_keys.json'), 'utf8'));
  expect(
    grants.keys.some(
      (key: { publicKey: string }) =>
        key.publicKey === Buffer.from(device.publicKey).toString('base64'),
    ),
  ).toBe(true);
  expect(
    JSON.parse(readFileSync(join(running.dir, 'state/relay_devices.json'), 'utf8')),
  ).toHaveLength(1);
  const channel = await auth.onReady(ready, Date.now(), {
    emit: (frame) => socket.sendBinary(frame),
    close: (code) => socket.close(code),
  });
  const inbox = new Mailbox<ReturnType<typeof deserialize>>();
  let incoming = Promise.resolve();
  socket.tap((frame) => {
    incoming = incoming.then(async () => {
      if (typeof frame !== 'string') {
        const bytes = await channel.receive(frame);
        if (bytes) inbox.push(deserialize(new TextDecoder().decode(bytes)));
      }
    });
  });
  const id = generateId();
  await channel.send(
    new TextEncoder().encode(serialize({ type: 'relay_devices_request', id, timestamp: now() })),
  );
  const response = await inbox.next();
  expect(response?.type).toBe('relay_devices_response');
  if (response?.type !== 'relay_devices_response')
    throw new Error('expected correlated devices response');
  expect(response.requestId).toBe(id);
  expect(response.devices).toHaveLength(1);
  socket.sendText('pong');
  expect(await socket.closed).toEqual(relayV2.FAILURE_CLOSE);
  await incoming;
  expect(await channel.transportClosed()).toBe('unclean');
}, 20000);
