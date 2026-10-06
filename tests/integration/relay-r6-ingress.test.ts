/** Actual source WebSocketServer/Connection and encrypted Hub/Worker/SQLite ingress.
 * Callbacks only observe whether legacy dispatch happened; no decision is simulated.
 * Native handler is deliberately refusal-only at this phase, not ledger acceptance.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import {
  type ProtocolMessage,
  createAnswer,
  createHello,
  createPing,
  deserialize,
  relayV2,
  serialize,
} from '@remi/shared';
import { WebSocketServer } from '../../packages/daemon/src/server/websocket-server.ts';
import { Socket } from '../../packages/signaling/tests/e2e/endpoints.ts';
import { resumed } from './relay-r3-fixture.ts';

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../packages/shared/tests/fixtures/relay-v2/native-answer-vectors.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cases: { name: string; message: relayV2.NativeAnswer }[] };
const native = fixtures.cases[0]?.message;
const structured = fixtures.cases.find((item) => item.name === 'structured-indices')?.message;
if (!native || !structured) throw new Error('owned native answer fixture missing');
const rawNative = JSON.stringify(native);
const invalid: [string, string][] = [
  [
    'native-first-legacy-last',
    rawNative.replace('"type":"native_answer"', '"type":"native_answer","type":"answer"'),
  ],
  [
    'legacy-first-native-last',
    rawNative.replace('"type":"native_answer"', '"type":"answer","type":"native_answer"'),
  ],
  [
    'escaped-native-first-legacy-last',
    rawNative.replace('"type":"native_answer"', '"type":"native_answer","\\u0074ype":"answer"'),
  ],
  [
    'escaped-legacy-first-native-last',
    rawNative.replace('"type":"native_answer"', '"\\u0074ype":"answer","type":"native_answer"'),
  ],
  [
    'nested-native-duplicate',
    JSON.stringify(structured).replace(
      '"questionIndex":',
      '"questionIndex":1,"question\\u0049ndex":',
    ),
  ],
  ['native-unknown-field', JSON.stringify({ ...native, injected: true })],
  ['native-json-cap', `${' '.repeat(16384)}${rawNative}`],
];

function legacyLargeDeep(): string {
  let extra: unknown = { leaf: 'type inside a string is not a root discriminator' };
  for (let i = 0; i < 32; i++) extra = { nested: [extra] };
  // Legacy JSON.parse semantics still apply outside the root discriminator.
  return JSON.stringify({
    ...createPing(),
    legacyPayload: 'x'.repeat(32768),
    extra,
    nestedDiscriminators: null,
    legacyRepeated: 0,
  })
    .replace(
      '"nestedDiscriminators":null',
      '"nestedDiscriminators":{"type":"answer","type":"native_answer"}',
    )
    .replace('"legacyRepeated":0', '"legacyRepeated":0,"legacyRepeated":1');
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('owned TCP port allocation failed');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function direct() {
  const legacy: string[] = [];
  const server = new WebSocketServer(
    { host: '127.0.0.1', port: await freePort(), connection: { skipHelloAck: true } },
    {
      onAnswer: (_connectionId, _sessionId, _questionId, answer) => {
        legacy.push(answer);
      },
    },
  );
  await server.start();
  try {
    const socket = await Socket.open(`ws://127.0.0.1:${server.port}/ws`);
    socket.sendText(serialize(createHello('owned-native-ingress-client', '2.0.0')));
    expect((await socket.json())['type']).toBe('ack');
    expect(server.allConnections).toHaveLength(1);
    return {
      server,
      socket,
      legacy,
      cleanup: async () => {
        socket.close();
        await server.stop();
      },
    };
  } catch (error) {
    await server.stop();
    throw error;
  }
}

async function encryptedReply(
  running: Awaited<ReturnType<typeof resumed>>,
): Promise<ProtocolMessage | null> {
  const bytes = await running.channel.receive(await running.socket.binary());
  return bytes ? deserialize(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null;
}

test('actual Connection returns correlated stale for repeated native ids without legacy dispatch or receipt substitution', async () => {
  const running = await direct();
  try {
    for (let i = 0; i < 2; i++) {
      running.socket.sendText(rawNative);
      expect(await running.socket.json()).toMatchObject({
        type: 'answer_result',
        requestId: native.id,
        sessionId: native.sessionId,
        questionId: native.questionId,
        outcome: 'stale',
      });
      expect(running.legacy).toEqual([]);
    }
    running.socket.sendText(
      serialize(createAnswer('owned-session', 'owned-question', 'legacy-control')),
    );
    expect((await running.socket.json())['type']).toBe('answer_result');
    expect(running.legacy).toEqual(['legacy-control']);
  } finally {
    await running.cleanup();
  }
});

test('actual Connection refuses root discriminator substitutions and strict native schema before legacy dispatch', async () => {
  const running = await direct();
  try {
    for (const [name, raw] of invalid) {
      running.socket.sendText(raw);
      expect(await running.socket.json(), name).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
      expect(running.legacy, name).toEqual([]);
      running.socket.sendText(serialize(createPing()));
      expect((await running.socket.json())['type'], `${name}: read half remains usable`).toBe(
        'pong',
      );
    }
  } finally {
    await running.cleanup();
  }
});

test('actual Connection preserves large deep legacy JSON and ignores nested discriminator-looking data', async () => {
  const running = await direct();
  try {
    running.socket.sendText(legacyLargeDeep());
    expect((await running.socket.json())['type']).toBe('pong');
    running.socket.sendText(
      JSON.stringify({
        ...createPing(),
        nested: { type: 'native_answer' },
        label: '"type":"native_answer"',
      }),
    );
    expect((await running.socket.json())['type']).toBe('pong');
  } finally {
    await running.cleanup();
  }
});

test('actual WebSocketServer rejects malformed binary UTF8 before replacement and keeps Connection usable', async () => {
  const running = await direct();
  try {
    // If lossy decoding occurs, these bytes become a structurally valid native request.
    // Keep the closing quote and all following JSON intact.
    const [before, after] = rawNative.split('"answer":"1"');
    if (before === undefined || after === undefined) throw new Error('owned UTF8 fixture setup');
    const bytes = Buffer.concat([
      Buffer.from(`${before}"answer":"`),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from(`"${after}`),
    ]);
    expect(JSON.parse(new TextDecoder().decode(bytes))['type']).toBe('native_answer');
    running.socket.sendBinary(bytes);
    expect(await running.socket.json()).toMatchObject({
      type: 'error',
      code: 'INVALID_MESSAGE',
      message: 'Failed to parse message',
    });
    expect(running.legacy).toEqual([]);
    running.socket.sendText(serialize(createPing()));
    expect((await running.socket.json())['type']).toBe('pong');
    // Correct binary UTF8 remains supported.
    running.socket.sendBinary(new TextEncoder().encode(rawNative));
    expect(await running.socket.json()).toMatchObject({
      type: 'answer_result',
      requestId: native.id,
      outcome: 'stale',
    });
  } finally {
    await running.cleanup();
  }
});

test('actual decrypted Hub returns correlated native refusal and preserves large deep legacy JSON', async () => {
  const legacy: string[] = [];
  const running = await resumed({
    onAnswer: (_cid, _sid, _qid, answer) => {
      legacy.push(answer);
    },
  });
  try {
    for (let i = 0; i < 2; i++) {
      await running.channel.send(new TextEncoder().encode(rawNative));
      expect(await encryptedReply(running)).toMatchObject({
        type: 'answer_result',
        requestId: native.id,
        sessionId: native.sessionId,
        questionId: native.questionId,
        outcome: 'stale',
      });
      expect(legacy).toEqual([]);
    }
    await running.channel.send(new TextEncoder().encode(legacyLargeDeep()));
    expect((await encryptedReply(running))?.type).toBe('pong');
  } finally {
    await running.cleanup();
  }
}, 15000);

for (const [name, raw] of invalid) {
  test(`actual decrypted Hub refuses ${name} before native or legacy dispatch`, async () => {
    const legacy: string[] = [];
    const running = await resumed({
      onAnswer: (_cid, _sid, _qid, answer) => {
        legacy.push(answer);
      },
    });
    try {
      // Either a refused close or an actual application response settles this observation.
      // A parser mutant reaches the assertion through its wrong response, not a timeout.
      const application = new Promise<{ kind: 'application'; message: ProtocolMessage | null }>(
        (resolve, reject) => {
          running.socket.tap((frame) => {
            if (typeof frame === 'string') {
              reject(new Error('unexpected plaintext after READY'));
              return;
            }
            void running.channel.receive(frame).then((bytes) => {
              if (bytes)
                resolve({
                  kind: 'application',
                  message: deserialize(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
                });
            }, reject);
          });
        },
      );
      await running.channel.send(new TextEncoder().encode(raw));
      const result = await Promise.race([
        application,
        running.socket.closed.then((close) => ({ kind: 'closed' as const, close })),
      ]);
      expect(result.kind, name).toBe('closed');
      if (result.kind === 'closed') expect(result.close.code).toBe(relayV2.FAILURE_CLOSE.code);
      expect(legacy, name).toEqual([]);
      expect(running.relay.connectionCount).toBe(0);
    } finally {
      await running.cleanup();
    }
  }, 15000);
}
