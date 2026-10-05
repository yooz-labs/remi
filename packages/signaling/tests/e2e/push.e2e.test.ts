/** Real SQLite DO + JWT/signature/seal; only Apple network destination is owned HTTP/1.1. */
import { afterEach, expect, test } from 'bun:test';
import { type Server, createServer } from 'node:http';
import { relayV2 as r } from '@remi/shared';
import {
  FakeHost,
  type Identity,
  type Machine,
  hex,
  newIdentity,
  newMachine,
  roomState,
} from './endpoints.ts';
import { type TestWorker, get, startWorker } from './harness.ts';

interface Received {
  body: string;
  httpVersion: string;
  headers: Record<string, string | string[] | undefined>;
}
let worker: TestWorker | undefined;
let server: Server | undefined;
const requests: Received[] = [];
let status = 200;
let responseBody = '';
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  requests.length = 0;
  status = 200;
  responseBody = '';
});

async function setup(vars: Record<string, string> = {}) {
  const p8 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const raw = await crypto.subtle.exportKey('pkcs8', p8.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(raw).toString('base64')}\n-----END PRIVATE KEY-----`;
  server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    requests.push({ body, httpVersion: req.httpVersion, headers: req.headers });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(responseBody);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owned receiver unavailable');
  worker = await startWorker(
    {
      APNS_KEY_ID: 'OWNEDTEST1',
      APNS_TEAM_ID: 'OWNEDTEAM1',
      APNS_PRIVATE_KEY: pem,
      APNS_BUNDLE_ID: 'owned.synthetic.topic',
      TEST_APNS_ENDPOINT: `http://127.0.0.1:${address.port}`,
      ...vars,
    },
    true,
  );
  const machine = await newMachine();
  const device = await newIdentity();
  const host = await FakeHost.start(worker, machine);
  const recipient = await r.generateEcPair();
  expect((await host.enroll(device.publicKey))['ok']).toBe(true);
  return { worker, machine, device, host, recipient, p8 };
}
async function submission(
  w: TestWorker,
  m: Machine,
  d: Identity,
  p: r.EcPair,
  changes: Partial<r.UnsignedPushSubmit> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const content: r.PushContentMetadata = {
    machinePublicKey: r.b64u(m.publicKey),
    rid: m.ridHex,
    devicePublicKey: r.b64u(d.publicKey),
    pushPublicKey: r.b64u(p.publicKey),
    keyVersion: 1,
    collapseId: r.b64u(r.systemRandom(16)),
    revision: 1,
    kind: 'question',
    nonce: r.b64u(r.systemRandom(32)),
    issuedAt: now,
    expiresAt: now + 60,
  };
  const sealed = await r.sealPushContent(
    m.signer,
    content,
    {
      type: 'informational',
      actionable: false,
      sessionId: null,
      title: 'PRIVATE_SENTINEL_TITLE',
      body: 'PRIVATE_SENTINEL_BODY',
    },
    r.systemRandom,
  );
  const unsigned: r.UnsignedPushSubmit = {
    ...content,
    v: 2,
    audience: w.url,
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    nonce: r.b64u(r.systemRandom(32)),
    expiresAt: now + 50,
    sealed: r.b64u(sealed),
    ...changes,
  };
  return {
    ...unsigned,
    signature: r.b64u(await m.signer.sign(await r.buildPushSubmitSigningInput(unsigned))),
  };
}
async function post(w: TestWorker, s: r.PushSubmit | string) {
  const rid =
    typeof s === 'string' ? (s.match(/"rid":"([0-9a-f]+)"/)?.[1] ?? '00'.repeat(16)) : s.rid;
  const res = await get(`${w.url}/v2/push/${rid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof s === 'string' ? s : r.encodePushSubmit(s),
  });
  const raw = await res.text();
  expect(res.headers.get('content-type'), 'real push route returns typed JSON').toContain(
    'application/json',
  );
  return r.decodePushSubmitResult(raw);
}

test('real gateway accepts exact machine proof without legacy secret and sends only sealed generic APNs data', async () => {
  const { worker: w, machine: m, device: d, recipient: p, p8 } = await setup();
  const s = await submission(w, m, d, p);
  const proof = await r.verifyPushSubmit(
    s,
    { rid: m.ridHex, audience: w.url },
    Math.floor(Date.now() / 1000),
  );
  expect(await post(w, s)).toEqual({
    v: 2,
    requestDigest: proof.requestDigest,
    outcome: 'accepted',
  });
  expect(requests.length).toBe(1);
  const req = requests[0];
  if (!req) throw new Error('receiver missing');
  expect(req.httpVersion).toBe('1.1');
  expect(req.body).not.toContain('PRIVATE_SENTINEL');
  const body = JSON.parse(req.body);
  expect(Object.keys(body).sort()).toEqual(['aps', 'remiPush']);
  expect(body.aps['mutable-content']).toBe(1);
  expect(body.aps.category).toBe('');
  expect(body.remiPush).toEqual({
    v: 2,
    rid: s.rid,
    collapseId: s.collapseId,
    keyVersion: s.keyVersion,
    kind: s.kind,
    sealed: s.sealed,
  });
  expect(req.headers['apns-topic']).toBe('owned.synthetic.topic');
  expect(req.headers['x-owned-apns-url']).toBe(
    `https://api.sandbox.push.apple.com/3/device/${s.token}`,
  );
  const jwt = String(req.headers.authorization).slice('bearer '.length).split('.');
  expect(jwt.length).toBe(3);
  expect(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      p8.publicKey,
      r.fromB64u(jwt[2] ?? ''),
      new TextEncoder().encode(`${jwt[0]}.${jwt[1]}`),
    ),
  ).toBe(true);
}, 15000);

