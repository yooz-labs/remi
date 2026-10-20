/** Adversarial wire peer, not a daemon substitute. Exercises the real Swift socket/handshake. */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const mode = process.argv[2];
const trusted = generateKeyPairSync('ed25519');
const signer = mode === 'wrong-key' ? generateKeyPairSync('ed25519') : trusted;
const raw = (key: typeof trusted.publicKey) =>
  key.export({ type: 'spki', format: 'der' }).subarray(-32);
const digest = (key: typeof trusted.publicKey) =>
  createHash('sha256').update(raw(key)).digest('hex');
const challenge = randomBytes(32);
const fixtures = new URL('../../../../shared/tests/fixtures/protocol/', import.meta.url);
const question = await Bun.file(new URL('question.json', fixtures)).json();
const hello = await Bun.file(new URL('hello_ack_legacy.json', fixtures)).json();
const frame = (type: string, fields = {}) =>
  JSON.stringify({ type, id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...fields });
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 400 });
  },
  websocket: {
    open(ws) {
      if (mode === 'preauth') {
        ws.send(JSON.stringify(question));
        return;
      }
      if (mode === 'legacy') {
        ws.send(
          frame('ack', {
            ack: { messageId: 'hello', state: 'delivered', timestamp: new Date().toISOString() },
          }),
        );
        ws.send(JSON.stringify(hello));
        ws.send(JSON.stringify(question));
        return;
      }
      ws.send(
        frame('auth_challenge', {
          challenge: challenge.toString('base64'),
          serverPublicKey: raw(signer.publicKey).toString('base64'),
          serverFingerprint: digest(signer.publicKey).slice(0, 16),
        }),
      );
    },
    message(ws, bytes) {
      const message = JSON.parse(String(bytes));
      if (message.type === 'auth_response') {
        ws.send(
          frame('auth_result', {
            success: true,
            serverSignature: sign(null, challenge, signer.privateKey).toString('base64'),
          }),
        );
        // Connection.handleHello sends its receipt before the async daemon hello.
        ws.send(
          frame('ack', {
            ack: { messageId: 'hello', state: 'delivered', timestamp: new Date().toISOString() },
          }),
        );
        if (mode === 'admitted') ws.send(JSON.stringify(hello));
        if (mode === 'prehello-list')
          ws.send(frame('session_list_response', { requestId: 'early', sessions: [] }));
        else ws.send(JSON.stringify(question));
      }
      if (message.type === 'session_list_request')
        ws.send(frame('session_list_response', { requestId: message.id, sessions: [] }));
    },
  },
});
process.stdout.write(
  `${JSON.stringify({ port: server.port, machineID: digest(trusted.publicKey).slice(0, 32) })}\n`,
);
for await (const _ of Bun.stdin.stream()) break;
server.stop(true);
