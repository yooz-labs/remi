/**
 * Sealed lock-screen answer tests (#875).
 *
 * Real WebCrypto on both sides. The assertions that matter are about what the
 * Worker would see, since the Worker is the party this seals against.
 */

import { describe, expect, test } from 'bun:test';
import {
  generateAnswerKeyPair,
  isSealedAnswer,
  openSealedAnswer,
  sealAnswer,
} from '../src/sealed-answer.ts';

const BODY = {
  sessionId: '0199f3a1-0000-7000-8000-000000000001',
  questionId: '0199f3a1-0000-7000-8000-000000000002',
  answer: 'yes, deploy to production',
};

describe('sealed answers', () => {
  test('the daemon opens what the phone sealed', async () => {
    const daemon = await generateAnswerKeyPair();
    const envelope = await sealAnswer(daemon.publicKeyBase64, BODY);
    expect(await openSealedAnswer(daemon.privateKeyPkcs8Base64, envelope)).toEqual(BODY);
  });

  test('the Worker sees no answer text and no session identifiers', async () => {
    // The Worker's entire view of the request body.
    const daemon = await generateAnswerKeyPair();
    const envelope = await sealAnswer(daemon.publicKeyBase64, BODY);
    const onTheWire = JSON.stringify(envelope);

    expect(onTheWire).not.toContain(BODY.answer);
    expect(onTheWire).not.toContain(BODY.sessionId);
    expect(onTheWire).not.toContain(BODY.questionId);
    expect(onTheWire).not.toContain('answer');
  });

  test('another daemon cannot open it', async () => {
    const daemon = await generateAnswerKeyPair();
    const other = await generateAnswerKeyPair();
    const envelope = await sealAnswer(daemon.publicKeyBase64, BODY);
    await expect(openSealedAnswer(other.privateKeyPkcs8Base64, envelope)).rejects.toThrow();
  });

  test('the ephemeral key alone does not open it', async () => {
    // The Worker holds exactly this: the envelope, including the sender's
    // public key. It must not be enough.
    const daemon = await generateAnswerKeyPair();
    const envelope = await sealAnswer(daemon.publicKeyBase64, BODY);
    const attacker = await generateAnswerKeyPair();
    await expect(
      openSealedAnswer(attacker.privateKeyPkcs8Base64, {
        ephemeralPublicKey: envelope.ephemeralPublicKey,
        sealed: envelope.sealed,
      }),
    ).rejects.toThrow();
  });

  test('the same answer seals differently every time', async () => {
    // A fresh ephemeral key per answer: identical envelopes would tell the
    // Worker you answered the same way twice.
    const daemon = await generateAnswerKeyPair();
    const a = await sealAnswer(daemon.publicKeyBase64, BODY);
    const b = await sealAnswer(daemon.publicKeyBase64, BODY);
    expect(a.sealed).not.toBe(b.sealed);
    expect(a.ephemeralPublicKey).not.toBe(b.ephemeralPublicKey);
  });

  test('tampering is rejected rather than yielding a different answer', async () => {
    // The dangerous failure would be a flipped bit turning "no" into something
    // the daemon acts on. AES-GCM authenticates, so it cannot.
    const daemon = await generateAnswerKeyPair();
    const envelope = await sealAnswer(daemon.publicKeyBase64, BODY);
    const bytes = new Uint8Array(Buffer.from(envelope.sealed, 'base64'));
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    await expect(
      openSealedAnswer(daemon.privateKeyPkcs8Base64, {
        ephemeralPublicKey: envelope.ephemeralPublicKey,
        sealed: Buffer.from(bytes).toString('base64'),
      }),
    ).rejects.toThrow();
  });

  test('a swapped ephemeral key is rejected', async () => {
    const daemon = await generateAnswerKeyPair();
    const one = await sealAnswer(daemon.publicKeyBase64, BODY);
    const two = await sealAnswer(daemon.publicKeyBase64, BODY);
    await expect(
      openSealedAnswer(daemon.privateKeyPkcs8Base64, {
        ephemeralPublicKey: two.ephemeralPublicKey,
        sealed: one.sealed,
      }),
    ).rejects.toThrow();
  });

  test('a truncated envelope reports what is wrong', async () => {
    const daemon = await generateAnswerKeyPair();
    const envelope = await sealAnswer(daemon.publicKeyBase64, BODY);
    await expect(
      openSealedAnswer(daemon.privateKeyPkcs8Base64, {
        ephemeralPublicKey: envelope.ephemeralPublicKey,
        sealed: Buffer.from(new Uint8Array(8)).toString('base64'),
      }),
    ).rejects.toThrow(/too short/);
  });

  test('unicode answers survive the round trip', async () => {
    const daemon = await generateAnswerKeyPair();
    const body = { ...BODY, answer: 'oui, déployez ☕ 好' };
    const envelope = await sealAnswer(daemon.publicKeyBase64, body);
    expect(await openSealedAnswer(daemon.privateKeyPkcs8Base64, envelope)).toEqual(body);
  });

  test('sealed envelopes are told apart from plaintext bodies', async () => {
    // The daemon uses this to decide which shape arrived, so a plaintext body
    // must never be mistaken for a sealed one.
    const daemon = await generateAnswerKeyPair();
    expect(isSealedAnswer(await sealAnswer(daemon.publicKeyBase64, BODY))).toBe(true);
    expect(isSealedAnswer(BODY)).toBe(false);
    expect(isSealedAnswer(null)).toBe(false);
    expect(isSealedAnswer('sealed')).toBe(false);
    expect(isSealedAnswer({ ephemeralPublicKey: 'x' })).toBe(false);
  });
});
