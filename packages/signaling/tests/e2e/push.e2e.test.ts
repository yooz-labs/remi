/** Real SQLite DO + JWT/signature/seal; only Apple network destination is owned HTTP/1.1. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
/** The per-deployment bearer secret (#1200); every v2 submit must present it. */
const PUSH_SECRET = 'owned-test-push-secret';
const bearer = { authorization: `Bearer ${PUSH_SECRET}` };
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

/** A `vars` entry of `undefined` removes that Worker variable (the harness otherwise merges). */
async function setup(vars: Record<string, string | undefined> = {}, persist?: string) {
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
  const merged: Record<string, string | undefined> = {
    APNS_KEY_ID: 'OWNEDTEST1',
    APNS_TEAM_ID: 'OWNEDTEAM1',
    APNS_PRIVATE_KEY: pem,
    APNS_BUNDLE_ID: 'owned.synthetic.topic',
    TEST_APNS_ENDPOINT: `http://127.0.0.1:${address.port}`,
    PUSH_SECRET,
    ...vars,
  };
  const config = Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
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
  // The Worker's view (#1200): the class, never the sealed kind or key metadata.
  const expiresAt = changes.expiresAt ?? now + 50;
  const unsigned: r.UnsignedPushSubmit = {
    v: 2,
    audience: w.url,
    rid: content.rid,
    machinePublicKey: content.machinePublicKey,
    devicePublicKey: content.devicePublicKey,
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    collapseId: content.collapseId,
    pushClass: 'alert',
    nonce: r.b64u(r.systemRandom(32)),
    issuedAt: now,
    expiresAt,
    storeUntil: changes.storeUntil ?? expiresAt,
    sealed: r.b64u(sealed),
    ...changes,
  };
  return {
    ...unsigned,
    signature: r.b64u(await m.signer.sign(await r.buildPushSubmitSigningInput(unsigned))),
  };
}
async function post(
  w: TestWorker,
  s: r.PushSubmit | string,
  headers: Record<string, string> = bearer,
) {
  const rid =
    typeof s === 'string' ? (s.match(/"rid":"([0-9a-f]+)"/)?.[1] ?? '00'.repeat(16)) : s.rid;
  const res = await get(`${w.url}/v2/push/${rid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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
  // #1200 A5: the carrier APNs relays names the room, the collapse id and the sealed bytes only.
  expect(body.remiPush).toEqual({
    v: 2,
    rid: s.rid,
    collapseId: s.collapseId,
    sealed: s.sealed,
  });
  expect(req.body).not.toContain('keyVersion');
  expect(req.body).not.toContain('"kind"');
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

// #1200 A4: Apple stores the notification until `apns-expiration`; it follows the signed storage
// deadline (the content expiry), not the 60 second acceptance window of the submit.
test('apns-expiration follows the signed storage deadline while acceptance stays 60 seconds', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const now = Math.floor(Date.now() / 1000);
  const s = await submission(w, m, d, p, {
    issuedAt: now,
    expiresAt: now + 50,
    storeUntil: now + 900,
  });
  expect(await post(w, s)).toMatchObject({ outcome: 'accepted' });
  expect(requests[0]?.headers['apns-expiration']).toBe(String(now + 900));
  const row = (await roomState(w, m.ridHex)).storage[`push-nonce:${s.nonce}`] as { until: number };
  expect(row.until, 'the nonce is retained for the submit window, not the storage deadline').toBe(
    now + 50 + 60,
  );
}, 15000);

test('real durable nonce same digest returns retained outcome; different signed content never sends twice', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const s = await submission(w, m, d, p);
  const first = await post(w, s);
  expect(first.outcome).toBe('accepted');
  expect(await post(w, s)).toEqual(first);
  const changed = await submission(w, m, d, p, { nonce: s.nonce, pushClass: 'background' });
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

/** Durable budget rows the limiter holds: any `pa:` or `ps:` row means a budget was charged. */
async function budgetRows(w: TestWorker): Promise<string[]> {
  const v = (await (await get(`${w.url}/__limiter/__state`)).json()) as {
    storage: Record<string, unknown>;
  };
  return Object.keys(v.storage).filter((k) => k.startsWith('pa:') || k.startsWith('ps:'));
}
const unauthorized: r.PushSubmitResult = {
  v: 2,
  requestDigest: null,
  outcome: 'rejected',
  reason: 'UNAUTHORIZED',
  retryable: false,
};

// #1200 A1: plan 3.2 asks for a machine-key signature PLUS a per-deployment secret. Before the
// fix the v2 route read no bearer at all, so anyone could enroll a device in a room named by
// their own key and submit for any token, and garbage posts drained the shared attempt budget.
for (const [name, headers] of [
  ['missing', {}],
  ['wrong', { authorization: 'Bearer not-the-deployment-secret' }],
  ['wrong scheme', { authorization: `Basic ${PUSH_SECRET}` }],
  ['empty token', { authorization: 'Bearer ' }],
] as const)
  test(`v2 push with a ${name} bearer is refused before any budget or APNs effect`, async () => {
    const { worker: w, machine: m, device: d, recipient: p } = await setup();
    const s = await submission(w, m, d, p);
    const res = await get(`${w.url}/v2/push/${s.rid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: r.encodePushSubmit(s),
    });
    expect(res.status).toBe(401);
    expect(r.decodePushSubmitResult(await res.text())).toEqual(unauthorized);
    expect(await budgetRows(w)).toEqual([]);
    expect(requests.length).toBe(0);
    expect((await roomState(w, m.ridHex)).storage).not.toHaveProperty(`push-nonce:${s.nonce}`);
  }, 15000);

