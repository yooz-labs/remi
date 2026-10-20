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
import { RelayDeviceStore } from '../../packages/daemon/src/remote/relay-device-store.ts';
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

test('secure READY channel cannot adopt a new real pairing generation or corrupt authority storage', async () => {
  const running = await resumed();
  try {
    expect(running.relay.connectionCount).toBe(1);
    await new RelayDeviceStore(running.dir, running.trust).add(
      running.device.publicKeyRaw,
      'synthetic new pairing',
    );
    expect(running.relay.connectionCount).toBe(0);
  } finally {
    await running.cleanup();
  }
  const corrupt = await resumed();
  try {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(corrupt.dir, 'relay_devices.json'), '{');
    expect(corrupt.relay.connectionCount).toBe(0);
  } finally {
    await corrupt.cleanup();
  }
}, 10000);

/** Only completion delivery is held AFTER the engine imported the actual P256 point. */
function holdNextPushImport() {
  const subtle = crypto.subtle;
  const actualImport = subtle.importKey;
  const descriptor = Object.getOwnPropertyDescriptor(subtle, 'importKey');
  let notify!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  Object.defineProperty(subtle, 'importKey', {
    configurable: true,
    value: async (...args: Parameters<SubtleCrypto['importKey']>) => {
      const actual = (await Reflect.apply(actualImport, subtle, args)) as CryptoKey;
      const algorithm = args[2];
      if (
        holding &&
        args[0] === 'raw' &&
        typeof algorithm === 'object' &&
        algorithm.name === 'ECDH'
      ) {
        holding = false;
        notify();
        await pending;
      }
      return actual;
    },
  });
  return {
    release,
    async reached() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('ACTUAL_PUSH_IMPORT_NOT_REACHED')), 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    restore() {
      release();
      if (descriptor) Object.defineProperty(subtle, 'importKey', descriptor);
      else Reflect.deleteProperty(subtle, 'importKey');
    },
  };
}

async function nextApplication(running: Awaited<ReturnType<typeof resumed>>) {
  const bytes = await running.channel.receive(await running.socket.binary());
  return bytes ? deserialize(new TextDecoder().decode(bytes)) : null;
}

test('later secure unregister cannot be undone by an earlier real registration preparation', async () => {
  const running = await resumed();
  const pair = await relayV2.generateEcPair();
  const held = holdNextPushImport();
  try {
    const register = createSecurePushRegisterRequest({
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: relayV2.b64u(pair.publicKey),
      keyVersion: 1,
    });
    await running.channel.send(new TextEncoder().encode(serialize(register)));
    await held.reached();
    const unregister = createSecurePushUnregisterRequest();
    expect(await exchange(running, unregister)).toMatchObject({
      type: 'secure_push_unregister_response',
      requestId: unregister.id,
      success: true,
    });
    held.release();
    expect(await nextApplication(running)).toMatchObject({
      type: 'secure_push_register_response',
      requestId: register.id,
    });
    expect(new SecurePushStore(running.dir, running.trust).listCurrent()).toHaveLength(0);
  } finally {
    held.restore();
    await running.cleanup();
  }
}, 10000);

test('latest valid secure registration keeps its recipient after earlier real preparation completes', async () => {
  const running = await resumed();
  const pair = await relayV2.generateEcPair();
  const held = holdNextPushImport();
  try {
    const earlier = createSecurePushRegisterRequest({
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: relayV2.b64u(pair.publicKey),
      keyVersion: 1,
    });
    await running.channel.send(new TextEncoder().encode(serialize(earlier)));
    await held.reached();
    const latest = createSecurePushRegisterRequest({ ...earlier, token: 'cd'.repeat(32) });
    expect(await exchange(running, latest)).toMatchObject({
      type: 'secure_push_register_response',
      requestId: latest.id,
      success: true,
    });
    held.release();
    expect(await nextApplication(running)).toMatchObject({
      type: 'secure_push_register_response',
      requestId: earlier.id,
    });
    expect(new SecurePushStore(running.dir, running.trust).listCurrent()[0]?.token).toBe(
      latest.token,
    );
  } finally {
    held.restore();
    await running.cleanup();
  }
}, 10000);

test('invalid authority selector cannot cancel an earlier valid secure registration preparation', async () => {
  const running = await resumed();
  const pair = await relayV2.generateEcPair();
  const held = holdNextPushImport();
  try {
    const valid = createSecurePushRegisterRequest({
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: relayV2.b64u(pair.publicKey),
      keyVersion: 1,
    });
    await running.channel.send(new TextEncoder().encode(serialize(valid)));
    await held.reached();
    const invalid = {
      ...createSecurePushRegisterRequest(valid),
      devicePublicKey: 'invalid-selector',
    };
    expect(await exchange(running, invalid)).toMatchObject({
      type: 'secure_push_register_response',
      requestId: invalid.id,
      success: false,
      error: 'INVALID_SUBSCRIPTION',
    });
    held.release();
    expect(await nextApplication(running)).toMatchObject({
      type: 'secure_push_register_response',
      requestId: valid.id,
      success: true,
    });
    expect(new SecurePushStore(running.dir, running.trust).listCurrent()[0]?.token).toBe(
      valid.token,
    );
  } finally {
    held.restore();
    await running.cleanup();
  }
}, 10000);
