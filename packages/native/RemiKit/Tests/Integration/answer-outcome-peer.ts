/** Controlled local wire peer. It exercises the production Swift connection and store;
 * it is not a substitute for the source daemon or a device acceptance test. */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const mode = process.argv[2];
const key = generateKeyPairSync('ed25519');
const raw = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const challenge = randomBytes(32);
const fixtures = new URL('../../../../shared/tests/fixtures/protocol/', import.meta.url);
const question = await Bun.file(new URL('question_claude_permission.json', fixtures)).json();
const hello = await Bun.file(new URL('hello_ack_legacy.json', fixtures)).json();
const sessionId = '108a8a9e-912e-4d52-9fdd-913c16654f5c';
const questionId = 'a7b9dd3b-40cc-4a37-b254-3c544f2853f3';
const harnessId = '09a9e195-b1af-4bd5-b9bf-e64855b16d36';
question.sessionId = sessionId;
question.question.id = questionId;
question.claudeSessionId = harnessId;
question.harnessSessionId = harnessId;
hello.sessionId = sessionId;
hello.claudeSessionId = harnessId;
hello.harnessSessionId = harnessId;
const frame = (type: string, fields = {}) =>
  JSON.stringify({ type, id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...fields });
let answerCount = 0;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.send(
        frame('auth_challenge', {
          challenge: challenge.toString('base64'),
          serverPublicKey: raw.toString('base64'),
          serverFingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 16),
        }),
      );
    },
    message(ws, bytes) {
      const message = JSON.parse(String(bytes));
      if (message.type === 'auth_response') {
        ws.send(
          frame('auth_result', {
            success: true,
            serverSignature: sign(null, challenge, key.privateKey).toString('base64'),
          }),
        );
        ws.send(JSON.stringify(hello));
        ws.send(JSON.stringify(question));
      } else if (message.type === 'session_list_request') {
        ws.send(frame('session_list_response', { requestId: message.id, sessions: [] }));
      } else if (message.type === 'answer') {
        answerCount += 1;
        const fields = {
          requestId: message.id,
          sessionId: message.sessionId,
          questionId: message.questionId,
          outcome: mode === 'non-string' ? 7 : mode,
        };
        if (mode.startsWith('mismatch-')) {
          const wrong = crypto.randomUUID();
          const overrides =
            mode === 'mismatch-request'
              ? { requestId: wrong }
              : mode === 'mismatch-session'
                ? { sessionId: wrong }
                : { questionId: wrong };
          ws.send(frame('answer_result', { ...fields, ...overrides, outcome: 'delivered' }));
          setTimeout(() => {
            if (ws.readyState === 1)
              ws.send(frame('answer_result', { ...fields, outcome: 'stale-binding' }));
          }, 30);
        } else {
          ws.send(frame('answer_result', fields));
        }
      }
    },
  },
});
process.stdout.write(
  `${JSON.stringify({ port: server.port, publicKey: raw.toString('base64'), sessionId, questionId })}\n`,
);
for await (const _ of Bun.stdin.stream()) break;
server.stop(true);
await Bun.write('peer-result.json', JSON.stringify({ answerCount }));
