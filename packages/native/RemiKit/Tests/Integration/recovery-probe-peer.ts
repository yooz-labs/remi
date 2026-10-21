/** Hostile owned wire peer plus real Bonjour publisher; never substitutes for a source hub. */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createInterface } from 'node:readline';
import { MdnsPublisher } from '../../../../daemon/src/mdns/mdns-publisher.ts';

const mode = process.argv[2] ?? 'wrong-key';
const trusted = generateKeyPairSync('ed25519');
const signer = mode === 'wrong-key' ? generateKeyPairSync('ed25519') : trusted;
const raw = (key: typeof trusted.publicKey) =>
  key.export({ type: 'spki', format: 'der' }).subarray(-32);
const expected = process.argv[3] ? Buffer.from(process.argv[3], 'base64') : raw(trusted.publicKey);
if (expected.length !== 32) throw new Error('Expected owned public key');
const digest = createHash('sha256').update(expected).digest('hex');
const challenge = randomBytes(32);
const frame = (type: string, fields = {}) =>
  JSON.stringify({ type, id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...fields });
const question = await Bun.file(
  new URL('../../../../shared/tests/fixtures/protocol/question.json', import.meta.url),
).json();
let opens = 0;
let authenticationResponses = 0;
let operations = 0;
const server = Bun.serve({
  hostname: process.env['REMI_RECOVERY_PEER_BIND'] ?? '::',
  port: 0,
  fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 400 });
  },
  websocket: {
    open(ws) {
      opens += 1;
      ws.send(
        frame('auth_challenge', {
          challenge: challenge.toString('base64'),
          serverPublicKey: raw(signer.publicKey).toString('base64'),
          // A malicious advertisement and challenge may copy the saved short hash.
          serverFingerprint: digest.slice(0, 16),
        }),
      );
    },
    message(ws, bytes) {
      const message = JSON.parse(String(bytes)) as { type: string };
      if (message.type === 'auth_response') {
        authenticationResponses += 1;
        if (mode.startsWith('refusal-')) {
          ws.send(frame('auth_result', { success: false, error: mode.slice('refusal-'.length) }));
          return;
        }
        ws.send(
          frame('auth_result', {
            success: true,
            serverSignature: sign(null, challenge, signer.privateKey).toString('base64'),
          }),
        );
        ws.send(
          frame('hello_ack', {
            serverVersion: 'test',
            sessionId: mode === 'session-hello' ? crypto.randomUUID() : null,
            protocolVersion: 1,
            capabilities: [],
            machine: {
              id: digest.slice(0, 32),
              name: 'Owned peer',
              platform: 'darwin',
              remiVersion: 'test',
              harnesses: ['claude'],
              capabilities: [],
            },
          }),
        );
        if (mode === 'overflow')
          for (let index = 0; index < 160; index += 1) ws.send(JSON.stringify(question));
        if (mode === 'hello-close') setTimeout(() => ws.close(), 10);
      } else if (!['hello', 'ack', 'pong'].includes(message.type)) {
        operations += 1;
      }
    },
  },
});
const publisher = new MdnsPublisher({
  port: server.port ?? 0,
  version: 'owned-hostile-peer',
  authEnabled: true,
  role: 'hub',
  fingerprint: digest.slice(0, 16),
  name: `remi-recovery-${crypto.randomUUID()}`,
  probe: false,
});
const out = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
let cleanup: Promise<void> | undefined;
const stop = () => {
  cleanup ??= publisher.stop().finally(() => {
    server.stop(true);
  });
  return cleanup;
};
const deadline = setTimeout(() => {
  void stop().then(() => process.exit(1));
}, 45000);
process.on('SIGTERM', () => {
  void stop().then(() => process.exit(0));
});
try {
  await publisher.start();
  out({ port: server.port, publicKey: expected.toString('base64') });
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'stats') out({ opens, authenticationResponses, operations });
  }
} finally {
  clearTimeout(deadline);
  await stop();
}
