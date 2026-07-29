/**
 * Relay end-to-end encryption tests (#543).
 *
 * These run the real WebCrypto primitives against each other, two independent
 * key exchanges standing in for the two peers. Nothing is mocked: a mocked
 * cipher would prove nothing about whether the worker can read the traffic.
 */

import { describe, expect, test } from 'bun:test';
import {
  exportKeyPair,
  generateChallenge,
  generateKeyPair,
  importPublicKey,
  sign,
  verify,
} from '../src/crypto.ts';
import {
  decryptRelayPayload,
  deriveRelaySessionKeys,
  encryptRelayPayload,
  generateEphemeralKeyPair,
  kexSigningInput,
} from '../src/relay-crypto.ts';

/** Run the exchange both peers would, returning each side's keys. */
async function establish(challenge = generateChallenge()) {
  const daemonEph = await generateEphemeralKeyPair();
  const clientEph = await generateEphemeralKeyPair();
  const daemon = await deriveRelaySessionKeys(
    daemonEph.privateKey,
    clientEph.publicKeyBase64,
    challenge,
    true,
  );
  const client = await deriveRelaySessionKeys(
    clientEph.privateKey,
    daemonEph.publicKeyBase64,
    challenge,
    false,
  );
  return { daemon, client, daemonEph, clientEph, challenge };
}

describe('relay key exchange', () => {
  test('both peers reach the same pair of directional keys', async () => {
    const { daemon, client } = await establish();

    const toClient = await encryptRelayPayload(daemon.send, 'from the daemon');
    expect(await decryptRelayPayload(client.receive, toClient)).toBe('from the daemon');

    const toDaemon = await encryptRelayPayload(client.send, 'from the client');
    expect(await decryptRelayPayload(daemon.receive, toDaemon)).toBe('from the client');
  });

  test('the two directions use different keys', async () => {
    // Sharing one key would let both ends pick the same nonce, which loses
    // AES-GCM its guarantees entirely.
    const { daemon, client } = await establish();
    const fromDaemon = await encryptRelayPayload(daemon.send, 'secret');
    await expect(decryptRelayPayload(daemon.receive, fromDaemon)).rejects.toThrow();
    await expect(decryptRelayPayload(client.send, fromDaemon)).rejects.toThrow();
  });

  test('a different challenge yields different keys from the same ECDH pair', async () => {
    // The challenge is the HKDF salt, so one connection's keys cannot decrypt
    // another's even if the ephemeral keys somehow repeated.
    const daemonEph = await generateEphemeralKeyPair();
    const clientEph = await generateEphemeralKeyPair();
    const first = await deriveRelaySessionKeys(
      daemonEph.privateKey,
      clientEph.publicKeyBase64,
      'challenge-one',
      true,
    );
    const second = await deriveRelaySessionKeys(
      clientEph.privateKey,
      daemonEph.publicKeyBase64,
      'challenge-two',
      false,
    );
    const sealed = await encryptRelayPayload(first.send, 'secret');
    await expect(decryptRelayPayload(second.receive, sealed)).rejects.toThrow();
  });

  test('a stranger who saw both public keys still cannot read the traffic', async () => {
    // This is the worker's exact position: it forwards both public keys and
    // therefore knows them, and that is not enough.
    const { daemon, daemonEph, clientEph, challenge } = await establish();
    const eavesdropper = await generateEphemeralKeyPair();

    const sealed = await encryptRelayPayload(daemon.send, 'user_input: rm -rf /');

    for (const peerPublic of [daemonEph.publicKeyBase64, clientEph.publicKeyBase64]) {
      const guess = await deriveRelaySessionKeys(
        eavesdropper.privateKey,
        peerPublic,
        challenge,
        false,
      );
      await expect(decryptRelayPayload(guess.receive, sealed)).rejects.toThrow();
      await expect(decryptRelayPayload(guess.send, sealed)).rejects.toThrow();
    }
  });
});

describe('relay payload encryption', () => {
  test('round-trips a realistic protocol message', async () => {
    const { daemon, client } = await establish();
    const message = JSON.stringify({
      type: 'user_input',
      sessionId: '0199f3a1-0000-7000-8000-000000000000',
      content: 'deploy to production',
    });
    expect(
      await decryptRelayPayload(client.receive, await encryptRelayPayload(daemon.send, message)),
    ).toBe(message);
  });

  test('the same plaintext encrypts differently every time', async () => {
    // A fresh nonce per message: identical envelopes would leak repetition to
    // anyone watching the relay.
    const { daemon } = await establish();
    const a = await encryptRelayPayload(daemon.send, 'y');
    const b = await encryptRelayPayload(daemon.send, 'y');
    expect(a).not.toBe(b);
  });

  test('tampering is rejected, not silently accepted', async () => {
    const { daemon, client } = await establish();
    const sealed = await encryptRelayPayload(daemon.send, 'approve');
    // Flip a bit in the ciphertext body, past the 12-byte nonce.
    const bytes = new Uint8Array(Buffer.from(sealed, 'base64'));
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    const tampered = Buffer.from(bytes).toString('base64');
    await expect(decryptRelayPayload(client.receive, tampered)).rejects.toThrow();
  });

  test('a truncated envelope is rejected with a clear error', async () => {
    const { client } = await establish();
    await expect(decryptRelayPayload(client.receive, '')).rejects.toThrow(/too short/);
    await expect(
      decryptRelayPayload(client.receive, Buffer.from(new Uint8Array(8)).toString('base64')),
    ).rejects.toThrow(/too short/);
  });

  test('handles unicode and large payloads', async () => {
    const { daemon, client } = await establish();
    const big = `${'café ☕ '.repeat(5000)}end`;
    expect(
      await decryptRelayPayload(client.receive, await encryptRelayPayload(daemon.send, big)),
    ).toBe(big);
  });
});

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
    const eph = await generateEphemeralKeyPair();
    const challenge = generateChallenge();

    const input = kexSigningInput(challenge, eph.publicKeyBase64, null);
    const signature = await sign(identity.privateKey, input);

    const publicKey = await importPublicKey(exported.publicKeyRaw);
    expect(await verify(publicKey, input, signature)).toBe(true);

    // A substituted ephemeral key, which is exactly what a malicious worker
    // would attempt, no longer verifies.
    const attacker = await generateEphemeralKeyPair();
    const forged = kexSigningInput(challenge, attacker.publicKeyBase64, null);
    expect(await verify(publicKey, forged, signature)).toBe(false);
  });
});
