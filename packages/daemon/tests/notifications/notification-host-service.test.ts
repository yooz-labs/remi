/** Real direct authentication, identity files, encrypted host/Worker and subscription stores. */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type NotificationHostResponse,
  createAuthResponse,
  createHello,
  createIdentity,
  createNotificationHostRequest,
  createNotificationHostResponse,
  deserialize,
  fromBase64,
  generateId,
  relayV2,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { Mailbox } from '../../../signaling/tests/e2e/endpoints.ts';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { NotificationHostService } from '../../src/notifications/notification-host-service.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { NotificationDeviceStore } from '../../src/remote/notification-device-store.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { WebSocketServer } from '../../src/server/websocket-server.ts';
import { resumedHub } from '../remote/hub-relay-fixture.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(
  capabilityOnly = false,
  leaseMs = 30 * 24 * 60 * 60 * 1000,
  relayUrl = 'wss://relay.example',
) {
  const hub = await resumedHub({ pushLeaseMs: leaseMs });
  cleanups.push(hub.cleanup);
  const device = await unlockIdentity(await createIdentity());
  await hub.trust.addAuthorizedKey(device.publicKeyRaw, 'owned direct notification device');
  const subscriptions = new SecurePushStore(hub.dir, hub.trust, 64, { leaseMs });
  let senderReady = true;
  let afterStart: (() => void) | undefined;
  const server = new WebSocketServer(
    {
      host: '127.0.0.1',
      port: 0,
      capabilityToken: 'owned-notification-capability',
      connection: {
        authenticator: new Authenticator({
          identity: await hub.trust.unlock(),
          identityStore: hub.trust,
        }),
      },
    },
    {
      onNotificationHostRequest: (id, request) => {
        const result = service.handle(id, request);
        afterStart?.();
        void result.then((value) =>
          server.sendTo(id, createNotificationHostResponse(request.id, value)),
        );
      },
    },
  );
  const service = new NotificationHostService({
    directory: hub.dir,
    trust: hub.trust,
    subscriptions,
    relay: () => hub.relay,
    senderReady: () => senderReady,
    relayUrl,
    client: (id) => {
      const connection = server.getConnection(id);
      const publicKey = connection?.connectionClientPublicKey;
      return connection && publicKey && connection.connectionState === 'connected'
        ? {
            publicKey,
            isCurrent: () =>
              server.getConnection(id) === connection && connection.connectionState === 'connected',
          }
        : null;
    },
  });
  await server.start();
  cleanups.push(() => server.stop());
  const inbox = new Mailbox<NotificationHostResponse>();
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws`,
    capabilityOnly
      ? ({ headers: { 'x-remi-capability': 'owned-notification-capability' } } as never)
      : undefined,
  );
  cleanups.push(async () => {
    socket.close();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('OWNED_DIRECT_AUTH_DEADLINE')), 3000);
    const hello = () =>
      socket.send(serialize(createHello(generateId(), 'owned-notification-test')));
    socket.onopen = () => {
      if (capabilityOnly) hello();
    };
    socket.onerror = () => reject(new Error('OWNED_DIRECT_SOCKET_FAILED'));
    socket.onmessage = (event) => {
      const message = deserialize(String(event.data));
      if (!message) return;
      if (message.type === 'auth_challenge') {
        void sign(device.privateKey, fromBase64(message.challenge)).then((signature) =>
          socket.send(
            serialize(createAuthResponse(device.publicKeyRaw, signature, device.fingerprint)),
          ),
        );
      } else if (message.type === 'auth_result') {
        if (message.success) hello();
        else reject(new Error('OWNED_DIRECT_AUTH_FAILED'));
      } else if (message.type === 'hello_ack') resolve();
      else if (message.type === 'notification_host_response') inbox.push(message);
    };
  }).finally(() => clearTimeout(timer));
  const exchange = async (action: Parameters<typeof createNotificationHostRequest>[0]) => {
    const request = createNotificationHostRequest(action);
    socket.send(serialize(request));
    const response = await inbox.next();
    expect(response.requestId).toBe(request.id);
    return response;
  };
  return {
    hub,
    device,
    subscriptions,
    service,
    server,
    socket,
    exchange,
    sender: (ready: boolean) => {
      senderReady = ready;
    },
    afterStart: (callback: () => void) => {
      afterStart = callback;
    },
  };
}

test('direct paired identity bootstraps only its own encrypted notification scope', async () => {
  const f = await fixture();
  expect(await f.exchange('enable')).toMatchObject({
    success: true,
    state: 'registration_required',
    relayUrl: 'wss://relay.example',
  });
  expect(
    new NotificationDeviceStore(f.hub.dir, f.hub.trust).isEnrolled(f.device.publicKeyRaw),
  ).toBe(true);
  expect(new RelayDeviceStore(f.hub.dir, f.hub.trust).isEnrolled(f.device.publicKeyRaw)).toBe(
    false,
  );
  expect(f.subscriptions.listCurrent()).toEqual([]);
}, 15000);

test('a capability-only local utility cannot select a device or enroll notifications', async () => {
  const f = await fixture(true);
  expect(await f.exchange('enable')).toMatchObject({ success: false, error: 'NOT_AUTHORIZED' });
  expect(new NotificationDeviceStore(f.hub.dir, f.hub.trust).list()).toEqual([]);
}, 15000);

test('supported HTTPS signaling roots bootstrap a canonical WSS notification route', async () => {
  const f = await fixture(false, 30 * 24 * 60 * 60 * 1000, 'https://relay.example');
  expect(await f.exchange('enable')).toMatchObject({
    success: true,
    state: 'registration_required',
    relayUrl: 'wss://relay.example',
  });
}, 15000);

test('host setup failure is explicit and does not create an unserviceable enrollment', async () => {
  const f = await fixture();
  f.sender(false);
  expect(await f.exchange('enable')).toMatchObject({
    success: false,
    error: 'HOST_SETUP_REQUIRED',
  });
  expect(new NotificationDeviceStore(f.hub.dir, f.hub.trust).list()).toEqual([]);
}, 15000);

test('grant revocation across asynchronous enrollment preparation prevents its commit', async () => {
  const f = await fixture();
  f.afterStart(() => {
    f.hub.trust.removeAuthorizedKey(f.device.fingerprint);
  });
  expect(await f.exchange('enable')).toMatchObject({ success: false, error: 'NOT_AUTHORIZED' });
  expect(new NotificationDeviceStore(f.hub.dir, f.hub.trust).list()).toEqual([]);
}, 15000);

test('unavailable delivery setup still persists inactive expiry before a later reconnect', async () => {
  const f = await fixture(false, 1000);
  await f.exchange('enable');
  const authority = f.subscriptions.captureAuthority(f.device.publicKeyRaw);
  if (!authority) throw new Error('OWNED_NOTIFICATION_AUTHORITY_MISSING');
  const pair = await relayV2.generateEcPair();
  await f.subscriptions.register(authority, {
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    pushPublicKey: relayV2.b64u(pair.publicKey),
    keyVersion: 1,
  });
  const file = join(f.hub.dir, 'secure_push_subscriptions.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.subscriptions[0].lastSeenAt = Date.now() - 2000;
  writeFileSync(file, JSON.stringify(stored));
  f.sender(false);
  expect(await f.exchange('status')).toMatchObject({
    success: false,
    error: 'HOST_SETUP_REQUIRED',
  });
  expect(JSON.parse(readFileSync(file, 'utf8')).subscriptions[0].leaseExpired).toBe(true);
  f.sender(true);
  expect(await f.exchange('enable')).toMatchObject({ state: 'renewal_required' });
}, 15000);

test('inactive expiry needs Continue and fresh encrypted registration; revoke preserves direct trust', async () => {
  const f = await fixture(false, 1000);
  await f.exchange('enable');
  const authority = f.subscriptions.captureAuthority(f.device.publicKeyRaw);
  if (!authority) throw new Error('OWNED_NOTIFICATION_AUTHORITY_MISSING');
  const pair = await relayV2.generateEcPair();
  const registration = {
    token: 'ab'.repeat(32),
    environment: 'sandbox' as const,
    pushPublicKey: relayV2.b64u(pair.publicKey),
    keyVersion: 1,
  };
  expect(await f.subscriptions.register(authority, registration)).toMatchObject({ success: true });
  const file = join(f.hub.dir, 'secure_push_subscriptions.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  const originalEpoch = stored.subscriptions[0].subscriptionEpoch;
  stored.subscriptions[0].lastSeenAt = Date.now() - 2000;
  writeFileSync(file, JSON.stringify(stored));
  expect(await f.exchange('enable')).toMatchObject({ state: 'renewal_required' });
  expect(await f.exchange('continue')).toMatchObject({ state: 'registration_required' });
  expect(JSON.parse(readFileSync(file, 'utf8')).subscriptions[0].leaseExpired).toBe(true);
  expect(await f.subscriptions.register(authority, registration, () => true, false)).toMatchObject({
    success: false,
    error: 'RENEWAL_REQUIRED',
  });
  expect(await f.subscriptions.register(authority, registration, () => true, true)).toMatchObject({
    success: true,
  });
  expect(f.subscriptions.listCurrent()[0]?.subscriptionEpoch).not.toBe(originalEpoch);
  expect(await f.exchange('revoke')).toMatchObject({ success: true, state: 'revoked' });
  expect(f.subscriptions.listCurrent()).toEqual([]);
  expect(f.hub.trust.isAuthorized(f.device.publicKeyRaw, f.device.fingerprint)).toBe(true);
}, 15000);
