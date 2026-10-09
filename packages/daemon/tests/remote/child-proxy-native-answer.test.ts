/** ChildProxy native answers against a real child WebSocket server (#1201).
 * No proxy, registry or socket is replaced: the child is a real Bun WebSocket server
 * that fails the way a real child can, and the proxy reads its real registry.
 */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AnswerResultOutcome,
  type NativeAnswerMessage,
  createAnswerResult,
  createHelloAck,
  createIdentity,
  deserialize,
  generateId,
  relayV2,
  serialize,
  unlockIdentity,
} from '@remi/shared';
import { CAPABILITY_HEADER, loadOrCreateCapabilityToken } from '../../src/auth/capability-token.ts';
import { ChildProxy } from '../../src/remote/child-proxy.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

type ChildBehavior = 'close-after-hello' | 'ack-then-hold' | 'ack-then-answer';

async function fixture(behavior: ChildBehavior, delayMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'remi-child-native-'));
  chmodSync(dir, 0o700);
  const previous = process.env['REMI_HOME'];
  process.env['REMI_HOME'] = dir;
  const token = loadOrCreateCapabilityToken(join(dir, 'capability.key'));
  const sessionId = generateId();
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (req.headers.get(CAPABILITY_HEADER) !== token)
        return new Response('denied', { status: 401 });
      if (srv.upgrade(req)) return;
      return new Response('bad', { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const message = deserialize(String(data));
        if (!message) throw new Error('INVALID_FIXTURE_REQUEST');
        received.push(message.type);
        if (message.type === 'hello') {
          setTimeout(() => {
            if (behavior === 'close-after-hello') ws.close();
            else
              ws.send(serialize(createHelloAck('2.0.0', sessionId, { attachState: 'attached' })));
          }, delayMs);
        } else if (message.type === 'native_answer' && behavior === 'ack-then-answer') {
          ws.send(
            serialize(
              createAnswerResult(message.id, message.sessionId, message.questionId, 'delivered'),
            ),
          );
        }
      },
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error('MISSING_FIXTURE_PORT');
  const registry = new SessionRegistryFile(join(dir, 'live'));
  const entry = {
    sessionId,
    pid: process.pid,
    wsPort: port,
    hookPort: 1,
    projectPath: dir,
    name: 'owned',
    startedAt: '2026-01-01T00:00:00Z',
  };
  registry.register(entry);
  const proxy = new ChildProxy(
    registry,
    'owned-device',
    () => {},
    () => {},
    () => true,
  );
  cleanups.push(() => {
    proxy.close();
    server.stop(true);
    if (previous === undefined) Reflect.deleteProperty(process.env, 'REMI_HOME');
    else process.env['REMI_HOME'] = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const device = await unlockIdentity(await createIdentity());
  const signer = await relayV2.signerFromKey(
    device.privateKey,
    new Uint8Array(Buffer.from(device.publicKeyRaw, 'base64')),
  );
  const machineIdentity = await unlockIdentity(await createIdentity());
  const machine = await relayV2.signerFromKey(
    machineIdentity.privateKey,
    new Uint8Array(Buffer.from(machineIdentity.publicKeyRaw, 'base64')),
  );
  async function proof(): Promise<NativeAnswerMessage> {
    const now = Math.floor(Date.now() / 1000);
    const unsigned: relayV2.UnsignedNativeAnswer = {
      type: 'native_answer',
      v: 2,
      id: generateId(),
      timestamp: new Date(now * 1000).toISOString(),
      rid: 'ab'.repeat(16),
      machinePublicKey: relayV2.b64u(machine.publicKey),
      devicePublicKey: relayV2.b64u(signer.publicKey),
      sessionId,
      runtimeInstance: relayV2.b64u(relayV2.systemRandom(32)),
      questionId: generateId(),
      collapseId: relayV2.b64u(relayV2.systemRandom(16)),
      revision: 1,
      contentDigest: relayV2.b64u(relayV2.systemRandom(32)),
      nonce: relayV2.b64u(relayV2.systemRandom(32)),
      issuedAt: now,
      expiresAt: now + 30,
      answer: '1',
    };
    return {
      ...unsigned,
      signature: relayV2.b64u(
        await signer.sign(await relayV2.buildNativeAnswerSigningInput(unsigned)),
      ),
    };
  }
  const answers = () => (proxy as unknown as { answers: Map<string, unknown> }).answers;
  return { proxy, registry, entry, received, proof, answers };
}

async function settled(
  result: Promise<AnswerResultOutcome>,
  ms: number,
): Promise<AnswerResultOutcome | 'STILL_PENDING'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<'STILL_PENDING'>((resolve) => {
    timer = setTimeout(() => resolve('STILL_PENDING'), ms);
  });
  try {
    return await Promise.race([result, pending]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('a coalesced identical proof settles when the first caller fails before any child result (#1201)', async () => {
  const f = await fixture('close-after-hello', 150);
  const proof = await f.proof();
  const first = f.proxy.nativeAnswer(proof);
  await Bun.sleep(50);
  const second = f.proxy.nativeAnswer(structuredClone(proof));
  // Both ride one child connection that dies before it acknowledges anything.
  expect(await settled(first, 3000)).toBe('uncertain');
  expect(await settled(second, 1000)).toBe('uncertain');
  expect(f.answers().size).toBe(0);
  // The failure retained nothing: an identical proof afterward is a new forward, not a stuck waiter.
  expect(await settled(f.proxy.nativeAnswer(structuredClone(proof)), 3000)).toBe('uncertain');
});

test('a coalesced identical proof settles when the child registration changes under the first caller (#1201)', async () => {
  const f = await fixture('ack-then-hold', 150);
  const proof = await f.proof();
  const first = f.proxy.nativeAnswer(proof);
  await Bun.sleep(50);
  const second = f.proxy.nativeAnswer(structuredClone(proof));
  // The live entry now names another generation, so the proxy refuses to send to the old socket.
  f.registry.register({ ...f.entry, startedAt: '2026-01-01T00:00:01Z' });
  expect(await settled(first, 3000)).toBe('uncertain');
  expect(await settled(second, 1000)).toBe('uncertain');
  expect(f.answers().size).toBe(0);
});

test('coalescing still shares one real child result and one wire frame (#1201)', async () => {
  const f = await fixture('ack-then-answer', 50);
  const proof = await f.proof();
  const first = f.proxy.nativeAnswer(proof);
  const second = f.proxy.nativeAnswer(structuredClone(proof));
  expect(await settled(first, 3000)).toBe('delivered');
  expect(await settled(second, 1000)).toBe('delivered');
  expect(f.received.filter((type) => type === 'native_answer')).toHaveLength(1);
});
