/** Opt-in wall-clock production timer pins; default suites incur no long waits. */
import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { relayV2 } from '@remi/shared';
import { CAPABILITY_HEADER } from '../../packages/daemon/src/auth/capability-token.ts';
import { reserveRange } from '../../packages/daemon/tests/session/port-test-helpers.ts';
import {
  Mailbox,
  Socket,
  admit,
  clientUrl,
  hex,
  newIdentity,
} from '../../packages/signaling/tests/e2e/endpoints.ts';
import { startWorker } from '../../packages/signaling/tests/e2e/harness.ts';

const selected = process.env['REMI_R3_CLOCK_GATE'];
async function sourceHub() {
  const dir = mkdtempSync('/private/tmp/remi-r3-clock-');
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, 'bin'), { mode: 0o700 });
  for (const command of ['claude', 'codex'])
    writeFileSync(join(dir, 'bin', command), '#!/bin/sh\ntouch "$HOME/model-called"\nexit 88\n', {
      mode: 0o700,
    });
  const worker = await startWorker();
  const port = await reserveRange(1, 50, '127.0.0.1');
  const proc = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, '../../packages/daemon/src/cli.ts'),
      'serve',
      '--relay',
      '--signaling-url',
      worker.wsUrl,
      '--port',
      String(port),
      '--no-mdns',
      '--no-telegram',
    ],
    {
      cwd: dir,
      env: { HOME: dir, REMI_HOME: join(dir, 'state'), PATH: `${join(dir, 'bin')}:/usr/bin:/bin` },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  // Drain privately. No raw process output or token is included in a diagnostic.
  let admitted = false;
  const readAdmission = async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let tail = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-4096);
      if (tail.includes('Relay control admitted')) admitted = true;
    }
  };
  const output = Promise.all([readAdmission(), new Response(proc.stderr).text()]);
  const sockets: Socket[] = [];
  const locals: WebSocket[] = [];
  const cleanup = async () => {
    for (const local of locals) local.close();
    for (const socket of sockets) socket.close();
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await proc.exited;
    await output;
    await worker.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 10000;
    while (true) {
      if (proc.exitCode !== null) throw new Error('OWNED_CLOCK_HUB_EXITED');
      const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      if (response?.ok) break;
      if (Date.now() > deadline) throw new Error('OWNED_CLOCK_HUB_NOT_READY');
      await Bun.sleep(10);
    }
    while (!admitted) {
      if (proc.exitCode !== null || Date.now() > deadline)
        throw new Error('OWNED_CLOCK_CONTROL_NOT_ADMITTED');
      await Bun.sleep(10);
    }
    const capability = readFileSync(join(dir, 'state/capability.key'), 'utf8').trim();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay-control`, {
      headers: { [CAPABILITY_HEADER]: capability },
    } as never);
    locals.push(ws);
    const inbox = new Mailbox<Record<string, unknown>>();
    ws.onmessage = (event) => inbox.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('OWNED_CLOCK_CONTROL_REFUSED'));
    });
    // Retry only control-not-ready while actual Worker admission completes.
    const offer = async (id: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        ws.send(JSON.stringify({ t: 'pair', id }));
        const value = await inbox.next(1000);
        if (value['t'] === 'offer' || value['id'] === id) return value;
        await Bun.sleep(20);
      }
      throw new Error('OWNED_CLOCK_OFFER_NOT_READY');
    };
    const start = async () => {
      const value = await offer('clock-offer');
      expect(value['t']).toBe('offer');
      const token = await relayV2.decodePairingToken(
        String(value['token']),
        Math.floor(Date.now() / 1000),
      );
      const rid = await relayV2.ridOf(token.machinePublicKey);
      const device = await newIdentity();
      const socket = await Socket.open(clientUrl(worker, hex(rid)));
      sockets.push(socket);
      await admit(socket, device, 'client', rid, await relayV2.admitTag(token.secret));
      expect((await socket.json())['t']).toBe('admitted');
      expect((await socket.json())['t']).toBe('open');
      return { socket, token, device };
    };
    return { dir, offer, inbox, ws, start, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
async function boundedClose(socket: Socket, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      socket.closed,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test.skipIf(selected !== 'half-open')(
  'real-clock source hub closes admitted half-open at the production 30-second deadline',
  async () => {
    const hub = await sourceHub();
    try {
      const { socket } = await hub.start();
      const started = Date.now();
      const closed = await boundedClose(socket, 34000);
      expect(closed).not.toBeNull();
      expect(closed?.code).toBe(relayV2.FAILURE_CLOSE.code);
      expect(Date.now() - started).toBeGreaterThanOrEqual(29000);
      expect(existsSync(join(hub.dir, 'model-called'))).toBe(false);
      expect(existsSync(join(hub.dir, 'state/authorized_keys.json'))).toBe(false);
    } finally {
      await hub.cleanup();
    }
  },
  45000,
);

test.skipIf(selected !== 'confirmation')(
  'real-clock source hub releases unconfirmed authenticated pairing after two minutes without a grant',
  async () => {
    const hub = await sourceHub();
    try {
      const { socket, token, device } = await hub.start();
      const start = await relayV2.clientStart(
        {
          machinePublicKey: token.machinePublicKey,
          device: device.signer,
          mode: 'pair',
          pairingSecret: token.secret,
          random: relayV2.systemRandom,
        },
        Date.now(),
      );
      socket.sendText(start.hello);
      const auth = await start.onHelloAck(await socket.text(), Date.now());
      socket.sendText(auth.auth);
      expect((await hub.inbox.next())['t']).toBe('compare');
      const started = Date.now();
      const closed = await boundedClose(socket, 124000);
      expect(closed).not.toBeNull();
      expect(closed?.code).toBe(relayV2.FAILURE_CLOSE.code);
      expect(Date.now() - started).toBeGreaterThanOrEqual(119000);
      expect(existsSync(join(hub.dir, 'state/authorized_keys.json'))).toBe(false);
      expect(existsSync(join(hub.dir, 'state/relay_devices.json'))).toBe(false);
      expect(existsSync(join(hub.dir, 'model-called'))).toBe(false);
    } finally {
      await hub.cleanup();
    }
  },
  135000,
);

test.skipIf(selected !== 'offers')(
  'real-clock source hub expires eight offers at ten minutes and reclaims capacity for a ninth',
  async () => {
    const hub = await sourceHub();
    try {
      let expiresAtMs = 0;
      for (let i = 0; i < 8; i++) {
        const value = await hub.offer(`offer-${i}`);
        expect(value['t']).toBe('offer');
        const token = await relayV2.decodePairingToken(
          String(value['token']),
          Math.floor(Date.now() / 1000),
        );
        expiresAtMs = Math.max(expiresAtMs, token.expiresAtSec * 1000);
      }
      expect((await hub.offer('before-expiry'))['error']).toBe('PAIRING_CAPACITY');
      // Wait beyond all actual token deadlines and their sub-second timer rounding.
      await Bun.sleep(Math.max(0, expiresAtMs + 2000 - Date.now()));
      const next = await hub.offer('after-expiry');
      expect(next['t']).toBe('offer');
      const token = await relayV2.decodePairingToken(
        String(next['token']),
        Math.floor(Date.now() / 1000),
      );
      expect(token.expiresAtSec).toBeGreaterThan(Math.floor(Date.now() / 1000) + 590);
      expect(existsSync(join(hub.dir, 'model-called'))).toBe(false);
      expect(existsSync(join(hub.dir, 'state/authorized_keys.json'))).toBe(false);
    } finally {
      await hub.cleanup();
    }
  },
  635000,
);
