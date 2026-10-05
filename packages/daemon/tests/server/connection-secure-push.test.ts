/**
 * Real direct Connection and protocol codecs. Only socket output is captured;
 * registration must use an enrolled READY relay peer, never direct/legacy token identity.
 * The P-256 public key is from the explicitly public synthetic crypto fixture.
 */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  type ProtocolMessage,
  createHello,
  createSecurePushRegisterRequest,
  createSecurePushUnregisterRequest,
  deserialize,
  serialize,
} from '@remi/shared';
import { Connection } from '../../src/server/connection.ts';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../shared/tests/fixtures/relay-v2/push-vectors.json', import.meta.url),
    'utf8',
  ),
) as { cases: Array<{ content: { pushPublicKey: string } }> };
const pushPublicKey = fixture.cases[0]?.content.pushPublicKey;
if (!pushPublicKey) throw new Error('no synthetic push public key');
const connections: Connection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close('owned test cleanup');
});

for (const operation of ['register', 'unregister'] as const) {
  test(`direct secure push ${operation} returns a correlated UNSUPPORTED result without legacy registration`, () => {
    const sent: ProtocolMessage[] = [];
    const legacy: string[] = [];
    const connection = new Connection(
      {
        readyState: WebSocket.OPEN,
        send: (raw) => {
          const message = deserialize(raw);
          if (message) sent.push(message);
        },
        close: () => {},
      },
      {
        onRegisterDeviceToken: () => legacy.push('register'),
        onUnregisterDeviceToken: () => legacy.push('unregister'),
      },
    );
    connections.push(connection);
    connection.handleMessage(serialize(createHello('synthetic-direct-client', '1.0.0')));
    const request =
      operation === 'register'
        ? createSecurePushRegisterRequest({
            token: 'ab'.repeat(32),
            environment: 'sandbox',
            pushPublicKey,
            keyVersion: 1,
          })
        : createSecurePushUnregisterRequest();
    connection.handleMessage(serialize(request));
    const response = sent.find((message) => message.type === `secure_push_${operation}_response`);
    expect(response).toBeDefined();
    expect(response).toMatchObject({ requestId: request.id, success: false, error: 'UNSUPPORTED' });
    expect(legacy).toEqual([]);
    expect(sent.filter((message) => message.type === 'error')).toEqual([]);
  });
}
