/** Real SQLite DO + JWT/signature/seal; only Apple network destination is owned HTTP/1.1. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
let activeRid: string | undefined;
const persistence: string[] = [];
let status = 200;
let responseBody = '';
let stall = false;
let drop = false;
afterEach(async () => {
  if (worker && activeRid) await gate(worker, activeRid, null);
  await worker?.stop();
  worker = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  requests.length = 0;
  status = 200;
  responseBody = '';
  stall = false;
  drop = false;
  activeRid = undefined;
  for (const dir of persistence.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(vars: Record<string, string> = {}, persist?: string) {
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
    if (drop) {
      res.destroy();
      return;
    }
    if (stall) {
      // Finite owned network stall: a removed deadline receives success after4s,
      // producing an outcome assertion failure rather than a test/setup timeout.
      const timer = setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(responseBody);
      }, 4000);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(responseBody);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owned receiver unavailable');
  const config = {
    APNS_KEY_ID: 'OWNEDTEST1',
    APNS_TEAM_ID: 'OWNEDTEAM1',
    APNS_PRIVATE_KEY: pem,
    APNS_BUNDLE_ID: 'owned.synthetic.topic',
    TEST_APNS_ENDPOINT: `http://127.0.0.1:${address.port}`,
    ...vars,
  };
  worker = await startWorker(config, true, persist ? { path: persist } : undefined);
  const machine = await newMachine();
  activeRid = machine.ridHex;
  const device = await newIdentity();
  const host = await FakeHost.start(worker, machine);
  const recipient = await r.generateEcPair();
  expect((await host.enroll(device.publicKey))['ok']).toBe(true);
  return { worker, machine, device, host, recipient, p8, config };
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
  const jwt = String(req.headers['authorization']).slice('bearer '.length).split('.');
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

async function gate(w: TestWorker, rid: string, stage: string | null) {
  return get(`${w.url}/__room/${rid}/__pushbarrier`, {
    method: 'POST',
    body: JSON.stringify({ stage }),
  });
}
async function reached(w: TestWorker, rid: string) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const v = (await (await get(`${w.url}/__room/${rid}/__pushbarrier`)).json()) as {
      reached: boolean;
    };
    if (v.reached) return;
    await Bun.sleep(10);
  }
  throw new Error('owned I/O boundary not reached');
}

for (const stage of ['initial-sync', 'consume-sync', 'jwt'])
  test(`actual revoke/re-enroll cannot revive captured enrollment across ${stage} completion delivery`, async () => {
    const { worker: w, machine: m, device: d, recipient: p, host } = await setup();
    const s = await submission(w, m, d, p);
    await gate(w, m.ridHex, stage);
    const result = post(w, s);
    await reached(w, m.ridHex);
    const before = (await roomState(w, m.ridHex)).storage[`dev:${hex(d.publicKey)}`] as {
      epoch: string;
    };
    expect((await host.revoke(d.publicKey))['ok']).toBe(true);
    expect((await host.enroll(d.publicKey))['ok']).toBe(true);
    const after = (await roomState(w, m.ridHex)).storage[`dev:${hex(d.publicKey)}`] as {
      epoch: string;
    };
    expect(after.epoch).not.toBe(before.epoch);
    await gate(w, m.ridHex, null);
    expect(await result).toMatchObject({
      outcome: 'rejected',
      reason: 'NOT_ENROLLED',
      retryable: false,
    });
    expect(requests.length).toBe(0);
  }, 15000);

test('consumed real sync completion error is uncertain with zero network; same durable pending nonce survives orderly Worker restart', async () => {
  const path = mkdtempSync(join(tmpdir(), 'remi-push-epoch-'));
  persistence.push(path);
  const { worker: w, machine: m, device: d, recipient: p, config } = await setup({}, path);
  const s = await submission(w, m, d, p);
  await gate(w, m.ridHex, 'consume-sync-error');
  const first = await post(w, s);
  expect(first.outcome).toBe('uncertain');
  expect(requests.length).toBe(0);
  const storage = (await roomState(w, m.ridHex)).storage;
  expect(storage[`push-nonce:${s.nonce}`]).toMatchObject({
    digest: first.requestDigest,
    until: s.expiresAt + 60,
  });
  expect(storage[`push-nonce:${s.nonce}`]).not.toHaveProperty('result');
  await gate(w, m.ridHex, null);
  await w.stop();
  worker = undefined;
  worker = await startWorker(config, true, { path, port: Number(new URL(w.url).port) });
  expect(worker.url).toBe(w.url);
  expect(await post(worker, s)).toEqual(first);
  expect(requests.length).toBe(0);
}, 15000);

test('post-effect sync completion error returns uncertain and retained actual acceptance never invokes APNs twice', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const s = await submission(w, m, d, p);
  await gate(w, m.ridHex, 'completed-sync-error');
  expect((await post(w, s)).outcome).toBe('uncertain');
  expect(requests.length).toBe(1);
  await gate(w, m.ridHex, null);
  expect((await post(w, s)).outcome).toBe('accepted');
  expect(requests.length).toBe(1);
}, 15000);

test('real low nonce capacity refuses without live eviction and reclaims only at submit expiry plus60', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup({ PUSH_NONCES: '1' });
  const first = await submission(w, m, d, p);
  expect((await post(w, first)).outcome).toBe('accepted');
  const before = (await roomState(w, m.ridHex)).storage[`push-nonce:${first.nonce}`];
  expect(await post(w, await submission(w, m, d, p))).toMatchObject({
    outcome: 'rejected',
    reason: 'CAPACITY',
    retryable: true,
  });
  expect(requests.length).toBe(1);
  expect((await roomState(w, m.ridHex)).storage[`push-nonce:${first.nonce}`]).toEqual(before);
  const target = first.expiresAt + 60;
  await get(`${w.url}/__room/${m.ridHex}/__clock`, {
    method: 'POST',
    body: JSON.stringify({ advanceMs: target * 1000 - Date.now() + 10 }),
  });
  const next = await submission(w, m, d, p, { issuedAt: target, expiresAt: target + 50 });
  expect((await post(w, next)).outcome).toBe('accepted');
  expect(requests.length).toBe(2);
  expect((await roomState(w, m.ridHex)).storage).not.toHaveProperty(`push-nonce:${first.nonce}`);
}, 15000);

for (const name of ['PUSH_SEND_IP', 'PUSH_SEND_RID', 'PUSH_SEND_TOKEN', 'PUSH_SEND_AGGREGATE'])
  test(`actual durable ${name} low policy counts without APNs second send`, async () => {
    const { worker: w, machine: m, device: d, recipient: p } = await setup({ [name]: '1' });
    expect((await post(w, await submission(w, m, d, p))).outcome).toBe('accepted');
    expect(await post(w, await submission(w, m, d, p))).toMatchObject({
      outcome: 'rejected',
      reason: 'RATE_LIMITED',
      retryable: true,
    });
    expect(requests.length).toBe(1);
  }, 15000);
for (const name of ['PUSH_ATTEMPT_IP', 'PUSH_ATTEMPT_AGGREGATE'])
  test(`actual durable precrypto ${name} refuses before expensive proof route`, async () => {
    const { worker: w, machine: m, device: d, recipient: p } = await setup({ [name]: '1' });
    const s = await submission(w, m, d, p);
    const bad = { ...s, signature: r.b64u(new Uint8Array(64)) };
    expect(await post(w, bad)).toMatchObject({ outcome: 'rejected', reason: 'BAD_SIGNATURE' });
    expect(await post(w, bad)).toMatchObject({
      outcome: 'rejected',
      reason: 'RATE_LIMITED',
      requestDigest: null,
      retryable: true,
    });
    expect(requests.length).toBe(0);
  }, 15000);

test('real APNs rejection is final fixed invalid-token outcome with no environment fallback or raw receiver detail', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  status = 400;
  responseBody = '{"reason":"BadDeviceToken","private":"RECEIVER_PRIVATE_SENTINEL"}';
  const s = await submission(w, m, d, p);
  const first = await post(w, s);
  expect(first).toMatchObject({ outcome: 'rejected', reason: 'INVALID_TOKEN', retryable: false });
  expect(JSON.stringify(first)).not.toContain('RECEIVER_PRIVATE_SENTINEL');
  expect(requests.length).toBe(1);
  expect(await post(w, s)).toEqual(first);
  expect(requests.length).toBe(1);
}, 15000);

test('actual production configured audience refuses HTTP even when owned test scheme seam admits it', async () => {
  const { worker: w, machine: m } = await setup();
  const res = await get(`${w.url}/__room/${m.ridHex}/__productionaudience`);
  expect((await res.json()) as { audience: string | null }).toEqual({ audience: null });
}, 15000);

test('actual APNs receiver stall is aborted by remaining signed expiry and retained as uncertain', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  stall = true;
  const now = Math.floor(Date.now() / 1000);
  const s = await submission(w, m, d, p, { issuedAt: now, expiresAt: now + 2 });
  const start = Date.now();
  const first = await post(w, s);
  expect(first.outcome).toBe('uncertain');
  expect(Date.now() - start).toBeLessThan(3500);
  expect(requests.length).toBe(1);
  const row = (await roomState(w, m.ridHex)).storage[`push-nonce:${s.nonce}`];
  expect(row).not.toHaveProperty('result');
  expect((row as { until: number }).until).toBe(s.expiresAt + 60);
}, 15000);

test('actual lost APNs response is uncertain and identical nonce cannot initiate another network effect', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  drop = true;
  const s = await submission(w, m, d, p);
  const first = await post(w, s);
  expect(first.outcome).toBe('uncertain');
  expect(requests.length).toBe(1);
  expect(await post(w, s)).toEqual(first);
  expect(requests.length).toBe(1);
}, 15000);

test('durable global send budget survives actual orderly workerd restart', async () => {
  const path = mkdtempSync(join(tmpdir(), 'remi-push-budget-'));
  persistence.push(path);
  const {
    worker: w,
    machine: m,
    device: d,
    recipient: p,
    config,
  } = await setup({ PUSH_SEND_TOKEN: '1' }, path);
  expect((await post(w, await submission(w, m, d, p))).outcome).toBe('accepted');
  const second = await submission(w, m, d, p);
  await w.stop();
  worker = undefined;
  worker = await startWorker(config, true, { path, port: Number(new URL(w.url).port) });
  expect(await post(worker, second)).toMatchObject({
    outcome: 'rejected',
    reason: 'RATE_LIMITED',
    retryable: true,
  });
  expect(requests.length).toBe(1);
}, 15000);

test('durable send cardinality preserves current and previous window records; only expired rows are reclaimed', async () => {
  const {
    worker: w,
    machine: m,
    device: d,
    recipient: p,
  } = await setup({ PUSH_SEND_RECORDS: '4' });
  const first = await submission(w, m, d, p);
  expect((await post(w, first)).outcome).toBe('accepted');
  const read = async () => {
    const v = (await (await get(`${w.url}/__limiter/__state`)).json()) as {
      storage: Record<string, unknown>;
    };
    return Object.fromEntries(Object.entries(v.storage).filter(([k]) => k.startsWith('ps:')));
  };
  const before = await read();
  expect(Object.keys(before).length).toBe(4);
  expect(await post(w, await submission(w, m, d, p, { token: 'cd'.repeat(32) }))).toMatchObject({
    outcome: 'rejected',
    reason: 'CAPACITY',
  });
  expect(await read()).toEqual(before);
  const old = Math.floor(Date.now() / 60000);
  const next = (old + 1) * 60000 - Date.now() + 10;
  await get(`${w.url}/__limiter/__clock`, {
    method: 'POST',
    body: JSON.stringify({ advanceMs: next }),
  });
  expect(await post(w, await submission(w, m, d, p))).toMatchObject({
    outcome: 'rejected',
    reason: 'CAPACITY',
  });
  expect(await read()).toEqual(before);
  await get(`${w.url}/__limiter/__clock`, {
    method: 'POST',
    body: JSON.stringify({ advanceMs: 60000 }),
  });
  expect((await post(w, await submission(w, m, d, p))).outcome).toBe('accepted');
  expect(requests.length).toBe(2);
  expect(Object.keys(await read()).length).toBe(4);
}, 15000);

test('real precrypto cardinality capacity refusal leaves no partial budget writes', async () => {
  const {
    worker: w,
    machine: m,
    device: d,
    recipient: p,
  } = await setup({ PUSH_ATTEMPT_RECORDS: '1' });
  expect(await post(w, await submission(w, m, d, p))).toMatchObject({
    outcome: 'rejected',
    reason: 'CAPACITY',
    requestDigest: null,
  });
  expect(requests.length).toBe(0);
  const state = (await (await get(`${w.url}/__limiter/__state`)).json()) as {
    storage: Record<string, unknown>;
  };
  expect(Object.keys(state.storage).filter((k) => k.startsWith('pa:'))).toEqual([]);
}, 15000);

test('real gateway byte bounds, canonical routes and wrong audience all refuse before receiver', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const s = await submission(w, m, d, p);
  for (const path of [
    `/v2/push/${m.ridHex}?alias=1`,
    `/v2/push/${m.ridHex.toUpperCase()}`,
    `/v2/push/${m.ridHex}/`,
  ]) {
    const res = await get(`${w.url}${path}`, { method: 'POST', body: r.encodePushSubmit(s) });
    expect(r.decodePushSubmitResult(await res.text())).toMatchObject({
      outcome: 'rejected',
      reason: 'MALFORMED',
    });
  }
  const wrong = await submission(w, m, d, p, { audience: 'https://different-owned.example' });
  expect(await post(w, wrong)).toMatchObject({ outcome: 'rejected', reason: 'WRONG_AUDIENCE' });
  const res = await get(`${w.url}/v2/push/${m.ridHex}`, { method: 'POST', body: ' '.repeat(8193) });
  expect(r.decodePushSubmitResult(await res.text())).toMatchObject({
    outcome: 'rejected',
    reason: 'OVERSIZE',
  });
  const malformed = await get(`${w.url}/v2/push/${m.ridHex}`, {
    method: 'POST',
    body: Uint8Array.of(255),
  });
  expect(r.decodePushSubmitResult(await malformed.text())).toMatchObject({
    outcome: 'rejected',
    reason: 'MALFORMED',
  });
  expect(requests.length).toBe(0);
}, 15000);

test('legacy compatibility flag without secret remains refused on actual Worker', async () => {
  const { worker: w } = await setup({ LEGACY_PUSH_ENABLED: 'true', APNS_KEY_ID: '' });
  const res = await get(`${w.url}/push`, {
    method: 'POST',
    body: JSON.stringify({ token: 'owned', title: 'owned', body: 'owned' }),
  });
  expect(res.status).toBe(401);
  expect(requests.length).toBe(0);
}, 15000);

test('actual invalid machine proof gives equal fixed refusal for absent and enrolled device; valid absent remains unauthorized', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const enrolled = await submission(w, m, d, p);
  const other = await newIdentity();
  const absent = await submission(w, m, other, p);
  const malformedProof = r.b64u(new Uint8Array(64));
  const a = await post(w, { ...enrolled, signature: malformedProof });
  const b = await post(w, { ...absent, signature: malformedProof });
  expect(a).toEqual({
    v: 2,
    requestDigest: null,
    outcome: 'rejected',
    reason: 'BAD_SIGNATURE',
    retryable: false,
  });
  expect(b).toEqual(a);
  const result = await post(w, absent);
  expect(result).toMatchObject({ outcome: 'rejected', reason: 'NOT_ENROLLED', retryable: false });
  expect(result.requestDigest).toMatch(/^[0-9a-f]{64}$/);
  expect((await roomState(w, m.ridHex)).storage).not.toHaveProperty(`dev:${hex(other.publicKey)}`);
  expect(requests.length).toBe(0);
}, 15000);

test('actual corrupt enrollment and failed initial sync reveal only fixed proof verdicts and never send', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const signed = await submission(w, m, d, p);
  const bad = { ...signed, signature: r.b64u(new Uint8Array(64)) };
  const row = `dev:${hex(d.publicKey)}`;
  const original = (await roomState(w, m.ridHex)).storage[row];
  const fixedBad: r.PushSubmitResult = {
    v: 2,
    requestDigest: null,
    outcome: 'rejected',
    reason: 'BAD_SIGNATURE',
    retryable: false,
  };
  await get(`${w.url}/__room/${m.ridHex}/__seed`, {
    method: 'POST',
    body: JSON.stringify({ [row]: { at: 'PRIVATE_STORE_SENTINEL' } }),
  });
  expect(await post(w, bad)).toEqual(fixedBad);
  expect(await post(w, signed)).toMatchObject({
    outcome: 'rejected',
    reason: 'STORE_ERROR',
    retryable: true,
  });
  await get(`${w.url}/__room/${m.ridHex}/__seed`, {
    method: 'POST',
    body: JSON.stringify({ [row]: original }),
  });
  await gate(w, m.ridHex, 'initial-sync-error');
  expect(await post(w, bad)).toEqual(fixedBad);
  await gate(w, m.ridHex, 'initial-sync-error');
  expect(await post(w, signed)).toMatchObject({
    outcome: 'rejected',
    reason: 'STORE_ERROR',
    retryable: true,
  });
  expect(requests.length).toBe(0);
  expect((await roomState(w, m.ridHex)).storage).not.toHaveProperty(`push-nonce:${signed.nonce}`);
}, 15000);

test('actual concurrent identical nonce sees durable pending and initiates only one APNs effect', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const signed = await submission(w, m, d, p);
  await gate(w, m.ridHex, 'consume-sync');
  const first = post(w, signed);
  await reached(w, m.ridHex);
  const pending = await post(w, signed);
  expect(pending.outcome).toBe('uncertain');
  expect(requests.length).toBe(0);
  await gate(w, m.ridHex, null);
  const accepted = await first;
  expect(accepted.outcome).toBe('accepted');
  expect(accepted.requestDigest).toBe(pending.requestDigest);
  expect(await post(w, signed)).toEqual(accepted);
  expect(requests.length).toBe(1);
}, 15000);

test('actual signed submit expiry during JWT completion delivery refuses before APNs effect', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const signed = await submission(w, m, d, p);
  await gate(w, m.ridHex, 'jwt');
  const result = post(w, signed);
  await reached(w, m.ridHex);
  await get(`${w.url}/__room/${m.ridHex}/__clock`, {
    method: 'POST',
    body: JSON.stringify({ advanceMs: 60_000 }),
  });
  await gate(w, m.ridHex, null);
  expect(await result).toMatchObject({ outcome: 'rejected', reason: 'EXPIRED', retryable: false });
  expect(requests.length).toBe(0);
}, 15000);

test('actual pending nonce ownership replacement during JWT completion prevents APNs effect', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const signed = await submission(w, m, d, p);
  await gate(w, m.ridHex, 'jwt');
  const result = post(w, signed);
  await reached(w, m.ridHex);
  const key = `push-nonce:${signed.nonce}`;
  const record = (await roomState(w, m.ridHex)).storage[key] as {
    digest: string;
    epoch: string;
    until: number;
  };
  await get(`${w.url}/__room/${m.ridHex}/__seed`, {
    method: 'POST',
    body: JSON.stringify({ [key]: { ...record, digest: '00'.repeat(32) } }),
  });
  await gate(w, m.ridHex, null);
  expect((await result).outcome).toBe('uncertain');
  expect(requests.length).toBe(0);
}, 15000);
