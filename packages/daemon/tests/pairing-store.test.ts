/**
 * Pairing records (#1275, ADR 0037): what `remi pair` makes and a phone's first connection claims.
 * Real Ed25519 identities and real, isolated stores; a worker process for the cross-process race.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIdentity, isPairingNonce } from '@remi/shared';
import { IdentityStore, PairingLimitError } from '../src/auth/identity-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(start = 1_760_000_000_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-pairing-'));
  dirs.push(dir);
  const clock = { now: start };
  const store = new IdentityStore(dir, { now: () => clock.now });
  return { dir, store, clock };
}

describe('pairing records (#1275)', () => {
  test('a new record is open for five minutes, and the file holds a hash, not the nonce', async () => {
    const { dir, store, clock } = setup();
    const { nonce, record } = store.createPairing();
    expect(isPairingNonce(nonce)).toBe(true);
    expect(record.state).toBe('open');
    expect(record.claim).toBeNull();
    expect(Date.parse(record.expiresAt) - clock.now).toBe(300_000);
    const file = path.join(dir, 'pairings.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain(nonce);
    expect(store.readPairing(nonce)?.state).toBe('open');
  });

  test('the first key claims it and becomes pending; the same key again is the same claim; another key is refused', async () => {
    const { store } = setup();
    const a = await createIdentity();
    const b = await createIdentity();
    const { nonce } = store.createPairing();
    expect(await store.claimPairing(nonce, a.publicKey, 'Sam phone')).toBe('CLAIMED');
    expect(await store.claimPairing(nonce, a.publicKey, 'Sam phone')).toBe('CLAIMED');
    expect(store.listPendingKeys().map((k) => k.fingerprint)).toEqual([a.fingerprint]);
    const record = store.readPairing(nonce);
    expect(record?.state).toBe('claimed');
    expect(record?.claim).toMatchObject({ fingerprint: a.fingerprint, label: 'Sam phone' });
    expect(await store.claimPairing(nonce, b.publicKey, 'other')).toBe('PAIRING_USED');
    expect(store.listPendingKeys().map((k) => k.fingerprint)).toEqual([a.fingerprint]);
  });

  test('a nonce the machine never made is unknown, and registers nothing', async () => {
    const { store } = setup();
    const a = await createIdentity();
    store.createPairing();
    expect(await store.claimPairing('AAAAAAAAAAAAAAAAAAAAAA', a.publicKey, 'x')).toBe(
      'PAIRING_UNKNOWN',
    );
    expect(store.listPendingKeys()).toHaveLength(0);
  });

  test('an expired code is refused as expired, and registers nothing', async () => {
    const { store, clock } = setup();
    const a = await createIdentity();
    const { nonce } = store.createPairing();
    clock.now += 300_001;
    expect(await store.claimPairing(nonce, a.publicKey, 'x')).toBe('PAIRING_EXPIRED');
    expect(store.listPendingKeys()).toHaveLength(0);
  });

  test('a cancelled code is refused for anyone; a key that had claimed it stays an ordinary pending key', async () => {
    const { store } = setup();
    const a = await createIdentity();
    const b = await createIdentity();
    const { nonce } = store.createPairing();
    expect(await store.claimPairing(nonce, a.publicKey, 'x')).toBe('CLAIMED');
    expect(store.cancelPairing(nonce)).toBe(true);
    expect(await store.claimPairing(nonce, a.publicKey, 'x')).toBe('PAIRING_CANCELLED');
    expect(await store.claimPairing(nonce, b.publicKey, 'x')).toBe('PAIRING_CANCELLED');
    expect(store.listPendingKeys().map((k) => k.fingerprint)).toEqual([a.fingerprint]);
  });

  test('a rejected claim removes the pending key; the same key is told it was rejected, another that it is used', async () => {
    const { store } = setup();
    const a = await createIdentity();
    const b = await createIdentity();
    const { nonce } = store.createPairing();
    await store.claimPairing(nonce, a.publicKey, 'x');
    expect(store.rejectPairing(nonce)).toBe(true);
    expect(store.listPendingKeys()).toHaveLength(0);
    expect(store.readPairing(nonce)?.state).toBe('rejected');
    expect(await store.claimPairing(nonce, a.publicKey, 'x')).toBe('PAIRING_REJECTED');
    expect(await store.claimPairing(nonce, b.publicKey, 'x')).toBe('PAIRING_USED');
    expect(store.listPendingKeys()).toHaveLength(0);
  });

  test('approval authorizes the claiming key with its label, through the one approval path', async () => {
    const { store } = setup();
    const a = await createIdentity();
    const { nonce } = store.createPairing();
    await expect(store.approvePairing(nonce, a.fingerprint)).rejects.toThrow();
    await store.claimPairing(nonce, a.publicKey, 'Sam phone');
    const grant = await store.approvePairing(nonce, a.fingerprint);
    expect(grant).toMatchObject({ fingerprint: a.fingerprint, label: 'Sam phone' });
    expect(store.isAuthorized(a.publicKey, a.fingerprint)).toBe(true);
    expect(store.listPendingKeys()).toHaveLength(0);
    expect(store.readPairing(nonce)?.state).toBe('approved');
    await expect(store.approvePairing(nonce, a.fingerprint)).rejects.toThrow();
    expect(store.rejectPairing(nonce)).toBe(false);
  });

  test('a claim stays approvable after the code itself expires, while its pending key lives', async () => {
    const { store, clock } = setup();
    const a = await createIdentity();
    const { nonce } = store.createPairing();
    await store.claimPairing(nonce, a.publicKey, 'x');
    clock.now += 300_001;
    await store.approvePairing(nonce, a.fingerprint);
    expect(store.isAuthorized(a.publicKey, a.fingerprint)).toBe(true);
  });

  test('at most four codes are open at once; expired ones do not count', () => {
    const { store, clock } = setup();
    for (let i = 0; i < 4; i++) store.createPairing();
    expect(() => store.createPairing()).toThrow(PairingLimitError);
    clock.now += 300_001;
    for (let i = 0; i < 4; i++) store.createPairing();
    expect(() => store.createPairing()).toThrow(PairingLimitError);
  });

  test('ordinary unknown keys fill 28 slots; a pairing claim still gets one of the four kept for it', async () => {
    const { store } = setup();
    for (let i = 0; i < 28; i++) await store.registerPendingKey((await createIdentity()).publicKey);
    await expect(store.registerPendingKey((await createIdentity()).publicKey)).rejects.toThrow(
      'PENDING_QUEUE_FULL',
    );
    const a = await createIdentity();
    const { nonce } = store.createPairing();
    expect(await store.claimPairing(nonce, a.publicKey, 'x')).toBe('CLAIMED');
  });

  test('a queue full even of kept slots refuses the claim, counts it, and leaves the code open', async () => {
    const { store } = setup();
    for (let i = 0; i < 28; i++) await store.registerPendingKey((await createIdentity()).publicKey);
    for (let i = 0; i < 4; i++) {
      await store.registerPendingKey((await createIdentity()).publicKey, { forPairing: true });
    }
    const a = await createIdentity();
    const { nonce } = store.createPairing();
    expect(await store.claimPairing(nonce, a.publicKey, 'x')).toBe('PENDING_QUEUE_FULL');
    const record = store.readPairing(nonce);
    expect(record?.state).toBe('open');
    expect(record?.queueFull).toBe(1);
  });

  test('another key trying a claimed code is counted, and the last one named, for the terminal', async () => {
    const { store } = setup();
    const a = await createIdentity();
    const b = await createIdentity();
    const c = await createIdentity();
    const { nonce } = store.createPairing();
    await store.claimPairing(nonce, a.publicKey, 'x');
    await store.claimPairing(nonce, b.publicKey, 'y');
    await store.claimPairing(nonce, c.publicKey, 'z');
    expect(store.readPairing(nonce)).toMatchObject({
      contested: 2,
      lastContender: c.fingerprint,
      claim: { fingerprint: a.fingerprint },
    });
  });

  test('at the record cap, finished records make room; only live ones count against it', async () => {
    const { store } = setup();
    for (let i = 0; i < 16; i++) store.cancelPairing(store.createPairing().nonce);
    expect(() => store.createPairing()).not.toThrow();
  });

  test('approval approves only the fingerprint the person was shown', async () => {
    const { store } = setup();
    const a = await createIdentity();
    const b = await createIdentity();
    // b is pending too (an ordinary first connection), so its fingerprint names a real candidate.
    await store.registerPendingKey(b.publicKey);
    const { nonce } = store.createPairing();
    await store.claimPairing(nonce, a.publicKey, 'x');
    await expect(store.approvePairing(nonce, '0000000000000000')).rejects.toThrow();
    await expect(store.approvePairing(nonce, b.fingerprint)).rejects.toThrow();
    expect(store.isAuthorized(a.publicKey, a.fingerprint)).toBe(false);
    expect(store.isAuthorized(b.publicKey, b.fingerprint)).toBe(false);
    expect(store.readPairing(nonce)?.state).toBe('claimed');
    await store.approvePairing(nonce, a.fingerprint);
    expect(store.isAuthorized(a.publicKey, a.fingerprint)).toBe(true);
    expect(store.isAuthorized(b.publicKey, b.fingerprint)).toBe(false);
  });

  test('a code cancelled while approval validates the key is not approved', async () => {
    const { store } = setup();
    const a = await createIdentity();
    const { nonce } = store.createPairing();
    await store.claimPairing(nonce, a.publicKey, 'x');
    // approvePairing reads its snapshot, then awaits key validation; the cancel lands in between.
    const approving = store.approvePairing(nonce, a.fingerprint);
    expect(store.cancelPairing(nonce)).toBe(true);
    await expect(approving).rejects.toThrow('changed');
    expect(store.isAuthorized(a.publicKey, a.fingerprint)).toBe(false);
    expect(store.readPairing(nonce)?.state).toBe('cancelled');
  });

  test('a claim whose pending key expired is renewed when the same key presents the code again', async () => {
    const { store, clock } = setup();
    const a = await createIdentity();
    const { nonce } = store.createPairing();
    await store.claimPairing(nonce, a.publicKey, 'x');
    clock.now += 600_001;
    expect(store.listPendingKeys()).toHaveLength(0);
    await expect(store.approvePairing(nonce, a.fingerprint)).rejects.toThrow();
    expect(await store.claimPairing(nonce, a.publicKey, 'x')).toBe('CLAIMED');
    expect(store.listPendingKeys().map((k) => k.fingerprint)).toEqual([a.fingerprint]);
    await store.approvePairing(nonce, a.fingerprint);
    expect(store.isAuthorized(a.publicKey, a.fingerprint)).toBe(true);
  });

  test('a record is kept for ten minutes after its code expires, then dropped', async () => {
    const { store, clock } = setup();
    const { nonce } = store.createPairing();
    store.cancelPairing(nonce);
    clock.now += 300_000 + 600_000 - 1;
    expect(store.readPairing(nonce)?.state).toBe('cancelled');
    clock.now += 1;
    expect(store.readPairing(nonce)).toBeNull();
  });

  test('peekPairing reads without the lock: it answers while another process holds it', async () => {
    const { dir, store } = setup();
    const { nonce } = store.createPairing();
    const worker = path.join(import.meta.dir, 'lock-holder-worker.ts');
    const holder = Bun.spawn([process.execPath, worker, dir, '2500'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    while (!fs.existsSync(path.join(dir, 'lock-held'))) await Bun.sleep(5);
    const started = Date.now();
    expect(store.peekPairing(nonce)?.state).toBe('open');
    expect(Date.now() - started).toBeLessThan(500);
    await holder.exited;
  }, 20000);

  test('a corrupt pairings file fails closed', async () => {
    const { dir, store } = setup();
    const a = await createIdentity();
    const { nonce } = store.createPairing();
    fs.writeFileSync(path.join(dir, 'pairings.json'), '{"version":1,"pairings":[{"nonceHash":7}]}');
    await expect(store.claimPairing(nonce, a.publicKey, 'x')).rejects.toThrow();
    expect(store.listPendingKeys()).toHaveLength(0);
  });

  test('a record with a bad count or contender fails closed, for the lock-free read too', async () => {
    const { dir, store } = setup();
    const { nonce } = store.createPairing();
    const file = path.join(dir, 'pairings.json');
    const valid = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const variants: Record<string, unknown>[] = [
      { contested: -1 },
      { contested: 1.5 },
      { queueFull: '1' },
      { queueFull: null },
      { lastContender: 'not-a-fingerprint' },
      { lastContender: 7 },
      { extra: true },
    ];
    for (const change of variants) {
      const record = { ...valid.pairings[0], ...change };
      fs.writeFileSync(file, JSON.stringify({ version: 1, pairings: [record] }));
      expect(() => store.readPairing(nonce), JSON.stringify(change)).toThrow();
      expect(() => store.peekPairing(nonce), JSON.stringify(change)).toThrow();
    }
    const { contested: _, ...missing } = valid.pairings[0];
    fs.writeFileSync(file, JSON.stringify({ version: 1, pairings: [missing] }));
    expect(() => store.peekPairing(nonce)).toThrow();
  });

  for (const other of ['reject', 'cancel'] as const) {
    test(`approval and ${other} in two processes at once: one decision, consistent, every round`, async () => {
      const worker = path.join(import.meta.dir, 'pairing-decision-worker.ts');
      for (let round = 0; round < 5; round++) {
        const { dir } = setup(Date.now());
        const store = new IdentityStore(dir);
        const a = await createIdentity();
        const { nonce } = store.createPairing();
        await store.claimPairing(nonce, a.publicKey, 'x');
        fs.writeFileSync(
          path.join(dir, 'race.json'),
          JSON.stringify({ nonce, fingerprint: a.fingerprint }),
        );
        const actions = ['approve', other];
        const procs = actions.map((action) =>
          Bun.spawn([process.execPath, worker, dir, action], { stdout: 'pipe', stderr: 'pipe' }),
        );
        while (!actions.every((action) => fs.existsSync(path.join(dir, `ready-${action}`))))
          await Bun.sleep(5);
        fs.writeFileSync(path.join(dir, 'go'), '');
        const [approve, decided] = await Promise.all(
          procs.map(async (p) => {
            await p.exited;
            return (await new Response(p.stdout).text()).trim();
          }),
        );
        const after = new IdentityStore(dir);
        const authorized = after.isAuthorized(a.publicKey, a.fingerprint);
        const state = after.readPairing(nonce)?.state;
        const label = `round ${round}: approve ${approve}, ${other} ${decided}, ${state}`;
        if (authorized) {
          expect([approve, decided, state], label).toEqual(['done', 'refused', 'approved']);
        } else {
          const expected = other === 'reject' ? 'rejected' : 'cancelled';
          expect([approve, decided, state], label).toEqual(['refused', 'done', expected]);
          // A rejection removes the pending key; a cancel leaves it pending, as an ordinary key.
          expect(after.listPendingKeys(), label).toHaveLength(other === 'reject' ? 0 : 1);
        }
      }
    }, 60000);
  }

  test('two processes claiming one code at once: exactly one wins, every round', async () => {
    const worker = path.join(import.meta.dir, 'pairing-store-worker.ts');
    for (let round = 0; round < 5; round++) {
      const { dir } = setup();
      const store = new IdentityStore(dir);
      const { nonce } = store.createPairing();
      const keys = [(await createIdentity()).publicKey, (await createIdentity()).publicKey];
      fs.writeFileSync(path.join(dir, 'race.json'), JSON.stringify({ nonce, keys }));
      const procs = [0, 1].map((i) =>
        Bun.spawn([process.execPath, worker, dir, String(i)], { stdout: 'pipe', stderr: 'pipe' }),
      );
      while (![0, 1].every((i) => fs.existsSync(path.join(dir, `ready-${i}`)))) await Bun.sleep(5);
      fs.writeFileSync(path.join(dir, 'go'), '');
      const outcomes = await Promise.all(
        procs.map(async (p) => {
          await p.exited;
          return (await new Response(p.stdout).text()).trim();
        }),
      );
      expect(outcomes.sort(), `round ${round}`).toEqual(['CLAIMED', 'PAIRING_USED']);
      expect(new IdentityStore(dir).listPendingKeys(), `round ${round}`).toHaveLength(1);
    }
  }, 60000);
});
