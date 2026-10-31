/** Real Worker/DO, HubRelay and native peer; observes metadata without replacing route logic. */
import { mkdtempSync, rmSync } from 'node:fs';
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
let dropBeforeHello = process.argv[3] === 'prehello';
let preHelloDrops = 0;
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
      if (dropBeforeHello) {
        const peer = observable.peers.get(id);
        if (!peer || peer.stage !== 'ready') throw new Error('Expected owned READY peer');
        preHelloDrops++;
        peer.ws.close(1011, 'owned loss before application hello');
        return;
      }
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
  peers: Map<
    string,
    {
      stage: string;
      ws: WebSocket;
      channel?: { send(bytes: Uint8Array): Promise<void>; bye(): Promise<void> };
    }
  >;
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
    rmSync(directory, { recursive: true, force: true });
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
    if (line === 'prehello-on') {
      dropBeforeHello = true;
      out({ kind: 'prehello-on' });
    } else if (line === 'drop' || line === 'corrupt' || line === 'bye') {
      const ready = [...observable.peers.values()].filter((peer) => peer.stage === 'ready');
      if (ready.length !== 1)
        throw new Error(`Expected one owned ready peer, found ${ready.length}`);
      const peer = ready[0]!;
      if (line === 'drop') {
        // Close only the owned server-side pipe, without emitting an authenticated BYE.
        peer.ws.close(1011, 'owned synthetic transport loss');
      } else {
        if (!peer.channel) throw new Error('Expected owned encrypted channel');
        if (line === 'bye') await peer.channel.bye();
        else await peer.channel.send(new TextEncoder().encode('{'));
      }
      out({ kind: line === 'drop' ? 'dropped' : line });
    } else if (line === 'restart') {
      const previous = admissions;
      await relay.stop();
      await relay.start();
      await admitted(previous);
      out({ kind: 'restarted' });
    } else if (line === 'stats') out({ kind: 'stats', inputs, preHelloDrops });
    else if (line === 'stop') break;
  }
} finally {
  await stop();
}
