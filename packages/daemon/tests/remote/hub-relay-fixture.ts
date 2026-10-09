/**
 * An owned real HubRelay, Worker/Durable Object and resumed enrolled device for the secure
 * subscription branch (#1200). Same shape as the root `relay-r3-fixture.ts`, with the HubRelay
 * configuration overridable so the sender-availability gate can be exercised.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ProtocolMessage,
  createHello,
  createIdentity,
  deserialize,
  relayV2,
  serialize,
  unlockIdentity,
} from '@remi/shared';
import { Socket, admit, clientUrl } from '../../../signaling/tests/e2e/endpoints.ts';
import { startWorker } from '../../../signaling/tests/e2e/harness.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { HubRelay, type HubRelayConfig } from '../../src/remote/hub-relay.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';

export async function resumedHub(config: Partial<HubRelayConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'remi-hub-secure-push-'));
  chmodSync(dir, 0o700);
  const worker = await startWorker();
  const trust = new IdentityStore(dir);
  await trust.generate();
  const identity = await trust.unlock();
  const device = await unlockIdentity(await createIdentity());
  await trust.addAuthorizedKey(device.publicKeyRaw, 'owned');
  await new RelayDeviceStore(dir, trust).add(device.publicKeyRaw, 'owned');
  const machine = new Uint8Array(Buffer.from(identity.publicKeyRaw, 'base64'));
  const rid = await relayV2.ridOf(machine);
  const signer = await relayV2.signerFromKey(
    device.privateKey,
    new Uint8Array(Buffer.from(device.publicKeyRaw, 'base64')),
  );
  let admitted!: () => void;
  const admission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const logs: string[] = [];
  const relay = new HubRelay({
    relayUrl: worker.wsUrl,
    identity,
    trust,
    dir,
    registry: new SessionRegistryFile(join(dir, 'live')),
    log: (message) => {
      logs.push(message);
      if (message === 'Relay control admitted') admitted();
    },
    ...config,
  });
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
  await channel.send(new TextEncoder().encode(serialize(createHello('owned-device', '2.0.0'))));
  const receipt = await channel.receive(await socket.binary());
  if (!receipt || deserialize(new TextDecoder().decode(receipt))?.type !== 'ack')
    throw new Error('MACHINE_HELLO_RECEIPT_MISSING');
  return {
    dir,
    trust,
    device,
    logs,
    exchange: async (request: ProtocolMessage) => {
      await channel.send(new TextEncoder().encode(serialize(request)));
      const bytes = await channel.receive(await socket.binary());
      return bytes ? deserialize(new TextDecoder().decode(bytes)) : null;
    },
    cleanup: async () => {
      socket.close();
      await relay.stop();
      await channel.transportClosed();
      await worker.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
