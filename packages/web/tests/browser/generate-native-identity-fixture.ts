/** Disposable actual shared-engine private fixtures for native RFC8410 conformance.
 * Never run against a persisted identity or write user key material here.
 */
import { writeFile } from 'node:fs/promises';
import { createIdentity, fromBase64, sign, toBase64, unlockIdentity } from '@remi/shared';

const cases = await Promise.all(
  Array.from({ length: 2 }, async () => {
    const stored = await createIdentity();
    const unlocked = await unlockIdentity(stored);
    const message = crypto.getRandomValues(new Uint8Array(32));
    return {
      pkcs8: stored.encryptedPrivateKey,
      publicKey: stored.publicKey,
      fingerprint: stored.fingerprint,
      message: toBase64(message.buffer),
      signature: await sign(unlocked.privateKey, message.buffer),
      // Assert the fixture is the engine-exported Ed25519 RFC8410 shape.
      pkcs8Length: fromBase64(stored.encryptedPrivateKey).byteLength,
    };
  }),
);
await writeFile(
  new URL('../../../macos/RemiTests/fixtures/native-identity-pkcs8.json', import.meta.url),
  `${JSON.stringify(cases, null, 2)}\n`,
);