test('v2 push bearer is checked before the path, the body and the attempt budget', async () => {
  const { worker: w } = await setup({ PUSH_ATTEMPT_IP: '1' });
  for (const path of ['/v2/push/not-a-room', `/v2/push/${'0'.repeat(32)}?x=1`]) {
    const res = await get(`${w.url}${path}`, { method: 'POST', body: ' '.repeat(9000) });
    expect(res.status).toBe(401);
    expect(r.decodePushSubmitResult(await res.text())).toEqual(unauthorized);
  }
  expect(await budgetRows(w)).toEqual([]);
}, 15000);

// A deployment with no secret must not become an open relay (plan 3.2): refuse, never skip.
for (const [name, secret] of [
  ['unset', undefined],
  ['empty', ''],
  ['whitespace', ' \n\t'],
] as const)
  test(`v2 push on a deployment whose PUSH_SECRET is ${name} refuses every submit`, async () => {
    const { worker: w, machine: m, device: d, recipient: p } = await setup({ PUSH_SECRET: secret });
    const s = await submission(w, m, d, p);
    for (const headers of [
      {},
      { authorization: 'Bearer ' },
      { authorization: `Bearer ${secret ?? ''}` },
    ]) {
      const res = await get(`${w.url}/v2/push/${s.rid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: r.encodePushSubmit(s),
      });
      expect(res.status).toBe(401);
      expect(r.decodePushSubmitResult(await res.text())).toEqual(unauthorized);
    }
    expect(await budgetRows(w)).toEqual([]);
    expect(requests.length).toBe(0);
  }, 15000);

test('a correct bearer is accepted and the secret never appears in the APNs request', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  expect((await post(w, await submission(w, m, d, p))).outcome).toBe('accepted');
  const req = requests[0];
  if (!req) throw new Error('receiver missing');
  expect(JSON.stringify(req)).not.toContain(PUSH_SECRET);
}, 15000);

// #1200 A10 (owner decision): the legacy plaintext /push stays ON by default until secure push
// ships end to end (the default flips at the R7 gate), so a deployment that sets only PUSH_SECRET,
// as every existing one does, keeps working. It is disabled only by an explicit false value, and
// it still needs the bearer. APNs credentials are left unset here so a request that passes both
// gates stops at APNS_NOT_CONFIGURED instead of reaching Apple.
async function legacyPush(w: TestWorker, headers: Record<string, string> = bearer) {
  return get(`${w.url}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token: 'owned', title: 'owned', body: 'owned' }),
  });
}
test('legacy plaintext route is on by default and still requires the bearer', async () => {
  const { worker: w } = await setup({ APNS_KEY_ID: '', LEGACY_PUSH_ENABLED: undefined });
  expect((await legacyPush(w)).status).toBe(500);
  expect(((await (await legacyPush(w)).json()) as { error: string }).error).toBe(
    'APNS_NOT_CONFIGURED',
  );
  for (const headers of [
    {},
    { authorization: 'Bearer wrong' },
    { authorization: `Bearer ${PUSH_SECRET}x` },
    { authorization: `Bearer ${PUSH_SECRET.slice(0, -1)}` },
    { authorization: `bearer ${PUSH_SECRET}` },
  ])
    expect((await legacyPush(w, headers)).status).toBe(401);
  expect(requests.length).toBe(0);
}, 15000);

