/** Real daemon authority/codec and owned HTTP boundaries. Worker integration follows below. */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, relayV2 as r } from '@remi/shared';
import { IdentityStore } from '../../packages/daemon/src/auth/identity-store.ts';
import { SecurePushStore } from '../../packages/daemon/src/notifications/secure-push-store.ts';
import { RelayDeviceStore } from '../../packages/daemon/src/remote/relay-device-store.ts';
import { QuestionStore } from '../../packages/daemon/src/session/question-store.ts';

import type { SecurePushTransport as TransportClass } from '../../packages/daemon/src/notifications/secure-push-transport.ts';
type Constructor = typeof TransportClass;
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
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
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
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
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

async function submissionInput(body: string) {
  const { signature, ...unsigned } = r.decodePushSubmit(body);
  expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  return r.buildPushSubmitSigningInput(unsigned);
}

for (const variant of [
  'empty',
  'malformed',
  'oversize',
  'invalid-utf8',
  'digest-mismatch',
  'null-digest',
  'final-rejection',
  'uncertain',
] as const) {
  test(`secure transport ${variant} response never causes an automatic resend`, async () => {
    const f = await fixture();
    const received = receiver(async (_req, body) => {
      const input = await submissionInput(body);
      const requestDigest = Buffer.from(input.subarray(input.length - 32)).toString('hex');
      if (variant === 'empty') return new Response(null);
      if (variant === 'malformed') return new Response('PRIVATE_REPLY_SENTINEL');
      if (variant === 'oversize')
        return new Response(
          `${r.encodePushSubmitResult({ v: 2, outcome: 'accepted', requestDigest })}${' '.repeat(513)}`,
        );
      if (variant === 'invalid-utf8') return new Response(Uint8Array.of(0xff));
      if (variant === 'digest-mismatch')
        return new Response(
          r.encodePushSubmitResult({
            v: 2,
            outcome: 'rejected',
            requestDigest: '0'.repeat(64),
            reason: 'RATE_LIMITED',
            retryable: true,
          }),
        );
      if (variant === 'null-digest')
        return new Response(
          r.encodePushSubmitResult({
            v: 2,
            outcome: 'rejected',
            requestDigest: null,
            reason: 'RATE_LIMITED',
            retryable: true,
          }),
        );
      if (variant === 'final-rejection')
        return new Response(
          r.encodePushSubmitResult({
            v: 2,
            outcome: 'rejected',
            requestDigest,
            reason: 'INVALID_TOKEN',
            retryable: false,
          }),
        );
      return new Response(r.encodePushSubmitResult({ v: 2, outcome: 'uncertain', requestDigest }));
    });
    const Transport = await transportClass();
    const transport = Transport.forOwnedLoopbackTest({
      store: f.store,
      signer: f.signer,
      audience: received.server.url.origin,
      ownedOrigin: received.server.url.origin,
      retryDelayMs: 0,
    });
    const result = await transport.prepare(f.snapshot, f.metadata, f.payload, () => true);
    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
    const delivery = await transport.sendPrepared(result.prepared);
    expect(delivery).toMatchObject({
      outcome: variant === 'final-rejection' ? 'rejected' : 'uncertain',
      attempts: 1,
    });
    expect(await transport.sendPrepared(result.prepared)).toEqual(delivery);
    expect(received.bodies).toHaveLength(1);
  });
}
for (const reason of ['RATE_LIMITED', 'CAPACITY', 'STORE_ERROR'] as const) {
  test(`secure transport bounded ${reason} retries preserve exact nonce and stop at three`, async () => {
    const f = await fixture();
    const received = receiver(async (_req, body) => {
      const input = await submissionInput(body);
      return new Response(
        r.encodePushSubmitResult({
          v: 2,
          outcome: 'rejected',
          requestDigest: Buffer.from(input.subarray(input.length - 32)).toString('hex'),
          reason,
          retryable: true,
        }),
      );
    });
    const Transport = await transportClass();
    const transport = Transport.forOwnedLoopbackTest({
      store: f.store,
      signer: f.signer,
      audience: received.server.url.origin,
      ownedOrigin: received.server.url.origin,
      retryDelayMs: 1,
    });
    const result = await transport.prepare(f.snapshot, f.metadata, f.payload, () => true);
    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
    await expect(transport.sendPrepared(result.prepared)).resolves.toMatchObject({
      outcome: 'rejected',
      reason,
      retryable: true,
      attempts: 3,
    });
    expect(received.bodies).toHaveLength(3);
    expect(new Set(received.bodies).size).toBe(1);
  });
}
test('secure transport rechecks durable rotation across actual receiver response delay before retry', async () => {
  const f = await fixture();
  const received = receiver(async (_req, body) => {
    const input = await submissionInput(body);
    // An actual network receiver rotates the actual subscription before releasing its response.
    expect(
      await f.store.register(f.authority, {
        token: 'cd'.repeat(32),
        environment: f.snapshot.environment,
        pushPublicKey: f.snapshot.pushPublicKey,
        keyVersion: 1,
      }),
    ).toEqual({ success: true, keyVersion: 1 });
    return new Response(
      r.encodePushSubmitResult({
        v: 2,
        outcome: 'rejected',
        requestDigest: Buffer.from(input.subarray(input.length - 32)).toString('hex'),
        reason: 'CAPACITY',
        retryable: true,
      }),
    );
  });
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  const result = await transport.prepare(f.snapshot, f.metadata, f.payload, () => true);
  expect(result.outcome).toBe('prepared');
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
  await expect(transport.sendPrepared(result.prepared)).resolves.toMatchObject({
    outcome: 'refused',
    reason: 'AUTHORITY_CHANGED',
    attempts: 1,
  });
  expect(received.bodies).toHaveLength(1);
});
test('secure transport finite remaining-expiry wait aborts a real stalled receiver without resend', async () => {
  const f = await fixture();
  const received = receiver(async (_req, body) => {
    const input = await submissionInput(body);
    await new Promise<void>((resolve) => setTimeout(resolve, 2200));
    return new Response(
      r.encodePushSubmitResult({
        v: 2,
        outcome: 'accepted',
        requestDigest: Buffer.from(input.subarray(input.length - 32)).toString('hex'),
      }),
    );
  });
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  const result = await transport.prepare(
    f.snapshot,
    { ...f.metadata, expiresAt: Math.floor(Date.now() / 1000) + 1 },
    f.payload,
    () => true,
  );
  expect(result.outcome).toBe('prepared');
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
  const started = Date.now();
  await expect(transport.sendPrepared(result.prepared)).resolves.toMatchObject({
    outcome: 'uncertain',
    attempts: 1,
  });
  expect(Date.now() - started).toBeLessThan(1800);
  expect(received.bodies).toHaveLength(1);
});

