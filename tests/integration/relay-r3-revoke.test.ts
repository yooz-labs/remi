import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { IdentityStore } from '../../packages/daemon/src/auth/identity-store.ts';
import { HubRelay } from '../../packages/daemon/src/remote/hub-relay.ts';
import { RelayDeviceStore } from '../../packages/daemon/src/remote/relay-device-store.ts';
import { SessionRegistryFile } from '../../packages/daemon/src/session/session-registry-file.ts';
import { createIdentity, unlockIdentity } from '../../packages/shared/src/index.ts';
import { startWorker } from '../../packages/signaling/tests/e2e/harness.ts';
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('deadline');
    await Bun.sleep(5);
  }
}
test('completed edge revoke is not undone by startup enrollment snapshot', async () => {
  const dir = mkdtempSync('/private/tmp/remi-r3-revoke-state-');
  chmodSync(dir, 0o700);
  const worker = await startWorker();
  let release: (() => void) | undefined;
  let paused = false;
  let enrolledAfterRevoke = false;
  const upstreams: WebSocket[] = [];
  const bridge = Bun.serve<{ up?: WebSocket; path: string }>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      if (server.upgrade(req, { data: { path: new URL(req.url).pathname } })) return;
      return new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        const up = new WebSocket(worker.wsUrl + ws.data.path);
        ws.data.up = up;
        upstreams.push(up);
        up.onmessage = (event) => {
          const text = String(event.data);
          const obj = JSON.parse(text);
          if (!paused && obj.t === 'ack' && obj.r === 'enroll') {
            paused = true;
            release = () => ws.send(text);
          } else ws.send(text);
        };
        up.onclose = () => ws.close();
      },
      message(ws, msg) {
        ws.data.up?.send(msg);
      },
      close(ws) {
        ws.data.up?.close();
      },
    },
  });
  let relay: HubRelay | undefined;
  try {
    const trust = new IdentityStore(dir);
    await trust.generate();
    const identity = await trust.unlock();
    const a = await unlockIdentity(await createIdentity());
    const b = await unlockIdentity(await createIdentity());
    await trust.addAuthorizedKey(a.publicKeyRaw, 'a');
    await trust.addAuthorizedKey(b.publicKeyRaw, 'b');
    const devices = new RelayDeviceStore(dir, trust);
    await devices.add(a.publicKeyRaw, 'a');
    await devices.add(b.publicKeyRaw, 'b');
    const rid = await (await import('../../packages/shared/src/index.ts')).relayV2.ridOf(
      new Uint8Array(Buffer.from(identity.publicKeyRaw, 'base64')),
    );
    const ridHex = Buffer.from(rid).toString('hex');
    relay = new HubRelay({
      relayUrl: `ws://127.0.0.1:${bridge.port}`,
      identity,
      trust,
      dir,
      registry: new SessionRegistryFile(join(dir, 'live')),
    });
    const notices: { t: string; success?: boolean; edgeAcknowledged?: boolean }[] = [];
    relay.open('owned', (text) => notices.push(JSON.parse(text)));
    await relay.start();
    await until(() => paused);
    relay.message(
      'owned',
      JSON.stringify({ t: 'revoke', id: 'owned-revoke', fingerprint: b.fingerprint }),
    );
    await Bun.sleep(100);
    release?.();
    await until(() => notices.some((n) => n.t === 'revoked'));
    const outcome = notices.find((n) => n.t === 'revoked');
    expect(outcome.success).toBe(true);
    expect(outcome.edgeAcknowledged).toBe(true);
    await Bun.sleep(100);
    const state = (await (await fetch(`${worker.url}/__room/${ridHex}/__state`)).json()) as {
      storage: Record<string, unknown>;
    };
    enrolledAfterRevoke =
      state.storage[`dev:${Buffer.from(b.publicKeyRaw, 'base64').toString('hex')}`] !== undefined;

    expect(enrolledAfterRevoke).toBe(false);
  } finally {
    await relay?.stop();
    for (const up of upstreams) up.close();
    bridge.stop(true);
    await worker.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
