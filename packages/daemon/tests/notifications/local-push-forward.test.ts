/** Real stores, sealing, current runtime registry and HTTP handoff; no APNs delivery claim. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, generateId, relayV2 as r } from '@remi/shared';
import { loadOrCreateCapabilityToken } from '../../src/auth/capability-token.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import {
  LOCAL_PUSH_PATH,
  LocalPushForwardService,
  localHubPushForwarder,
} from '../../src/notifications/local-push-forward.ts';
import { SecurePushContexts } from '../../src/notifications/secure-push-contexts.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { SecurePushTransport } from '../../src/notifications/secure-push-transport.ts';
import { NotificationDeviceStore } from '../../src/remote/notification-device-store.ts';
import { WebSocketServer } from '../../src/server/websocket-server.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'remi-local-push-'));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  const trust = new IdentityStore(directory);
  await trust.generate();
  const machine = await trust.unlock();
  const signer = await r.signerFromKey(
    machine.privateKey,
    new Uint8Array(Buffer.from(machine.publicKeyRaw, 'base64')),
  );
  const rid = Buffer.from(await r.ridOf(signer.publicKey)).toString('hex');
  const device = await createIdentity();
  await trust.addAuthorizedKey(device.publicKey, 'owned local push recipient');
  const epoch = trust.captureAuthorizationEpoch(device.publicKey);
  if (!epoch) throw new Error('OWNED_GRANT_MISSING');
  await new NotificationDeviceStore(directory, trust).add(
    device.publicKey,
    epoch,
    'owned notifications',
  );
  const store = new SecurePushStore(directory, trust);
  const authority = store.captureAuthority(device.publicKey);
  if (!authority) throw new Error('OWNED_AUTHORITY_MISSING');
  const recipient = await r.generateEcPair();
  expect(
    await store.register(authority, {
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: r.b64u(recipient.publicKey),
      keyVersion: 1,
    }),
  ).toMatchObject({ success: true });
  const snapshot = store.listCurrent()[0];
  if (!snapshot) throw new Error('OWNED_SUBSCRIPTION_MISSING');
  const registry = new SessionRegistryFile(join(directory, 'live-sessions'));
  const contexts = new SecurePushContexts({
    questionFor: () => null,
    validityFor: () => ({ kind: 'closed' }),
  });
  const runtime = contexts.begin(generateId());
  const child = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('Owned session listener'),
  });
  cleanups.push(async () => {
    await child.stop(true);
  });
  const childPort = child.port;
  if (!childPort) throw new Error('OWNED_CHILD_PORT_MISSING');
  registry.register({
    sessionId: runtime.sessionId,
    pid: process.pid,
    wsPort: childPort,
    hookPort: 0,
    projectPath: directory,
    name: 'owned session',
    startedAt: new Date().toISOString(),
    notificationRuntime: runtime.instance,
  });
  const providerRequests: Array<{
    body: string;
    authorization: string | null;
    capability: string | null;
  }> = [];
  let unreadableReceipt = false;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const text = await request.text();
      providerRequests.push({
        body: text,
        authorization: request.headers.get('authorization'),
        capability: request.headers.get('x-remi-capability'),
      });
      const submission = r.decodePushSubmit(text);
      const checked = await r.verifyPushSubmit(
        submission,
        { rid, audience: provider.url.origin },
        Math.floor(Date.now() / 1000),
      );
      // This receiver receipts a verified HTTP submission only; it is not APNs or a Worker double.
      return unreadableReceipt
        ? new Response('receipt lost', { status: 502 })
        : new Response(
            r.encodePushSubmitResult({
              v: 2,
              requestDigest: checked.requestDigest,
              outcome: 'accepted',
            }),
          );
    },
  });
  cleanups.push(async () => {
    await provider.stop(true);
  });
  const service = LocalPushForwardService.forOwnedLoopbackTest({
    subscriptions: store,
    registry,
    audience: provider.url.origin,
    ownedOrigin: provider.url.origin,
    rid,
    machinePublicKey: r.b64u(signer.publicKey),
    pushSecret: 'PRIVATE_HUB_PROVIDER_SENTINEL',
  });
  const capability = loadOrCreateCapabilityToken(join(directory, 'capability.key'));
  const localRequests: string[] = [];
  const hub = new WebSocketServer(
    { host: '127.0.0.1', port: 0, capabilityToken: capability },
    {
      onLocalPushForward: async (request) => {
        localRequests.push(await request.clone().text());
        return service.handle(request);
      },
    },
  );
  await hub.start();
  cleanups.push(() => hub.stop());
  writeFileSync(
    join(directory, 'daemon-status.json'),
    JSON.stringify({ mode: 'hub', pid: process.pid, wsPort: hub.port }),
  );
  const transport = SecurePushTransport.forOwnedLoopbackTest({
    store,
    signer,
    audience: provider.url.origin,
    ownedOrigin: provider.url.origin,
    forward: localHubPushForwarder({
      directory,
      registry,
      runtime: () => runtime,
      port: () => childPort,
    }),
  });
  const packet = async () => {
    const event = contexts.captureResult(runtime, snapshot, {
      kind: 'turn_complete',
      logicalId: generateId(),
      title: 'Owned question context',
      body: 'PRIVATE_EVENT_CONTENT_SENTINEL',
    });
    if (!('context' in event)) throw new Error('OWNED_CONTEXT_MISSING');
    const prepared = await transport.prepare(
      snapshot,
      { ...event.context.content, machinePublicKey: r.b64u(signer.publicKey), rid },
      event.context.payload,
      () => contexts.isCurrent(event.context),
    );
    if (prepared.outcome !== 'prepared') throw new Error('OWNED_PREPARATION_MISSING');
    return prepared.prepared;
  };
  const post = (body: unknown, authorized = true) =>
    fetch(`http://127.0.0.1:${hub.port}${LOCAL_PUSH_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorized ? { 'x-remi-capability': capability } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return {
    directory,
    trust,
    device,
    registry,
    runtime,
    store,
    snapshot,
    transport,
    packet,
    post,
    providerRequests,
    localRequests,
    loseReceipt: () => {
      unreadableReceipt = true;
    },
  };
}

test('session sends sealed bytes through the actual protected hub without its provider credential', async () => {
  const f = await fixture();
  expect(await f.transport.sendPrepared(await f.packet())).toMatchObject({
    outcome: 'accepted',
    attempts: 1,
  });
  expect(f.localRequests).toHaveLength(1);
  expect(f.providerRequests).toHaveLength(1);
  expect(f.localRequests[0]).not.toContain('PRIVATE_HUB_PROVIDER_SENTINEL');
  expect(f.localRequests[0]).not.toContain('PRIVATE_EVENT_CONTENT_SENTINEL');
  expect(f.providerRequests[0]?.authorization).toBe('Bearer PRIVATE_HUB_PROVIDER_SENTINEL');
  expect(f.providerRequests[0]?.capability).toBeNull();
  const local = f.localRequests[0];
  if (!local) throw new Error('OWNED_LOCAL_SUBMISSION_MISSING');
  expect(JSON.parse(local).submit).toBe(f.providerRequests[0]?.body);
});

test('no capability, stale runtime, foreign recipient and invalid signature never reach the provider', async () => {
  const f = await fixture();
  await f.transport.sendPrepared(await f.packet());
  const local = f.localRequests[0];
  if (!local) throw new Error('OWNED_LOCAL_SUBMISSION_MISSING');
  const original = JSON.parse(local);
  expect((await f.post(original, false)).status).toBe(403);
  expect((await f.post({ ...original, runtimeInstance: r.b64u(r.systemRandom(32)) })).ok).toBe(
    false,
  );
  const changed = { ...original, snapshot: { ...original.snapshot, token: 'cd'.repeat(32) } };
  expect((await f.post(changed)).ok).toBe(false);
  const submit = JSON.parse(original.submit);
  submit.signature = r.b64u(new Uint8Array(64));
  expect((await f.post({ ...original, submit: JSON.stringify(submit) })).ok).toBe(false);
  expect(f.providerRequests).toHaveLength(1);
});

test('a replaced current runtime refuses before any local HTTP invocation', async () => {
  const f = await fixture();
  const prepared = await f.packet();
  f.registry.setNotificationRuntime(f.runtime.sessionId, r.b64u(r.systemRandom(32)));
  expect(await f.transport.sendPrepared(prepared)).toMatchObject({
    outcome: 'refused',
    reason: 'LOCAL_HUB_UNAVAILABLE',
    attempts: 0,
  });
  expect(f.localRequests).toEqual([]);
  expect(f.providerRequests).toEqual([]);
});

test('a lost provider receipt is uncertain and never automatically resubmitted', async () => {
  const f = await fixture();
  f.loseReceipt();
  expect(await f.transport.sendPrepared(await f.packet())).toMatchObject({
    outcome: 'uncertain',
    attempts: 1,
  });
  expect(f.providerRequests).toHaveLength(1);
});
