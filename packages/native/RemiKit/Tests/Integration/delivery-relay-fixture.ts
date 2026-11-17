/** Real Worker/DO, HubRelay and native peer; observes metadata without replacing route logic. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type ProtocolMessage,
  createHelloAck,
  createSessionListResponse,
  relayV2,
} from '@remi/shared';
import { IdentityStore } from '../../../../daemon/src/auth/identity-store';
import { HubRelay } from '../../../../daemon/src/remote/hub-relay';
import { RelayDeviceStore } from '../../../../daemon/src/remote/relay-device-store';
import { SessionRegistryFile } from '../../../../daemon/src/session/session-registry-file';
import { startWorker } from '../../../../signaling/tests/e2e/harness';

const publicKey = process.argv[2];
if (!publicKey) throw new Error('owned public identity required');
console.log = (...args) => console.error(...args);
const directory = mkdtempSync(join(tmpdir(), 'remi-delivery-relay-'));
const trust = new IdentityStore(directory);
await trust.generate();
await trust.addAuthorizedKey(publicKey, 'owned-native-delivery');
await new RelayDeviceStore(directory, trust).add(publicKey, 'owned-native-delivery');
const identity = await trust.unlock();
const worker = await startWorker();
let admissions = 0;
const inputs: string[] = [];
const relay = new HubRelay(
  {
    relayUrl: worker.wsUrl,
    identity,
    trust,
    dir: directory,
    registry: new SessionRegistryFile(join(directory, 'live')),
    log: (message) => {
      if (message === 'Relay control admitted') admissions++;
    },
  },
  {
    onConnect: (id) => {
      relay.sendRaw(id, createHelloAck('owned-delivery-relay', null));
    },
    onSessionListRequest: (id, request) => {
      relay.sendRaw(id, createSessionListResponse([], request));
    },
  },
);
// Observe entry to the actual production route, then delegate unchanged. This is an ingress
// trace of real authenticated frames, not a replacement handler or an expected outcome stub.
const observable = relay as unknown as {
  route(peer: unknown, message: ProtocolMessage): Promise<void>;
};
const route = observable.route.bind(relay);
observable.route = async (peer, message) => {
  if (message.type === 'user_input') inputs.push(message.id);
  await route(peer, message);
};
const lines = createInterface({ input: process.stdin });
let cleanup: Promise<void> | undefined;
function stop() {
  cleanup ??= (async () => {
    lines.close();
    await relay.stop();
    await worker.stop();
  })();
  return cleanup;
}
process.once('SIGTERM', () => {
  void stop();
});
process.once('SIGINT', () => {
  void stop();
});
async function admitted(after: number) {
  const deadline = Date.now() + 10000;
  while (admissions <= after) {
    if (Date.now() >= deadline) throw new Error('owned relay admission deadline');
    await Bun.sleep(10);
  }
}
const out = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  await relay.start();
  await admitted(0);
  out({
    kind: 'ready',
    relayURL: worker.wsUrl,
    machinePublicKey: relayV2.b64u(new Uint8Array(Buffer.from(identity.publicKeyRaw, 'base64'))),
  });
  for await (const line of lines) {
    if (line === 'restart') {
      const previous = admissions;
      await relay.stop();
      await relay.start();
      await admitted(previous);
      out({ kind: 'restarted' });
    } else if (line === 'stats') out({ kind: 'stats', inputs });
    else if (line === 'stop') break;
  }
} finally {
  await stop();
}
