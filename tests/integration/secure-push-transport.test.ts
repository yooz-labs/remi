/** Real daemon authority/codec and owned HTTP boundaries. Worker integration follows below. */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, relayV2 as r } from '@remi/shared';
import { IdentityStore } from '../../packages/daemon/src/auth/identity-store.ts';
import {
  type SecurePushSnapshot,
  SecurePushStore,
} from '../../packages/daemon/src/notifications/secure-push-store.ts';
import { RelayDeviceStore } from '../../packages/daemon/src/remote/relay-device-store.ts';

interface Prepared {
  readonly requestDigest: string;
  readonly contentDigest: string;
  readonly expiresAt: number;
  readonly carrier: r.PushCarrier;
}
interface Transport {
  prepare(
    snapshot: SecurePushSnapshot,
    metadata: r.PushContentMetadata,
    payload: r.SecurePushPayload,
    isCurrent: () => boolean,
  ): Promise<{ outcome: string; prepared?: Prepared; reason?: string }>;
  sendPrepared(prepared: Prepared): Promise<{ outcome: string; reason?: string; attempts: number }>;
}
interface Options {
  store: SecurePushStore;
  signer: r.Signer;
  audience: string;
  maxAttempts?: 1 | 2 | 3;
  retryDelayMs?: number;
}
interface Constructor {
  new (options: Options): Transport;
  forOwnedLoopbackTest(options: Options & { ownedOrigin: string }): Transport;
}
async function transportClass(): Promise<Constructor> {
  const url = new URL(
    '../../packages/daemon/src/notifications/secure-push-transport.ts',
    import.meta.url,
  );
  const present = await Bun.file(url).exists();
  expect(present).toBe(true); // Named red assertion, not an import/setup failure.
  const module = await import(url.href);
  return module.SecurePushTransport as Constructor;
}
const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'remi-secure-transport-'));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const trust = new IdentityStore(directory);
  const devices = new RelayDeviceStore(directory, trust);
  const store = new SecurePushStore(directory, trust);
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'owned synthetic');
  await devices.add(identity.publicKey, 'owned synthetic');
  const authority = store.captureAuthority(identity.publicKey);
  if (!authority) throw new Error('owned fixture missing authority');
  const recipient = await r.generateEcPair();
  expect(
    await store.register(authority, {
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: r.b64u(recipient.publicKey),
      keyVersion: 1,
    }),
  ).toEqual({ success: true, keyVersion: 1 });
  const snapshot = store.listCurrent()[0];
  if (!snapshot) throw new Error('owned fixture missing subscription');
  const { signer } = await r.generateIdentity();
  const now = Math.floor(Date.now() / 1000);
  const metadata: r.PushContentMetadata = {
    machinePublicKey: r.b64u(signer.publicKey),
    rid: Buffer.from(await r.ridOf(signer.publicKey)).toString('hex'),
    devicePublicKey: Buffer.from(identity.publicKey, 'base64').toString('base64url'),
    pushPublicKey: snapshot.pushPublicKey,
    keyVersion: snapshot.keyVersion,
    collapseId: r.b64u(r.systemRandom(16)),
    revision: 1,
    kind: 'question',
    nonce: r.b64u(r.systemRandom(32)),
    issuedAt: now,
    expiresAt: now + 50,
  };
  const payload: r.SecurePushPayload = {
    type: 'informational',
    actionable: false,
    sessionId: null,
    title: 'PRIVATE_TITLE_SENTINEL',
    body: 'PRIVATE_BODY_SENTINEL',
  };
  return {
    directory,
    trust,
    devices,
    store,
    identity,
    authority,
    recipient,
    snapshot,
    signer,
    metadata,
    payload,
  };
}
function receiver(
  handler: (request: Request, body: string, count: number) => Promise<Response> | Response,
) {
  const bodies: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = await req.text();
      bodies.push(body);
      return handler(req, body, bodies.length);
    },
  });
  servers.push(server);
  return { server, bodies };
}
test('secure transport binds actual signer, signs exactly once and reuses immutable retry bytes', async () => {
  const f = await fixture();
  const received = receiver(async (req, body, count) => {
    expect(new URL(req.url).pathname).toBe(`/v2/push/${f.metadata.rid}`);
    const parsed = r.decodePushSubmit(body);
    const { requestDigest } = await r.verifyPushSubmit(
      parsed,
      { rid: f.metadata.rid, audience: new URL(req.url).origin },
      Math.floor(Date.now() / 1000),
    );
    return new Response(
      r.encodePushSubmitResult(
        count === 1
          ? { v: 2, outcome: 'rejected', requestDigest, reason: 'RATE_LIMITED', retryable: true }
          : { v: 2, outcome: 'accepted', requestDigest },
      ),
    );
  });
  const Transport = await transportClass();
  expect(
    () => new Transport({ store: f.store, signer: f.signer, audience: received.server.url.origin }),
  ).toThrow('SECURE_PUSH_AUDIENCE');
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
    retryDelayMs: 1,
  });
  const result = await transport.prepare(f.snapshot, f.metadata, f.payload, () => true);
  expect(result.outcome).toBe('prepared');
  if (!result.prepared) throw new Error('expected prepared capability');
  expect(result.prepared.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  const opened = await r.openPushContent(
    f.recipient,
    result.prepared.carrier,
    {
      machinePublicKey: f.metadata.machinePublicKey,
      devicePublicKey: f.metadata.devicePublicKey,
      pushPublicKey: f.metadata.pushPublicKey,
      keyVersion: f.metadata.keyVersion,
    },
    Math.floor(Date.now() / 1000),
  );
  expect(opened.payload).toEqual(f.payload);
  expect(opened.contentDigest).toBe(result.prepared.contentDigest);
  expect(await transport.sendPrepared(result.prepared)).toMatchObject({
    outcome: 'accepted',
    attempts: 2,
  });
  expect(received.bodies).toHaveLength(2);
  expect(received.bodies[1]).toBe(received.bodies[0]);
  expect(received.bodies[0]).not.toContain('PRIVATE_BODY_SENTINEL');
});
test('secure transport refuses durable revoke at actual signing completion and performs zero effects', async () => {
  const f = await fixture();
  const received = receiver(() => Response.json({}));
  // Actual Ed25519 operation remains intact; revoke at its completion delivery boundary.
  const signer: r.Signer = {
    publicKey: f.signer.publicKey,
    async sign(bytes) {
      const signed = await f.signer.sign(bytes);
      f.trust.removeAuthorizedKey(f.identity.fingerprint);
      return signed;
    },
  };
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  await expect(
    transport.prepare(f.snapshot, f.metadata, f.payload, () => true),
  ).resolves.toMatchObject({ outcome: 'refused', reason: 'AUTHORITY_CHANGED' });
  expect(received.bodies).toHaveLength(0);
});
test('secure transport refuses token rotation after preparation before fetch invocation', async () => {
  const f = await fixture();
  const received = receiver(() => Response.json({}));
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  const result = await transport.prepare(f.snapshot, f.metadata, f.payload, () => true);
  expect(result.outcome).toBe('prepared');
  if (!result.prepared) throw new Error('expected prepared capability');
  expect(
    await f.store.register(f.authority, {
      token: 'cd'.repeat(32),
      environment: f.snapshot.environment,
      pushPublicKey: f.snapshot.pushPublicKey,
      keyVersion: 1,
    }),
  ).toEqual({ success: true, keyVersion: 1 });
  await expect(transport.sendPrepared(result.prepared)).resolves.toMatchObject({
    outcome: 'refused',
    reason: 'AUTHORITY_CHANGED',
    attempts: 0,
  });
  expect(received.bodies).toHaveLength(0);
});
