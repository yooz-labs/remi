/** Actual encrypted peers, HubRelay and local Worker/DO exercise scope at ingress and egress. */
import { afterEach, expect, test } from 'bun:test';
import {
  type ProtocolMessage,
  createError,
  createSecurePushRegisterRequest,
  createSecurePushUnregisterRequest,
  relayV2,
  serialize,
} from '@remi/shared';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { resumedHub } from './hub-relay-fixture.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function start() {
  const hub = await resumedHub({}, true);
  cleanup.push(hub.cleanup);
  return hub;
}

test('notification-only encrypted channel registers and unregisters without application Hello', async () => {
  const hub = await start();
  const pair = await relayV2.generateEcPair();
  expect(
    await hub.exchange(
      createSecurePushRegisterRequest({
        token: 'ab'.repeat(32),
        environment: 'sandbox',
        pushPublicKey: relayV2.b64u(pair.publicKey),
        keyVersion: 1,
      }),
    ),
  ).toMatchObject({ type: 'secure_push_register_response', success: true });
  expect(new SecurePushStore(hub.dir, hub.trust).listCurrent()).toHaveLength(1);
  expect(await hub.exchange(createSecurePushUnregisterRequest())).toMatchObject({
    type: 'secure_push_unregister_response',
    success: true,
  });
  expect(new SecurePushStore(hub.dir, hub.trust).listCurrent()).toEqual([]);
}, 15000);

test('notification-only channel receives no machine broadcasts, including general errors', async () => {
  const hub = await start();
  hub.relay.broadcast(createError('OWNED_BROADCAST', 'PRIVATE_BROADCAST_SENTINEL'));
  const question = await Bun.file(
    new URL('../../../shared/tests/fixtures/protocol/question.json', import.meta.url),
  ).json();
  hub.relay.broadcast(question);
  expect(await hub.quiet(150)).toBe(true);
}, 15000);

for (const name of [
  'hello',
  'session_list_request',
  'user_input',
  'answer',
  'create_session_request',
  'transcript_load_request',
  'session_terminal_open',
]) {
  test(`notification-only channel refuses ${name} before any application effect`, async () => {
    const hub = await start();
    const message: ProtocolMessage = await Bun.file(
      new URL(`../../../shared/tests/fixtures/protocol/${name}.json`, import.meta.url),
    ).json();
    await hub.sendApplication(new TextEncoder().encode(serialize(message)));
    const closed = await Promise.race([
      hub.closed,
      Bun.sleep(3000).then(() => {
        throw new Error('NOTIFICATION_SCOPE_CLOSE_DEADLINE');
      }),
    ]);
    expect(closed.code).toBe(relayV2.FAILURE_CLOSE.code);
    expect(new SecurePushStore(hub.dir, hub.trust).listCurrent()).toEqual([]);
  }, 15000);
}