test('secure transport real Worker and SQLite DO accept one owned APNs HTTP/1.1 effect', async () => {
  const f = await fixture();
  const { createServer } = await import('node:http');
  const { startWorker } = await import('../../packages/signaling/tests/e2e/harness.ts');
  const { FakeHost } = await import('../../packages/signaling/tests/e2e/endpoints.ts');
  const requests: { body: string; httpVersion: string }[] = [];
  const apns = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ body, httpVersion: req.httpVersion });
    res.writeHead(200);
    res.end();
  });
  await new Promise<void>((resolve) => apns.listen(0, '127.0.0.1', resolve));
  const address = apns.address();
  if (!address || typeof address === 'string') throw new Error('owned APNs listener missing');
  const jwt = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', jwt.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
  const worker = await startWorker(
    {
      APNS_KEY_ID: 'OWNEDTEST1',
      APNS_TEAM_ID: 'OWNEDTEAM1',
      APNS_PRIVATE_KEY: pem,
      APNS_BUNDLE_ID: 'owned.synthetic.topic',
      TEST_APNS_ENDPOINT: `http://127.0.0.1:${address.port}`,
    },
    true,
  );
  let host: Awaited<ReturnType<typeof FakeHost.start>> | undefined;
  try {
    const rid = await r.ridOf(f.signer.publicKey);
    host = await FakeHost.start(worker, {
      signer: f.signer,
      publicKey: f.signer.publicKey,
      rid,
      ridHex: f.metadata.rid,
    });
    expect((await host.enroll(Buffer.from(f.identity.publicKey, 'base64')))['ok']).toBe(true);
    const Transport = await transportClass();
    const transport = Transport.forOwnedLoopbackTest({
      store: f.store,
      signer: f.signer,
      audience: worker.url,
      ownedOrigin: worker.url,
    });
    const prepared = await transport.prepare(f.snapshot, f.metadata, f.payload, () => true);
    expect(prepared.outcome).toBe('prepared');
    if (prepared.outcome !== 'prepared') throw new Error('expected prepared capability');
    await expect(transport.sendPrepared(prepared.prepared)).resolves.toMatchObject({
      outcome: 'accepted',
      attempts: 1,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.httpVersion).toBe('1.1');
    expect(requests[0]?.body).not.toContain('PRIVATE_TITLE_SENTINEL');
    expect(requests[0]?.body).not.toContain('PRIVATE_BODY_SENTINEL');
    expect(JSON.parse(requests[0]?.body ?? '')['remiPush']).toEqual(prepared.prepared.carrier);
  } finally {
    host?.control.close();
    if (host) await host.control.closed;
    await worker.stop();
    apns.closeAllConnections();
    await new Promise<void>((resolve) => apns.close(() => resolve()));
  }
});

