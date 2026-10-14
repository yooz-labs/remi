import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  type BrowserFixture,
  browserFixture,
  until,
} from '../helpers/browser-link-service-fixture.ts';
const fixtures: BrowserFixture[] = [];
async function fixture() {
  const f = await browserFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

test('actual C1 executable offers to the selected signed TLS receiver, with replacement and release', async () => {
  const f = await fixture();
  const a = await f.client();
  const b = await f.client({ freshKey: true });
  expect(f.service.isAvailable(a.id)).toBe(true);
  const select = a.request(1);
  const selected = await a.submit(select);
  expect(selected.outcome).toBe('selected');
  const url = 'https://example.invalid/path?owned=%26%22#browser-test';
  const child = Bun.spawn([f.producer.browserPath, url], {
    cwd: f.files.work,
    env: f.files.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await child.exited).toBe(0);
  await until(
    () => a.browser.some((m) => m.type === 'browser_link_candidate'),
    'actual producer candidate',
  );
  expect(a.browser.find((m) => m.type === 'browser_link_candidate')?.url).toBe(url);
  expect(b.browser.some((m) => m.type === 'browser_link_candidate')).toBe(false);
  expect(await a.submit(select)).toEqual(selected);
  expect((await b.submit(b.request(1))).outcome).toBe('selected');
  await until(
    () =>
      a.browser.some((m) => m.type === 'browser_link_receiver_ended' && m.reason === 'replaced'),
    'prior receiver ended',
  );
  expect((await a.submit(select)).outcome).toBe('refused');
  const stale = await a.submit(select);
  expect(stale.outcome === 'refused' && stale.code).toBe('stale_receiver');
  const foreign = await a.submit(a.request(2, 'release'));
  expect(foreign.outcome === 'refused' && foreign.code).toBe('stale_receiver');
  expect(f.service.offer(f.context(), url)).toBe(true);
  await until(
    () => b.browser.some((m) => m.type === 'browser_link_candidate'),
    'replacement candidate',
  );
  expect(a.browser.filter((m) => m.type === 'browser_link_candidate').length).toBe(1);
  const release = b.request(2, 'release');
  const released = await b.submit(release);
  expect(released.outcome).toBe('released');
  expect(await b.submit(release)).toEqual(released);
  expect(f.service.offer(f.context(), url)).toBe(false);
  expect(
    JSON.stringify(a.browser.filter((m) => m.type === 'browser_link_receiver_result')).includes(
      url,
    ),
  ).toBe(false);
}, 15000);

test('same-key replacement and concurrent explicit selections use separate original-grant locks', async () => {
  const f = await fixture();
  const a = await f.client();
  const b = await f.client();
  await a.submit(a.request(1));
  await b.submit(b.request(1));
  await until(
    () =>
      a.browser.some((m) => m.type === 'browser_link_receiver_ended' && m.reason === 'replaced'),
    'same-key ended outside requester lock',
  );
  const results = await Promise.all([a.submit(a.request(2)), b.submit(b.request(2))]);
  expect(results.every((m) => m.outcome === 'selected')).toBe(true);
  expect(f.service.offer(f.context(), 'https://example.invalid/last-explicit')).toBe(true);
  await until(
    () =>
      [...a.browser, ...b.browser].filter((m) => m.type === 'browser_link_candidate').length === 1,
    'one final selected receiver',
  );
  expect(
    [...a.browser, ...b.browser].filter((m) => m.type === 'browser_link_candidate').length,
  ).toBe(1);
}, 15000);

test('browser sequence consumes refusals/conflicts, preserves watermark past32 receipts and rejects skips/max', async () => {
  const f = await fixture();
  const a = await f.client();
  const bad = a.request(1, 'select', {
    binding: { harness: 'claude', harnessSessionId: randomUUID() },
  });
  const refused = await a.submit(bad);
  expect(refused.outcome === 'refused' && refused.code).toBe('binding_changed');
  const conflict = await a.submit(a.request(1));
  expect(conflict.outcome === 'refused' && conflict.code).toBe('conflict');
  const skipped = await a.submit(a.request(3));
  expect(skipped.outcome === 'refused' && skipped.code).toBe('sequence');
  const oldGap = await a.submit(a.request(2));
  expect(oldGap.outcome === 'refused' && oldGap.code).toBe('sequence');
  const second = a.request(4);
  expect((await a.submit(second)).outcome).toBe('selected');
  const reusedId = await a.submit(a.request(5, 'release', { id: second.id }));
  expect(reusedId.outcome === 'refused' && reusedId.code).toBe('conflict');
  for (let seq = 6; seq <= 38; seq++)
    expect((await a.submit(a.request(seq))).outcome).toBe('selected');
  expect((await a.submit(a.request(39, 'release'))).outcome).toBe('released');
  const evicted = await a.submit(second);
  expect(evicted.outcome === 'refused' && evicted.code).toBe('sequence');
  const max = await a.submit(a.request(0xffffffff));
  expect(max.outcome === 'refused' && max.code).toBe('sequence');
  expect(f.service.offer(f.context(), 'https://example.invalid/evicted')).toBe(false);
}, 15000);

test('a skipped future wire sequence is consumed and can never become effectful after lower gaps', async () => {
  const f = await fixture();
  const a = await f.client();
  const initial = await a.submit(a.request(1));
  expect(initial.outcome).toBe('selected');
  const skipped = a.request(3);
  const refusal = await a.submit(skipped);
  expect(refusal.outcome === 'refused' && refusal.code).toBe('sequence');
  const gap = await a.submit(a.request(2));
  expect(gap.outcome === 'refused' && gap.code).toBe('sequence');
  expect(await a.submit(skipped)).toEqual(refusal);
  expect(a.browser.filter((m) => m.type === 'browser_link_receiver_ended').length).toBe(0);
  const next = await a.submit(a.request(4));
  expect(next.outcome).toBe('selected');
  expect(
    next.outcome === 'selected' &&
      initial.outcome === 'selected' &&
      next.leaseId !== initial.leaseId,
  ).toBe(true);
}, 15000);

test('the eleventh paced current offer is refused without hidden recipient or buffer vetoes', async () => {
  const f = await fixture();
  const a = await f.client();
  await a.submit(a.request(1));
  for (let i = 0; i < 10; i++) {
    expect(f.service.offer(f.context(), 'https://example.invalid/rate')).toBe(true);
    await until(
      () => a.browser.filter((m) => m.type === 'browser_link_candidate').length === i + 1,
      'paced rate candidate',
    );
  }
  expect(f.service.offer(f.context(), 'https://example.invalid/rate')).toBe(false);
  const b = await f.client();
  expect((await b.submit(b.request(1))).outcome).toBe('selected');
  expect(f.service.offer(f.context(), 'https://example.invalid/rate')).toBe(false);
  f.registry.detachConnection(b.id, true);
  f.registry.attachConnection(f.sessionId, b.id);
  expect((await b.submit(b.request(2))).outcome).toBe('selected');
  expect(f.service.offer(f.context(), 'https://example.invalid/rate')).toBe(false);
  await f.rotate();
  expect((await b.submit(b.request(3))).outcome).toBe('selected');
  expect(f.service.offer(f.context(), 'https://example.invalid/rate')).toBe(false);
}, 15000);

test('duplicate attach preserves a lease; real detach/reattach and explicit runtime transitions never revive it', async () => {
  const f = await fixture();
  const a = await f.client();
  const original = a.request(1);
  expect((await a.submit(original)).outcome).toBe('selected');
  f.registry.attachConnection(f.sessionId, a.id);
  expect(f.service.offer(f.context(), 'https://example.invalid/live')).toBe(true);
  f.registry.detachConnection(a.id, true);
  f.registry.attachConnection(f.sessionId, a.id);
  expect(f.service.offer(f.context(), 'https://example.invalid/detached')).toBe(false);
  const stale = await a.submit(original);
  expect(stale.outcome === 'refused' && stale.code).toBe('stale_receiver');
  expect((await a.submit(a.request(2))).outcome).toBe('selected');
  const old = f.context();
  await f.rotate();
  await until(
    () =>
      a.browser.some(
        (m) => m.type === 'browser_link_receiver_ended' && m.reason === 'session_changed',
      ),
    'ended after binding loss',
  );
  expect(f.service.offer(old, 'https://example.invalid/old-runtime')).toBe(false);
  expect(f.service.offer(f.context(), 'https://example.invalid/new-runtime')).toBe(false);
  await f.rotate(old.binding.harnessSessionId); // Actual lifecycle seam changes the marker, including A→B→A.
  expect(f.service.offer(f.context(), 'https://example.invalid/returned-binding')).toBe(false);
  expect((await a.submit(a.request(3))).outcome).toBe('selected');
  expect(f.service.offer(f.context(), 'https://example.invalid/fresh')).toBe(true);
}, 15000);

test('revoke/regrant cannot deliver an old URL or selected receipt under the new grant', async () => {
  const f = await fixture();
  const a = await f.client();
  const request = a.request(1);
  expect((await a.submit(request)).outcome).toBe('selected');
  await f.trust.removeAuthorizedKey(a.identity.fingerprint);
  await f.trust.addAuthorizedKey(a.identity.publicKeyRaw, 'owned new grant');
  expect(f.service.offer(f.context(), 'https://example.invalid/regrant')).toBe(false);
  const result = await a.submit(request);
  expect(result.outcome === 'refused' && result.code).toBe('stale_receiver');
  expect(a.browser.some((m) => m.type === 'browser_link_candidate')).toBe(false);
  expect(a.browser.some((m) => m.type === 'browser_link_receiver_ended')).toBe(false);
  expect((await a.submit(a.request(2))).outcome).toBe('selected');
}, 15000);

test('URL-free ended may pass after the old binding is gone; selected replay and URL never do', async () => {
  const f = await fixture();
  const a = await f.client();
  const original = a.request(1);
  await a.submit(original);
  f.bindings.update(f.sessionId, randomUUID()); // The reason to end precedes its limited delivery guard.
  f.service.maintainSession(f.sessionId);
  await until(
    () => a.browser.some((m) => m.type === 'browser_link_receiver_ended'),
    'ended after binding changed',
  );
  const notice = a.browser.find((m) => m.type === 'browser_link_receiver_ended');
  expect(notice?.reason).toBe('session_changed');
  expect(JSON.stringify(notice).includes('url')).toBe(false);
  const old = await a.submit(original);
  expect(old.outcome === 'refused' && old.code).toBe('stale_receiver');
  expect(f.service.offer(f.context(), 'https://example.invalid/old')).toBe(false);
}, 15000);

test('actual PTY/session replacement needs a fresh explicit sequence and runtime marker', async () => {
  const f = await fixture();
  const a = await f.client();
  const original = a.request(1);
  await a.submit(original);
  const oldRuntime = f.context();
  await f.switchSession(f.sessionId);
  expect(f.pty.isRunning).toBe(false);
  expect(f.service.offer(oldRuntime, 'https://example.invalid/old-pty')).toBe(false);
  const old = await a.submit(original);
  expect(old.outcome === 'refused' && old.code).toBe('stale_receiver');
  expect((await a.submit(a.request(2))).outcome).toBe('selected');
  expect(f.service.offer(f.context(), 'HTTPS://EXAMPLE.INVALID/new-pty')).toBe(true);
  await until(
    () => a.browser.some((m) => m.type === 'browser_link_candidate'),
    'normalized current runtime offer',
  );
  expect(a.browser.find((m) => m.type === 'browser_link_candidate')?.url).toBe(
    'https://example.invalid/new-pty',
  );
}, 15000);

test('64 GLOBAL pairs freeze unknown-pair admission for the actual connection until close', async () => {
  const f = await fixture();
  const peers = [];
  for (let i = 0; i < 64; i++) {
    const peer = await f.client();
    peers.push(peer);
    expect((await peer.submit(peer.request(1))).outcome).toBe('selected');
  }
  const frozen = await f.client();
  const pending = frozen.request(1);
  const full = await frozen.submit(pending);
  expect(full.outcome === 'refused' && full.code).toBe('capacity');
  const first = peers[0];
  if (!first) throw new Error('owned peer absent');
  first.ws.close();
  await until(() => !first.connection(), 'actual pair close');
  const still = await frozen.submit(pending);
  expect(still.outcome === 'refused' && still.code).toBe('capacity');
  const existing = peers[1];
  if (!existing) throw new Error('owned peer absent');
  expect((await existing.submit(existing.request(2))).outcome).toBe('selected');
  const fresh = await f.client();
  expect((await fresh.submit(fresh.request(1))).outcome).toBe('selected');
}, 30000);

test('a frozen concrete connection can still use its existing pair after real session transitions', async () => {
  const f = await fixture();
  const a = await f.client();
  await a.submit(a.request(1));
  for (let i = 1; i < 64; i++) {
    const peer = await f.client();
    await peer.submit(peer.request(1));
  }
  const oldSession = f.sessionId;
  await f.switchSession();
  const blocked = await a.submit(a.request(1));
  expect(blocked.outcome === 'refused' && blocked.code).toBe('capacity');
  await f.switchSession(oldSession);
  expect((await a.submit(a.request(2))).outcome).toBe('selected');
}, 30000);

test('controlled scalar boundary: actual admitted pair reaches max without wrapping or replay', async () => {
  const f = await fixture();
  const a = await f.client();
  await a.submit(a.request(1));
  // Lead-approved scalar setup, not a claim of naturally executing four billion requests.
  // Connection, grant, registry, PTY, producer and wire path remain actual owned components.
  const admitted = Reflect.get(f.service, 'connections') as Map<
    string,
    {
      pairs: Map<string, { highWater: number }>;
    }
  >;
  const pair = admitted.get(a.id)?.pairs.get(f.sessionId);
  if (!pair) throw new Error('Actual admitted browser pair absent');
  pair.highWater = 0xfffffffe;
  const last = a.request(0xffffffff);
  const selected = await a.submit(last);
  expect(selected.outcome).toBe('selected');
  expect(pair.highWater).toBe(0xffffffff);
  expect(await a.submit(last)).toEqual(selected);
  const collision = await a.submit(a.request(0xffffffff));
  expect(collision.outcome === 'refused' && collision.code).toBe('conflict');
  const wrap = { ...a.request(1), seq: 0 };
  a.ws.send(JSON.stringify(wrap));
  await until(() => a.ws.readyState === WebSocket.CLOSED, 'strict zero sequence refusal');
  expect(f.service.offer(f.context(), 'https://example.invalid/no-wrap')).toBe(false);
}, 15000);

test('rolling clock: ten offers, no recipient/rate reset, actual60s expiry and zero host fetch', async () => {
  const f = await fixture();
  const a = await f.client();
  await a.submit(a.request(1));
  let fetched = 0;
  const endpoint = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      fetched++;
      return new Response('owned');
    },
  });
  try {
    const url = `http://127.0.0.1:${endpoint.port}/owned?no=fetch`;
    const began = performance.now();
    for (let i = 0; i < 10; i++) {
      f.service.offer(f.context(), url);
      await Bun.sleep(5);
    }
    expect(f.service.offer(f.context(), url)).toBe(false);
    await a.submit(a.request(2, 'release'));
    await a.submit(a.request(3));
    expect(f.service.offer(f.context(), url)).toBe(false);
    expect(f.service.offer(f.context(), 'file:///owned')).toBe(false);
    await Bun.sleep(Math.max(0, 60030 - (performance.now() - began)));
    expect(f.service.offer(f.context(), url)).toBe(true);
    expect(fetched).toBe(0);
  } finally {
    endpoint.stop(true);
  }
}, 65000);
