/** Regenerate public-only Swift conformance cases from the SINGLE reviewed TS validator. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createIdentity, fingerprint, fromBase64, isSmallOrderPublicKey } from '@remi/shared';

const source = readFileSync(resolve(import.meta.dir, '../../../shared/src/ed25519-public-key.ts'), 'utf8');
const hexKeys = [...source.matchAll(/'([0-9a-f]{64})'/g)].map((match) => match[1] ?? '');
if (hexKeys.length !== 14) throw new Error('Reviewed validator must contain all14encodings');
const cases = [];
for (const hex of hexKeys) {
  const publicKey = Buffer.from(hex, 'hex').toString('base64');
  cases.push({ publicKey, fingerprint: await fingerprint(fromBase64(publicKey)), smallOrder: isSmallOrderPublicKey(new Uint8Array(fromBase64(publicKey))) });
}
for (let index = 0; index < 2; index++) {
  const identity = await createIdentity();
  cases.push({ publicKey: identity.publicKey, fingerprint: identity.fingerprint, smallOrder: isSmallOrderPublicKey(new Uint8Array(fromBase64(identity.publicKey))) });
}
writeFileSync(resolve(import.meta.dir, '../../../macos/RemiTests/fixtures/ed25519-server-keys.json'), `${JSON.stringify(cases, null, 2)}\n`);