// The configured flag is trimmed and only an explicit false value disables the route: a secret set
// through `echo true | wrangler secret put` carries a newline that used to switch it off.
for (const [value, enabled] of [
  [undefined, true],
  ['', true],
  ['true', true],
  ['true\n', true],
  [' TRUE ', true],
  ['yes', true],
  ['garbage', true],
  ['false', false],
  ['false\n', false],
  [' False ', false],
  ['FALSE', false],
  ['0', false],
  ['no', false],
  ['off', false],
] as const)
  test(`LEGACY_PUSH_ENABLED=${JSON.stringify(value)} ${enabled ? 'leaves' : 'turns off'} the legacy route`, async () => {
    const { worker: w } = await setup({ APNS_KEY_ID: '', LEGACY_PUSH_ENABLED: value });
    const res = await legacyPush(w);
    if (enabled) expect(res.status).toBe(500);
    else {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('LEGACY_PUSH_DISABLED');
    }
    expect(requests.length).toBe(0);
  }, 15000);

test('legacy route accepts the secret as configured with surrounding whitespace', async () => {
  const { worker: w } = await setup({ APNS_KEY_ID: '', PUSH_SECRET: `  ${PUSH_SECRET}\n` });
  expect((await legacyPush(w)).status).toBe(500);
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

// #1200 A2 (#723): dismissals are quiet pushes that must not queue behind alerts. A shared
// per-room budget left answered cards on lock screens, which is why legacy gave dismissals their
// own, larger ceiling.
test('a dismissal has its own per-room budget: exhausting the alert budget does not refuse it', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup({ PUSH_SEND_RID: '1' });
  expect((await post(w, await submission(w, m, d, p))).outcome).toBe('accepted');
  expect(await post(w, await submission(w, m, d, p))).toMatchObject({
    outcome: 'rejected',
    reason: 'RATE_LIMITED',
  });
  const dismissal = await post(w, await submission(w, m, d, p, { pushClass: 'background' }));
  expect(dismissal.outcome).toBe('accepted');
  expect(requests.map((q) => q.headers['apns-push-type'])).toEqual(['alert', 'background']);
}, 15000);

test('alerts do not consume the dismissal budget and the dismissal budget is its own ceiling', async () => {
  const {
    worker: w,
    machine: m,
    device: d,
    recipient: p,
  } = await setup({ PUSH_SEND_RID_BACKGROUND: '1' });
  const dismiss = () => submission(w, m, d, p, { pushClass: 'background' });
  expect((await post(w, await dismiss())).outcome).toBe('accepted');
  expect(await post(w, await dismiss())).toMatchObject({
    outcome: 'rejected',
    reason: 'RATE_LIMITED',
    retryable: true,
  });
  expect((await post(w, await submission(w, m, d, p))).outcome).toBe('accepted');
  expect(requests.length).toBe(2);
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

// #1200 A3: a failure before APNs must be reported as what it is, and a transient one must leave
// the same signed bytes able to succeed on a retry. Before the fix an unusable APNs key threw after
// the nonce was consumed (HTTP 200 uncertain, nonce pending forever, never retried), and every
// non-2xx from Apple, a 429 or 503 included, became a final non-retryable APNS_REJECTED.
test('an unusable APNs key is a retryable unavailable outcome and strands no nonce', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup({ APNS_PRIVATE_KEY: 'x' });
  const s = await submission(w, m, d, p);
  const first = await post(w, s);
  expect(first).toMatchObject({ outcome: 'rejected', reason: 'APNS_UNAVAILABLE', retryable: true });
  expect(first.requestDigest).toMatch(/^[0-9a-f]{64}$/);
  expect((await roomState(w, m.ridHex)).storage).not.toHaveProperty(`push-nonce:${s.nonce}`);
  expect(await post(w, s)).toEqual(first);
  expect(requests.length).toBe(0);
}, 15000);

test('missing APNs credentials are a retryable unavailable outcome that charges no send budget', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup({ APNS_KEY_ID: '' });
  const first = await post(w, await submission(w, m, d, p));
  expect(first).toMatchObject({ outcome: 'rejected', reason: 'APNS_UNAVAILABLE', retryable: true });
  expect((await budgetRows(w)).filter((k) => k.startsWith('ps:'))).toEqual([]);
  expect(requests.length).toBe(0);
}, 15000);

for (const [httpStatus, reason] of [
  [429, 'TooManyRequests'],
  [500, 'InternalServerError'],
  [503, 'ServiceUnavailable'],
] as const)
  test(`APNs ${httpStatus} ${reason} is retryable and the same signed bytes succeed once APNs recovers`, async () => {
    const { worker: w, machine: m, device: d, recipient: p } = await setup();
    const s = await submission(w, m, d, p);
    status = httpStatus;
    responseBody = JSON.stringify({ reason });
    expect(await post(w, s)).toMatchObject({
      outcome: 'rejected',
      reason: 'APNS_UNAVAILABLE',
      retryable: true,
    });
    expect((await roomState(w, m.ridHex)).storage).not.toHaveProperty(`push-nonce:${s.nonce}`);
    status = 200;
    responseBody = '';
    expect(await post(w, s)).toMatchObject({ outcome: 'accepted' });
    expect(requests.length).toBe(2);
    expect(await post(w, s)).toMatchObject({ outcome: 'accepted' });
    expect(requests.length).toBe(2);
  }, 15000);

test('an expired provider token is retryable and the retry signs a fresh JWT', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const s = await submission(w, m, d, p);
  status = 403;
  responseBody = '{"reason":"ExpiredProviderToken"}';
  expect(await post(w, s)).toMatchObject({
    outcome: 'rejected',
    reason: 'APNS_UNAVAILABLE',
    retryable: true,
  });
  status = 200;
  responseBody = '';
  expect(await post(w, s)).toMatchObject({ outcome: 'accepted' });
  expect(requests.length).toBe(2);
  expect(requests[1]?.headers['authorization']).not.toBe(requests[0]?.headers['authorization']);
}, 15000);

