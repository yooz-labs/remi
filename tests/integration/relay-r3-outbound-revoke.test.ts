import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityStore } from '../../packages/daemon/src/auth/identity-store.ts';
import { HubRelay } from '../../packages/daemon/src/remote/hub-relay.ts';
import { RelayDeviceStore } from '../../packages/daemon/src/remote/relay-device-store.ts';
import { SessionRegistryFile } from '../../packages/daemon/src/session/session-registry-file.ts';
import {
  createIdentity,
  createSessionUpdate,
  deserialize,
  relayV2,
  unlockIdentity,
} from '../../packages/shared/src/index.ts';
import { Socket, admit, clientUrl } from '../../packages/signaling/tests/e2e/endpoints.ts';
import { startWorker } from '../../packages/signaling/tests/e2e/harness.ts';
test('removed authoritative grant cannot receive new encrypted broadcasts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remi-r3-outbound-state-'));
  chmodSync(dir, 0o700);
  const worker = await startWorker();
  let relay: HubRelay | undefined;
  let socket: Socket | undefined;
  let channel: relayV2.Channel | undefined;
  try {
    const trust = new IdentityStore(dir);
    await trust.generate();
    const identity = await trust.unlock();
    const device = await unlockIdentity(await createIdentity());
    await trust.addAuthorizedKey(device.publicKeyRaw, 'owned');
    const devices = new RelayDeviceStore(dir, trust);
    await devices.add(device.publicKeyRaw, 'owned');
    const machine = new Uint8Array(Buffer.from(identity.publicKeyRaw, 'base64'));
    const rid = await relayV2.ridOf(machine);
    const signer = await relayV2.signerFromKey(
      device.privateKey,
      new Uint8Array(Buffer.from(device.publicKeyRaw, 'base64')),
    );
    let ready!: () => void;
    const admitted = new Promise<void>((r) => {
      ready = r;
    });
    relay = new HubRelay({
      relayUrl: worker.wsUrl,
      identity,
      trust,
      dir,
      registry: new SessionRegistryFile(join(dir, 'live')),
      log: (m) => {
        if (m === 'Relay control admitted') ready();
      },
    });
    await relay.start();
    await admitted;
    socket = await Socket.open(clientUrl(worker, Buffer.from(rid).toString('hex')));
    await admit(socket, { signer, publicKey: signer.publicKey }, 'client', rid);
    await socket.json();
    await socket.json();
    const start = await relayV2.clientStart(
      { machinePublicKey: machine, device: signer, mode: 'resume', random: relayV2.systemRandom },
      Date.now(),
    );
    socket.sendText(start.hello);
    const auth = await start.onHelloAck(await socket.text(), Date.now());
    socket.sendText(auth.auth);
    const connected = socket;
    channel = await auth.onReady(await socket.text(), Date.now(), {
      emit: (bytes) => connected.sendBinary(bytes),
      close: (code) => connected.close(code),
    });
    expect(trust.removeAuthorizedKey(device.fingerprint)).toBe(true);
    expect(devices.isEnrolled(device.publicKeyRaw)).toBe(false);
    relay.broadcast(createSessionUpdate('owned-session', 'idle'));
    const frame = await socket.binary();
    const payload = await channel.receive(frame);
    const message = payload ? deserialize(new TextDecoder().decode(payload)) : null;

    expect(message?.type).not.toBe('session_update');
  } finally {
    socket?.close();
    await relay?.stop();
    await channel?.transportClosed();
    await worker.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
