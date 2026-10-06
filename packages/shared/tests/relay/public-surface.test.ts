/**
 * Pins the public `relayV2` surface (ADR 0034 section 12).
 *
 * The list below is the whole of what a daemon, a Worker or a client can call.
 * A helper that builds a transcript, derives a key, frames bytes, builds a
 * handshake signing input or constructs a channel from raw keys is not on it, because a
 * later phase could call such a helper and skip the step machine. Adding a name
 * to the public surface means adding it here on purpose.
 */

import { describe, expect, test } from 'bun:test';
import * as shared from '../../src/index.ts';
import * as internal from '../../src/relay/internal.ts';

const PUBLIC_FUNCTIONS = [
  'RelayError',
  'admitTag',
  'admitTagHash',
  'admitTagMatches',
  'asRelayError',
  'b64u',
  'buildNativeAnswerBody',
  'buildNativeAnswerSigningInput',
  'buildPushContentSigningInput',
  'buildPushPayload',
  'buildPushSubmitSigningInput',
  'clientStart',
  'createPairingOffer',
  'ctEqual',
  'decodeAdmit',
  'decodeHostCommand',
  'decodeNativeAnswer',
  'decodeNotice',
  'decodePairingToken',
  'decodePushSubmit',
  'decodePushSubmitResult',
  'decodeSignedPushContent',
  'encodeAdmit',
  'encodeHostCommand',
  'encodeNativeAnswer',
  'encodeNotice',
  'encodePairingToken',
  'encodePushSubmit',
  'encodePushSubmitResult',
  'encodeSignedPushContent',
  'fingerprintOf',
  'fromB64u',
  'generateEcPair',
  'generateIdentity',
  'hostOnHello',
  'isLiveOffer',
  'isSmallOrderPublicKey',
  'liveOffers',
  'nativeAnswerDigest',
  'openPushContent',
  'openSeal',
  'parsePushPayload',
  'parseWorkerPath',
  'pushAad',
  'pushClassOf',
  'ridOf',
  'seal',
  'sealPushContent',
  'signAdmission',
  'signerFromKey',
  'systemRandom',
  'verifyAdmission',
  'verifyNativeAnswer',
  'verifyPushSubmit',
  'verifySignature',
];

/** Helpers that must stay out of the public surface, each for a stated reason. */
const INTERNAL_ONLY = [
  'transcriptH1', // builds the signed transcript
  'transcriptH2',
  'hostSigningInput', // builds a signing input
  'clientSigningInput',
  'admissionInput',
  'deriveSessionKeys', // derives session keys
  'hkdf',
  'ecdh',
  'sha256',
  'hmacSha256',
  'aeadKey', // seals and opens frames outside a channel
  'aeadSeal',
  'aeadOpen',
  'frameAad',
  'frameNonce',
  'encodeHello', // frames bytes outside the steps
  'decodeHello',
  'encodeHelloAck',
  'decodeHelloAck',
  'encodeSealedControl',
  'decodeSealedControl',
  'encodeDataFrame',
  'decodeDataFrame',
  'Channel', // a channel can be built from raw keys
  'lps', // length-prefix helper
  'ecPairFromScalar', // deterministic key construction is for tests only
  'ecGenerate',
  'signerFromSeed',
  'importEcPublic',
];

describe('public relayV2 surface', () => {
  test('exports exactly the pinned functions and classes', () => {
    const functions = Object.entries(shared.relayV2)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(PUBLIC_FUNCTIONS);
  });

  test('every non-function export is a constant of the protocol, not a helper', () => {
    const others = Object.entries(shared.relayV2).filter(
      ([, value]) => typeof value !== 'function',
    );
    for (const [name, value] of others) {
      // Constants are SCREAMING_CASE numbers, strings or frozen plain data.
      expect([name, /^[A-Z][A-Z0-9_]*$/.test(name)]).toEqual([name, true]);
      expect(['number', 'string', 'object']).toContain(typeof value);
    }
  });

  test('no low-level helper is public, and each one still exists internally', () => {
    for (const name of INTERNAL_ONLY) {
      expect([name, name in shared.relayV2]).toEqual([name, false]);
      expect([name, name in internal]).toEqual([name, true]);
    }
  });

  test('the package root does not leak v2 names next to the v1 exports', () => {
    for (const name of ['clientStart', 'hostOnHello', 'seal', 'openSeal', 'RelayError', 'V']) {
      expect([name, name in shared]).toEqual([name, false]);
    }
    expect('encryptRelayPayload' in shared).toBe(false);
    expect(typeof shared.kexSigningInput).toBe('function');
  });
});
