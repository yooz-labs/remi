/** Owned real HubRelay/Worker/resumed device, used only for transport fault pins. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createIdentity, relayV2, unlockIdentity } from '@remi/shared';
import type { AdapterEvents } from '../../packages/daemon/src/adapters/connection-adapter.ts';
import { IdentityStore } from '../../packages/daemon/src/auth/identity-store.ts';
import { HubRelay } from '../../packages/daemon/src/remote/hub-relay.ts';
import { RelayDeviceStore } from '../../packages/daemon/src/remote/relay-device-store.ts';
import { SessionRegistryFile } from '../../packages/daemon/src/session/session-registry-file.ts';
import { Socket, admit, clientUrl } from '../../packages/signaling/tests/e2e/endpoints.ts';
import { startWorker } from '../../packages/signaling/tests/e2e/harness.ts';
export async function resumed(events: Partial<AdapterEvents> = {}) {
  const dir = mkdtempSync('/private/tmp/remi-r3-fixture-');
  chmodSync(dir, 0o700);
  const worker = await startWorker();
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
  const logs: string[] = [];
  let admitted!: () => void;
  const admission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const relay = new HubRelay(
    {
      relayUrl: worker.wsUrl,
      identity,
      trust,
      dir,
      registry: new SessionRegistryFile(join(dir, 'live')),
      log: (message) => {
        logs.push(message);
        if (message === 'Relay control admitted') admitted();
      },
    },
    events,
  );
  await relay.start();
  await admission;
  const socket = await Socket.open(clientUrl(worker, Buffer.from(rid).toString('hex')));
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
  const channel = await auth.onReady(await socket.text(), Date.now(), {
    emit: (bytes) => socket.sendBinary(bytes),
    close: (code) => socket.close(code),
  });
  const cleanup = async () => {
    socket.close();
    await relay.stop();
    await channel.transportClosed();
    await worker.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, worker, trust, devices, device, relay, socket, channel, logs, cleanup };
}