test('secure transport copies metadata, payload and snapshot before the first await', async () => {
  const f = await fixture();
  const received = receiver(() => Response.json({}));
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  const metadata = { ...f.metadata };
  const payload = {
    type: 'informational' as const,
    actionable: false as const,
    sessionId: null,
    title: 'original title',
    body: 'original body',
  };
  const snapshot = { ...f.snapshot };
  const promise = transport.prepare(snapshot, metadata, payload, () => true);
  metadata.revision = 99;
  payload.body = 'mutated body';
  snapshot.token = 'cd'.repeat(32);
  const result = await promise;
  expect(result.outcome).toBe('prepared');
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
  const opened = await r.openPushContent(
    f.recipient,
    result.prepared.carrier,
    {
      machinePublicKey: f.metadata.machinePublicKey,
      devicePublicKey: f.metadata.devicePublicKey,
      pushPublicKey: f.metadata.pushPublicKey,
      keyVersion: 1,
    },
    Math.floor(Date.now() / 1000),
  );
  expect(opened.content.revision).toBe(1);
  expect(opened.payload).toMatchObject({ body: 'original body' });
  expect(Object.isFrozen(result.prepared)).toBe(true);
  expect(Object.isFrozen(result.prepared.carrier)).toBe(true);
});
test('secure transport same-key re-pair during actual signature completion refuses old snapshot', async () => {
  const f = await fixture();
  const received = receiver(() => Response.json({}));
  const signer: r.Signer = {
    publicKey: f.signer.publicKey,
    async sign(bytes) {
      const signed = await f.signer.sign(bytes);
      f.devices.remove(f.identity.fingerprint);
      await f.devices.add(f.identity.publicKey, 'owned new pairing');
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
test('secure transport current callback tracks actual QuestionStore removal at effect boundary', async () => {
  const f = await fixture();
  const questions = new QuestionStore('owned-session', {}, { redactText: true });
  questions.add({
    id: 'owned-question',
    text: 'owned text',
    options: [],
    allowsFreeText: false,
    isAnswered: false,
  });
  const isCurrent = () => questions.questions.has('owned-question');
  const received = receiver(() => Response.json({}));
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  const result = await transport.prepare(f.snapshot, f.metadata, f.payload, isCurrent);
  expect(result.outcome).toBe('prepared');
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
  questions.remove('owned-question', 'user_answer');
  await expect(transport.sendPrepared(result.prepared)).resolves.toMatchObject({
    outcome: 'refused',
    reason: 'NOT_CURRENT',
    attempts: 0,
  });
  expect(received.bodies).toHaveLength(0);
});
test('secure transport expired content refuses before actual signing or network effect', async () => {
  const f = await fixture();
  const received = receiver(() => Response.json({}));
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  await expect(
    transport.prepare(
      f.snapshot,
      { ...f.metadata, expiresAt: Math.floor(Date.now() / 1000) },
      f.payload,
      () => true,
    ),
  ).resolves.toMatchObject({ outcome: 'refused', reason: 'EXPIRED' });
  expect(received.bodies).toHaveLength(0);
});
test('secure transport refuses foreign or forged prepared capabilities and audience aliases', async () => {
  const f = await fixture();
  const received = receiver(() => Response.json({}));
  const Transport = await transportClass();
  const make = () =>
    Transport.forOwnedLoopbackTest({
      store: f.store,
      signer: f.signer,
      audience: received.server.url.origin,
      ownedOrigin: received.server.url.origin,
    });
  const first = make();
  const second = make();
  const result = await first.prepare(f.snapshot, f.metadata, f.payload, () => true);
  expect(result.outcome).toBe('prepared');
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
  await expect(second.sendPrepared(result.prepared)).resolves.toMatchObject({
    outcome: 'refused',
    reason: 'NOT_PREPARED',
    attempts: 0,
  });
  await expect(first.sendPrepared({ ...result.prepared })).resolves.toMatchObject({
    outcome: 'refused',
    reason: 'NOT_PREPARED',
    attempts: 0,
  });
  for (const audience of [
    'http://localhost:1234',
    'https://example.com/path',
    'https://user@example.com',
    'https://example.com?x=1',
  ]) {
    expect(() => new Transport({ store: f.store, signer: f.signer, audience })).toThrow(
      'SECURE_PUSH_AUDIENCE',
    );
  }
  expect(() =>
    Transport.forOwnedLoopbackTest({
      store: f.store,
      signer: f.signer,
      audience: received.server.url.origin,
      ownedOrigin: 'http://127.0.0.1:1',
    }),
  ).toThrow('SECURE_PUSH_AUDIENCE');
  expect(received.bodies).toHaveLength(0);
});

test('secure transport actual socket loss is uncertain and the same prepared request is never resent', async () => {
  const f = await fixture();
  const { createServer } = await import('node:http');
  let effects = 0;
  const server = createServer(async (req) => {
    for await (const _chunk of req) {
      /* Drain the actual request before destroying its response socket. */
    }
    effects++;
    req.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owned listener missing');
  try {
    const Transport = await transportClass();
    const audience = `http://127.0.0.1:${address.port}`;
    const transport = Transport.forOwnedLoopbackTest({
      store: f.store,
      signer: f.signer,
      audience,
      ownedOrigin: audience,
    });
    const result = await transport.prepare(f.snapshot, f.metadata, f.payload, () => true);
    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
    await expect(transport.sendPrepared(result.prepared)).resolves.toMatchObject({
      outcome: 'uncertain',
      attempts: 1,
    });
    await expect(transport.sendPrepared(result.prepared)).resolves.toMatchObject({
      outcome: 'uncertain',
      attempts: 1,
    });
    expect(effects).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('secure transport expired prepared request refuses at the synchronous effect boundary', async () => {
  const f = await fixture();
  const received = receiver(() => Response.json({}));
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  const result = await transport.prepare(
    f.snapshot,
    { ...f.metadata, expiresAt: Math.floor(Date.now() / 1000) + 1 },
    f.payload,
    () => true,
  );
  expect(result.outcome).toBe('prepared');
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
  await new Promise<void>((resolve) =>
    setTimeout(resolve, Math.max(0, result.prepared.expiresAt * 1000 - Date.now()) + 20),
  );
  await expect(transport.sendPrepared(result.prepared)).resolves.toMatchObject({
    outcome: 'refused',
    reason: 'EXPIRED',
    attempts: 0,
  });
  expect(received.bodies).toHaveLength(0);
});
test('secure transport false machine signer and recipient mismatch fail closed', async () => {
  const f = await fixture();
  const received = receiver(() => Response.json({}));
  const other = await r.generateIdentity();
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: { publicKey: f.signer.publicKey, sign: other.signer.sign.bind(other.signer) },
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  await expect(
    transport.prepare(f.snapshot, f.metadata, f.payload, () => true),
  ).resolves.toMatchObject({ outcome: 'refused', reason: 'INVALID_CONTENT' });
  const genuine = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: received.server.url.origin,
    ownedOrigin: received.server.url.origin,
  });
  await expect(
    genuine.prepare(
      f.snapshot,
      { ...f.metadata, devicePublicKey: r.b64u(other.signer.publicKey) },
      f.payload,
      () => true,
    ),
  ).resolves.toMatchObject({ outcome: 'refused', reason: 'INVALID_CONTENT' });
  expect(received.bodies).toHaveLength(0);
});

test('secure transport refuses response-selected redirect authority without a second network effect', async () => {
  const f = await fixture();
  const destination = receiver(async (_req, body) => {
    const input = await submissionInput(body);
    return new Response(
      r.encodePushSubmitResult({
        v: 2,
        outcome: 'accepted',
        requestDigest: Buffer.from(input.subarray(input.length - 32)).toString('hex'),
      }),
    );
  });
  const configured = receiver(
    () =>
      new Response(null, {
        status: 307,
        headers: { location: `${destination.server.url.origin}/unconfigured` },
      }),
  );
  const Transport = await transportClass();
  const transport = Transport.forOwnedLoopbackTest({
    store: f.store,
    signer: f.signer,
    audience: configured.server.url.origin,
    ownedOrigin: configured.server.url.origin,
  });
  const result = await transport.prepare(f.snapshot, f.metadata, f.payload, () => true);
  expect(result.outcome).toBe('prepared');
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
  await expect(transport.sendPrepared(result.prepared)).resolves.toMatchObject({
    outcome: 'uncertain',
    attempts: 1,
  });
  expect(configured.bodies).toHaveLength(1);
  expect(destination.bodies).toHaveLength(0);
});
test('secure transport corrupt current subscription refuses with fixed local STORE_ERROR', async () => {
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
  if (result.outcome !== 'prepared') throw new Error('expected prepared capability');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(f.directory, 'secure_push_subscriptions.json'), 'PRIVATE_STORE_SENTINEL', {
    mode: 0o600,
  });
  await expect(transport.sendPrepared(result.prepared)).resolves.toEqual({
    outcome: 'refused',
    reason: 'STORE_ERROR',
    attempts: 0,
  });
  expect(received.bodies).toHaveLength(0);
});

test('owned-loopback test factory refuses HTTPS and localhost aliases while production accepts canonical HTTPS', async () => {
  const f = await fixture();
  const Transport = await transportClass();
  expect(
    () => new Transport({ store: f.store, signer: f.signer, audience: 'https://example.com' }),
  ).not.toThrow();
  for (const audience of ['https://example.com', 'http://localhost:1234']) {
    expect(() =>
      Transport.forOwnedLoopbackTest({
        store: f.store,
        signer: f.signer,
        audience,
        ownedOrigin: audience,
      }),
    ).toThrow('SECURE_PUSH_AUDIENCE');
  }
});