test('a permanent APNs rejection stays final and is retained for the same nonce', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const s = await submission(w, m, d, p);
  status = 400;
  responseBody = '{"reason":"BadTopic"}';
  const first = await post(w, s);
  expect(first).toMatchObject({ outcome: 'rejected', reason: 'APNS_REJECTED', retryable: false });
  status = 200;
  responseBody = '';
  expect(await post(w, s)).toEqual(first);
  expect(requests.length).toBe(1);
}, 15000);

// A fixed-window refusal cannot succeed again inside its window, so the Worker says when the next
// one starts and the daemon waits for it instead of retrying within the same minute.
for (const [name, vars] of [
  ['send', { PUSH_SEND_TOKEN: '1' }],
  ['attempt', { PUSH_ATTEMPT_IP: '1' }],
] as const)
  test(`a ${name} budget refusal carries the seconds until the next window as Retry-After`, async () => {
    const { worker: w, machine: m, device: d, recipient: p } = await setup(vars);
    const submit = async () => {
      const s = await submission(w, m, d, p);
      return get(`${w.url}/v2/push/${s.rid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer },
        body: r.encodePushSubmit(s),
      });
    };
    expect((await submit()).status).toBe(200);
    const refused = await submit();
    expect(r.decodePushSubmitResult(await refused.text())).toMatchObject({
      reason: 'RATE_LIMITED',
      retryable: true,
    });
    const seconds = Number(refused.headers.get('retry-after'));
    expect(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60).toBe(true);
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
    const res = await get(`${w.url}${path}`, {
      method: 'POST',
      headers: bearer,
      body: r.encodePushSubmit(s),
    });
    expect(r.decodePushSubmitResult(await res.text())).toMatchObject({
      outcome: 'rejected',
      reason: 'MALFORMED',
    });
  }
  const wrong = await submission(w, m, d, p, { audience: 'https://different-owned.example' });
  expect(await post(w, wrong)).toMatchObject({ outcome: 'rejected', reason: 'WRONG_AUDIENCE' });
  const res = await get(`${w.url}/v2/push/${m.ridHex}`, {
    method: 'POST',
    headers: bearer,
    body: ' '.repeat(8193),
  });
  expect(r.decodePushSubmitResult(await res.text())).toMatchObject({
    outcome: 'rejected',
    reason: 'OVERSIZE',
  });
  const malformed = await get(`${w.url}/v2/push/${m.ridHex}`, {
    method: 'POST',
    headers: bearer,
    body: Uint8Array.of(255),
  });
  expect(r.decodePushSubmitResult(await malformed.text())).toMatchObject({
    outcome: 'rejected',
    reason: 'MALFORMED',
  });
  expect(requests.length).toBe(0);
}, 15000);

test('legacy compatibility flag without secret remains refused on actual Worker', async () => {
  const { worker: w } = await setup({
    LEGACY_PUSH_ENABLED: 'true',
    PUSH_SECRET: '',
    APNS_KEY_ID: '',
  });
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

test('actual pending nonce ownership replacement during consume sync completion prevents APNs effect', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const signed = await submission(w, m, d, p);
  // #1200 A3: the JWT is now obtained before the nonce is consumed, so ownership is
  // contested at the first point the pending record exists: its consume sync.
  await gate(w, m.ridHex, 'consume-sync');
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

test('actual gateway refuses all14 reviewed weak encodings in both public fields and any restated sealed-only field', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const s = await submission(w, m, d, p);
  // Read the single reviewed table; independent shared arithmetic tests validate its exact membership.
  const table = readFileSync(
    new URL('../../../shared/src/relay/small-order.ts', import.meta.url),
    'utf8',
  );
  const encodings = [...table.matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1] as string);
  expect(encodings.length).toBe(14);
  for (const key of encodings)
    for (const field of ['machinePublicKey', 'devicePublicKey']) {
      expect(
        await post(w, JSON.stringify({ ...s, [field]: r.b64u(Buffer.from(key, 'hex')) })),
      ).toMatchObject({ outcome: 'rejected', reason: 'MALFORMED', requestDigest: null });
    }
  // #1200 A5: the push key, key version, revision and event kind are sealed-only. The Worker
  // cannot judge a push key (an off-curve one is refused by the daemon's seal), and a producer
  // that restates any of them in the clear is refused by the strict decoder.
  const restated: [string, unknown][] = [
    ['pushPublicKey', s.nonce],
    ['keyVersion', 1],
    ['revision', 1],
    ['kind', 'question'],
  ];
  for (const [field, value] of restated)
    expect(await post(w, JSON.stringify({ ...s, [field]: value }))).toMatchObject({
      outcome: 'rejected',
      reason: 'MALFORMED',
      requestDigest: null,
    });
  expect(requests.length).toBe(0);
  expect(
    Object.keys((await roomState(w, m.ridHex)).storage).filter((k) => k.startsWith('push-nonce:')),
  ).toEqual([]);
}, 15000);

// #1200 A9: the acceptance names both of these and no other test covered them.
test('a URL naming a different valid room than the signed body is refused before any effect', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const s = await submission(w, m, d, p);
  const other = await newMachine();
  expect(other.ridHex).not.toBe(m.ridHex);
  const res = await get(`${w.url}/v2/push/${other.ridHex}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer },
    body: r.encodePushSubmit(s),
  });
  expect(r.decodePushSubmitResult(await res.text())).toMatchObject({
    outcome: 'rejected',
    reason: 'MALFORMED',
    retryable: false,
  });
  expect(requests.length).toBe(0);
  for (const rid of [m.ridHex, other.ridHex])
    expect(
      Object.keys((await roomState(w, rid)).storage).filter((k) => k.startsWith('push-nonce:')),
    ).toEqual([]);
  // The same bytes still succeed at the room they were signed for: only the URL was wrong.
  expect((await post(w, s)).outcome).toBe('accepted');
}, 15000);

