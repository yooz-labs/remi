/** Actual resumed E2E channel, HubRelay and real Worker/DO; no direct-token authority. */
import { expect, test } from 'bun:test';
import {
  type ProtocolMessage,
  createIdentity,
  createSecurePushRegisterRequest,
  createSecurePushUnregisterRequest,
  deserialize,
  relayV2,
  serialize,
} from '@remi/shared';
import { SecurePushStore } from '../../packages/daemon/src/notifications/secure-push-store.ts';
import { resumed } from './relay-r3-fixture.ts';

async function exchange(running: Awaited<ReturnType<typeof resumed>>, request: ProtocolMessage) {
  await running.channel.send(new TextEncoder().encode(serialize(request)));
  const bytes = await running.channel.receive(await running.socket.binary());
  return bytes ? deserialize(new TextDecoder().decode(bytes)) : null;
}

test('secure READY channel registers and unregisters its derived identity without a legacy token caller', async () => {
  let legacy = 0;
  const running = await resumed({
    onRegisterDeviceToken: () => legacy++,
    onUnregisterDeviceToken: () => legacy++,
  });
  try {
    const pair = await relayV2.generateEcPair();
    const request = createSecurePushRegisterRequest({
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: relayV2.b64u(pair.publicKey),
      keyVersion: 1,
    });
    expect(await exchange(running, request)).toMatchObject({
      type: 'secure_push_register_response',
      requestId: request.id,
      success: true,
      keyVersion: 1,
    });
    const store = new SecurePushStore(running.dir, running.trust);
    expect(store.listCurrent()).toHaveLength(1);
    expect(store.listCurrent()[0]?.publicKey).toBe(running.device.publicKeyRaw);
    expect(legacy).toBe(0);
    const unregister = createSecurePushUnregisterRequest();
    expect(await exchange(running, unregister)).toMatchObject({
      type: 'secure_push_unregister_response',
      requestId: unregister.id,
      success: true,
    });
    expect(store.listCurrent()).toHaveLength(0);
    expect(legacy).toBe(0);
  } finally {
    await running.cleanup();
  }
}, 10000);

test('secure READY registration refuses client authority selectors and off-curve keys with a correlated fixed response', async () => {
  const running = await resumed();
  try {
    const pair = await relayV2.generateEcPair();
    const registration = {
      token: 'ab'.repeat(32),
      environment: 'sandbox' as const,
      pushPublicKey: relayV2.b64u(pair.publicKey),
      keyVersion: 1,
    };
    const stranger = await createIdentity();
    for (const request of [
      { ...createSecurePushRegisterRequest(registration), devicePublicKey: stranger.publicKey },
      createSecurePushRegisterRequest({
        ...registration,
        pushPublicKey: relayV2.b64u(new Uint8Array(65).fill(4)),
      }),
    ]) {
      expect(await exchange(running, request)).toMatchObject({
        type: 'secure_push_register_response',
        requestId: request.id,
        success: false,
        error: 'INVALID_SUBSCRIPTION',
      });
      expect(new SecurePushStore(running.dir, running.trust).listCurrent()).toHaveLength(0);
    }
  } finally {
    await running.cleanup();
  }
}, 10000);

test('secure READY handler reports actual persisted subscription failure without legacy fallback', async () => {
  let legacy = 0;
  const running = await resumed({ onRegisterDeviceToken: () => legacy++ });
  try {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(running.dir, 'secure_push_subscriptions.json'), '{');
    const pair = await relayV2.generateEcPair();
    const request = createSecurePushRegisterRequest({
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: relayV2.b64u(pair.publicKey),
      keyVersion: 1,
    });
    expect(await exchange(running, request)).toMatchObject({
      type: 'secure_push_register_response',
      requestId: request.id,
      success: false,
      error: 'STORE_ERROR',
    });
    expect(legacy).toBe(0);
  } finally {
    await running.cleanup();
  }
}, 10000);

test('secure READY channel cannot regain authority after grant revoke and same-key reauthorization', async () => {
  const running = await resumed();
  try {
    const pair = await relayV2.generateEcPair();
    const request = createSecurePushRegisterRequest({
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: relayV2.b64u(pair.publicKey),
      keyVersion: 1,
    });
    expect(await exchange(running, request)).toMatchObject({
      type: 'secure_push_register_response',
      success: true,
    });
    running.trust.removeAuthorizedKey(running.device.fingerprint);
    await running.trust.addAuthorizedKey(
      running.device.publicKeyRaw,
      'synthetic replacement grant',
    );
    expect(running.relay.connectionCount).toBe(0);
    expect(new SecurePushStore(running.dir, running.trust).listCurrent()).toHaveLength(0);
    expect(running.relay.sendRaw(running.cid, createSecurePushUnregisterRequest())).toBe(false);
  } finally {
    await running.cleanup();
  }
}, 10000);
