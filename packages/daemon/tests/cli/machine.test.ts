import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relayV2 } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { defaultMachineName, machineIdForKey } from '../../src/cli/machine.ts';

test('machine identity reuses the room ID and persists per home; separate homes and rotation differ', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remi-machine-id-'));
  try {
    const store = new IdentityStore(join(root, 'first'));
    await store.generate();
    const original = await store.unlock();
    const key = new Uint8Array(Buffer.from(original.publicKeyRaw, 'base64'));
    const id = await machineIdForKey(key);
    expect(id).toBe(Buffer.from(await relayV2.ridOf(key)).toString('hex'));
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    const reloaded = await new IdentityStore(join(root, 'first')).unlock();
    expect(
      await machineIdForKey(new Uint8Array(Buffer.from(reloaded.publicKeyRaw, 'base64'))),
    ).toBe(id);
    const other = new IdentityStore(join(root, 'second'));
    await other.generate();
    expect(
      await machineIdForKey(
        new Uint8Array(Buffer.from((await other.unlock()).publicKeyRaw, 'base64')),
      ),
    ).not.toBe(id);
    await store.generate();
    expect(
      await machineIdForKey(
        new Uint8Array(Buffer.from((await store.unlock()).publicKeyRaw, 'base64')),
      ),
    ).not.toBe(id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pairing and wire names are plain short names, bounded by whole Unicode scalars', () => {
  expect(defaultMachineName('Maryam’s Mac.local')).toBe('Maryams Mac');
  expect(defaultMachineName('\u001b\u202e\u200d')).toBe('remi');
  const name = defaultMachineName('𐐀'.repeat(80));
  expect(Array.from(name)).toHaveLength(64);
  expect(name).toBe('𐐀'.repeat(64));
});