test('an already stale or not yet valid signed submit is refused before any effect', async () => {
  const { worker: w, machine: m, device: d, recipient: p } = await setup();
  const now = Math.floor(Date.now() / 1000);
  for (const [issuedAt, expiresAt] of [
    [now - 120, now - 60],
    [now - 61, now - 1],
    [now - 60, now],
    [now + 120, now + 180],
  ] as const) {
    const stale = await submission(w, m, d, p, { issuedAt, expiresAt });
    expect(await post(w, stale), `issuedAt=${issuedAt - now} expiresAt=${expiresAt - now}`).toEqual(
      {
        v: 2,
        requestDigest: null,
        outcome: 'rejected',
        reason: 'EXPIRED',
        retryable: false,
      },
    );
    expect((await roomState(w, m.ridHex)).storage).not.toHaveProperty(`push-nonce:${stale.nonce}`);
  }
  expect(requests.length).toBe(0);
}, 15000);

test('actual configured enrollment limit above64 still admits push with lazy per-row authority', async () => {
  const {
    worker: w,
    machine: m,
    device: d,
    recipient: p,
  } = await setup({ MAX_ENROLLED: '1000000' });
  expect((await post(w, await submission(w, m, d, p))).outcome).toBe('accepted');
  expect(requests.length).toBe(1);
}, 15000);

test('actual retained nonce from a revoked enrollment never acknowledges a fresh re-enrollment epoch', async () => {
  const { worker: w, machine: m, device: d, recipient: p, host } = await setup();
  const signed = await submission(w, m, d, p);
  expect((await post(w, signed)).outcome).toBe('accepted');
  expect((await host.revoke(d.publicKey))['ok']).toBe(true);
  expect((await host.enroll(d.publicKey))['ok']).toBe(true);
  expect(await post(w, signed)).toMatchObject({
    outcome: 'rejected',
    reason: 'NOT_ENROLLED',
    retryable: false,
  });
  expect(requests.length).toBe(1);
}, 15000);