test('real durable nonce same digest returns retained outcome; different signed content never sends twice', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const s = await submission(w, m, d, p);
  const first = await post(w, s);
  expect(first.outcome).toBe('accepted');
  expect(await post(w, s)).toEqual(first);
  const changed = await submission(w, m, d, p, { nonce: s.nonce, revision: 2 });
  expect(await post(w, changed)).toMatchObject({
    outcome: 'rejected',
    reason: 'NONCE_CONFLICT',
    retryable: false,
  });
  expect(requests.length).toBe(1);
}, 15000);

test('real gateway refuses unknown/revoked device and malformed or duplicate body before any APNs network effect', async () => {
  const { worker: w, machine: m, device: d, recipient: p, host } = await setup();
  const s = await submission(w, m, d, p);
  expect(await post(w, { ...s, signature: r.b64u(new Uint8Array(64)) })).toMatchObject({
    outcome: 'rejected',
    reason: 'BAD_SIGNATURE',
  });
  expect(await post(w, r.encodePushSubmit(s).replace('"v":2', '"v":2,"\\u0076":2'))).toMatchObject({
    outcome: 'rejected',
    reason: 'MALFORMED',
  });
  expect(await post(w, `${r.encodePushSubmit(s).slice(0, -1)},"unknown":true}`)).toMatchObject({
    outcome: 'rejected',
    reason: 'MALFORMED',
  });
  expect((await host.revoke(d.publicKey))['ok']).toBe(true);
  expect(await post(w, s)).toMatchObject({ outcome: 'rejected', reason: 'NOT_ENROLLED' });
  expect(requests.length).toBe(0);
}, 15000);

test('actual enrollment row epoch survives idempotent enroll and changes only on revoke/re-enroll', async () => {
  const { worker: w, device: d, host, machine: m, recipient: p } = await setup();
  const row = `dev:${hex(d.publicKey)}`;
  const first = (await roomState(w, m.ridHex)).storage[row] as { epoch: string };
  expect(first.epoch).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await host.enroll(d.publicKey);
  expect((await roomState(w, m.ridHex)).storage[row]).toEqual(first);
  await host.revoke(d.publicKey);
  await host.enroll(d.publicKey);
  const fresh = (await roomState(w, m.ridHex)).storage[row] as { epoch: string };
  expect(fresh.epoch).not.toBe(first.epoch);
  await get(`${w.url}/__room/${m.ridHex}/__seed`, {
    method: 'POST',
    body: JSON.stringify({ [row]: { at: 1700000000000 } }),
  });
  expect((await post(w, await submission(w, m, d, p))).outcome).toBe('accepted');
  const legacy = (await roomState(w, m.ridHex)).storage[row] as { at: number; epoch: string };
  expect(legacy.at).toBe(1700000000000);
  expect(legacy.epoch).toMatch(/^[A-Za-z0-9_-]{43}$/);
}, 15000);

test('legacy plaintext route is default off and explicit compatibility still requires a secret', async () => {
  const { worker: w } = await setup({ APNS_KEY_ID: '' });
  const res = await get(`${w.url}/push`, {
    method: 'POST',
    body: JSON.stringify({ token: 'owned', title: 'owned', body: 'owned' }),
  });
  expect(res.status).toBe(403);
  expect(requests.length).toBe(0);
}, 15000);
