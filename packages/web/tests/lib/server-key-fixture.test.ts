/** Checks the actual shared validator against the public-only Swift fixture. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fingerprint, fromBase64, isSmallOrderPublicKey } from '@remi/shared';

test('Swift fixture matches the single reviewed shared small-order key table', async () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../shared/src/ed25519-public-key.ts'),
    'utf8',
  );
  const reviewed = [...source.matchAll(/'([0-9a-f]{64})'/g)].map((match) => match[1] ?? '').sort();
  const fixture: { publicKey: string; fingerprint: string; smallOrder: boolean }[] = JSON.parse(
    readFileSync(
      resolve(import.meta.dir, '../../../macos/RemiTests/fixtures/ed25519-server-keys.json'),
      'utf8',
    ),
  );
  expect(
    fixture
      .filter((item) => item.smallOrder)
      .map((item) => Buffer.from(fromBase64(item.publicKey)).toString('hex'))
      .sort(),
  ).toEqual(reviewed);
  for (const item of fixture) {
    expect(Object.keys(item).sort()).toEqual(['fingerprint', 'publicKey', 'smallOrder']);
    expect(await fingerprint(fromBase64(item.publicKey))).toBe(item.fingerprint);
    expect(isSmallOrderPublicKey(new Uint8Array(fromBase64(item.publicKey)))).toBe(item.smallOrder);
  }
});
