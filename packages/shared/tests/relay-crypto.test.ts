/** Existing direct-auth signing input coverage retained after v1 relay retirement. */
import { describe, expect, test } from 'bun:test';
import {
  exportKeyPair,
  generateChallenge,
  generateKeyPair,
  importPublicKey,
  sign,
  toBase64,
  verify,
} from '../src/crypto.ts';
import { kexSigningInput } from '../src/relay-crypto.ts';
async function ephemeral() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  return { publicKeyBase64: toBase64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}
describe('key exchange signing input', () => {
  test('binds context, challenge and both keys', async () => {
    const input = kexSigningInput('chal', 'daemonpub', 'clientpub');
    const text = new TextDecoder().decode(input);
    expect(text).toContain('remi-relay-kex-v1');
    expect(text).toContain('chal');
    expect(text).toContain('daemonpub');
    expect(text).toContain('clientpub');
  });

  test('length prefixes stop one field bleeding into the next', async () => {
    // Without prefixes, ("ab","c") and ("a","bc") would produce identical
    // bytes, letting a signature be replayed across a different split.
    const a = new TextDecoder().decode(kexSigningInput('ab', 'c', 'd'));
    const b = new TextDecoder().decode(kexSigningInput('a', 'bc', 'd'));
    expect(a).not.toBe(b);
  });

  test('the daemon stage and the client stage sign different bytes', async () => {
    // The daemon signs after it knows both keys; the client signs before it
    // knows the daemon has replied. Identical inputs would let one signature
    // be replayed as the other.
    const first = new TextDecoder().decode(kexSigningInput('chal', 'dpub', null));
    const second = new TextDecoder().decode(kexSigningInput('chal', 'dpub', 'cpub'));
    expect(first).not.toBe(second);
  });

  test('a real Ed25519 identity signs and verifies over it', async () => {
    // Proves the exchange can actually be authenticated with the identity keys
    // the daemon already holds, which is what makes the DH more than passive
    // protection.
    const identity = await generateKeyPair();
    const exported = await exportKeyPair(identity);
    const eph = await ephemeral();
    const challenge = generateChallenge();

    const input = kexSigningInput(challenge, eph.publicKeyBase64, null);
    const signature = await sign(identity.privateKey, input);

    const publicKey = await importPublicKey(exported.publicKeyRaw);
    expect(await verify(publicKey, input, signature)).toBe(true);

    // A substituted ephemeral key, which is exactly what a malicious worker
    // would attempt, no longer verifies.
    const attacker = await ephemeral();
    const forged = kexSigningInput(challenge, attacker.publicKeyBase64, null);
    expect(await verify(publicKey, forged, signature)).toBe(false);
  });
});
