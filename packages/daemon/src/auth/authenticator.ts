/**
 * Authenticator - Server-side authentication logic.
 *
 * Handles the Ed25519 challenge-response handshake:
 * 1. Generate a random one-time challenge, include server's fingerprint and public key
 * 2. Verify client's Ed25519 signature first (bad signatures never create candidates)
 * 3. Check authorized keys; verified unknown keys request local approval
 * 4. Sign the same challenge with the server's private key (mutual authentication)
 *
 * Each challenge is consumed on first verification attempt (one-time use)
 * to prevent replay attacks.
 */

import type {
  AuthChallengeMessage,
  AuthResponseMessage,
  AuthResultMessage,
  UnlockedIdentity,
} from '@remi/shared';
import {
  PAIRING_NAME_MAX_CODE_POINTS,
  errorToString,
  isPairingNonce,
  isPlainPairingText,
} from '@remi/shared';
import {
  createAuthChallenge,
  createAuthResult,
  fromBase64,
  generateChallenge,
  importPublicKey,
  kexSigningInput,
  sign,
  verify,
} from '@remi/shared';
import {
  DuplicateKeyError,
  type IdentityStore,
  PendingQueueFullError,
  validatePublicKey,
} from './identity-store.ts';

/**
 * Outcome of `verifyResponse` (#671 follow-up). `result` is the wire
 * `AuthResultMessage` to send back to the client, unchanged. `verifiedFingerprint`
 * is set ONLY when `result.success` is true, and is always derived
 * server-side from the Ed25519-verified `clientPublicKey` — never from
 * `response.clientFingerprint`, which is a client-supplied, unverified wire
 * field (documented as "for display" in the protocol type). Binding the
 * unverified claim to a connection's identity would let an attacker who
 * merely owns SOME valid keypair complete authentication while claiming to
 * BE a different (victim) fingerprint, defeating any identity check
 * (e.g. the same-device lock reclaim, #671) keyed off it.
 */
export interface VerifyResponseOutcome {
  readonly result: AuthResultMessage;
  readonly verifiedFingerprint?: string;
}

/** What `verifyResponse` may be told about the connection it answers. */
export interface VerifyResponseOptions {
  /** Whether the connection is still open; a pairing claim stops waiting once it is not. */
  readonly isOpen?: () => boolean;
}

export interface AuthenticatorConfig {
  readonly identity: UnlockedIdentity;
  readonly identityStore: IdentityStore;
  /**
   * How long a pairing claim waiting for the person's decision is held before `PAIRING_PENDING`
   * (#1275, ADR 0037). Twenty seconds unless a test gives less.
   */
  readonly pairingWaitMs?: number;
}

/** How long a waiting pairing claim is held for the person's decision. */
const DEFAULT_PAIRING_WAIT_MS = 20_000;
/** How often a held claim checks for the decision. */
const PAIRING_POLL_MS = 250;
const DEFAULT_PAIRING_LABEL = 'paired device';

/**
 * A label for the terminal and the authorized-keys file: the phone's own choice, so held to the
 * machine name's rule (plain text, 1 to 64 code points). It names the device; it proves nothing.
 */
function pairingLabelOf(label: string | undefined): string | null {
  if (label === undefined) return DEFAULT_PAIRING_LABEL;
  return isPlainPairingText(label, PAIRING_NAME_MAX_CODE_POINTS) ? label : null;
}

export class Authenticator {
  private readonly identity: UnlockedIdentity;
  private readonly store: IdentityStore;
  /** Published in every challenge so phones can pin it (#875). */
  private answerEncryptionKey: string | undefined;
  /** Active challenges keyed by connection ID */
  private readonly pendingChallenges = new Map<string, string>();
  private readonly pairingWaitMs: number;

  constructor(config: AuthenticatorConfig) {
    this.identity = config.identity;
    this.store = config.identityStore;
    this.pairingWaitMs = config.pairingWaitMs ?? DEFAULT_PAIRING_WAIT_MS;
  }

  /**
   * Create an auth challenge for a new connection.
   * @param connectionId Unique connection identifier to track the challenge
   */
  /**
   * Publish the daemon's answer key (#875). Set once at startup; absent means
   * clients must refuse to send a lock-screen answer rather than send plaintext.
   */
  setAnswerEncryptionKey(publicKeyBase64: string): void {
    this.answerEncryptionKey = publicKeyBase64;
  }

  createChallenge(connectionId: string): AuthChallengeMessage {
    const challenge = generateChallenge();
    this.pendingChallenges.set(connectionId, challenge);
    return createAuthChallenge(
      challenge,
      this.identity.fingerprint,
      this.identity.publicKeyRaw,
      undefined,
      this.answerEncryptionKey,
    );
  }

  /**
   * Create an auth challenge that also opens the relay key exchange (#543).
   *
   * Lives here rather than in the relay adapter because signing needs the
   * identity private key, which the Authenticator owns and does not hand out.
   * The signature is what makes the exchange authenticated: the worker relays
   * these fields and can replace them, but cannot produce a signature over a
   * substituted key that the client will accept.
   *
   * Used ONLY by the relay transport. The direct WebSocket path calls
   * `createChallenge` and is unaffected.
   */
  async createChallengeWithRelayKex(
    connectionId: string,
    ephemeralPublicKeyBase64: string,
  ): Promise<AuthChallengeMessage> {
    const challenge = generateChallenge();
    this.pendingChallenges.set(connectionId, challenge);
    const signature = await sign(
      this.identity.privateKey,
      kexSigningInput(challenge, ephemeralPublicKeyBase64, null),
    );
    return createAuthChallenge(
      challenge,
      this.identity.fingerprint,
      this.identity.publicKeyRaw,
      { ephemeralKey: ephemeralPublicKeyBase64, signature },
      this.answerEncryptionKey,
    );
  }

  /**
   * Verify the client's half of the relay key exchange (#543).
   *
   * Separate from `verifyResponse` on purpose: that call proves who the client
   * is, this one proves the ephemeral key came from that same client. Both must
   * pass before any traffic is encrypted, and the caller must treat a false
   * here as fatal to the connection rather than as "encryption unavailable" —
   * silently continuing in plaintext is the exact failure this issue is about.
   *
   * Takes the challenge as an argument rather than reading `pendingChallenges`,
   * because `verifyResponse` consumes that entry. Looking it up here made the
   * result depend on call order, which failed closed but for the wrong reason.
   */
  async verifyRelayKex(
    challenge: string,
    response: AuthResponseMessage,
    daemonEphemeralKeyBase64: string,
  ): Promise<boolean> {
    if (!challenge) return false;
    const { relayEphemeralKey, relayKexSignature } = response;
    if (!relayEphemeralKey || !relayKexSignature) return false;
    try {
      const clientKey = await importPublicKey(fromBase64(response.clientPublicKey));
      return await verify(
        clientKey,
        kexSigningInput(challenge, daemonEphemeralKeyBase64, relayEphemeralKey),
        relayKexSignature,
      );
    } catch {
      // A malformed key or signature is a failed verification, not a crash.
      return false;
    }
  }

  /**
   * Verify a client's auth response.
   * Returns a `VerifyResponseOutcome`: the wire `AuthResultMessage` plus,
   * on success, the server-derived `verifiedFingerprint`.
   *
   * Order: verify signature and derived fingerprint, then check authorization,
   * then persist an untrusted pending candidate if the key is unknown.
   *
   * `response.clientFingerprint` is never an identity authority (#671/#873):
   * mismatched display claims are rejected, and Ed25519
   * signature verification only proves possession of `clientPublicKey`, not
   * that the claimed fingerprint actually hashes from that key. Every
   * identity-bearing check here (authorized-keys lookup, pending registration, lastUsedAt,
   * and the fingerprint returned to the caller) uses `derivedFingerprint`,
   * computed server-side from the verified public key.
   */
  async verifyResponse(
    connectionId: string,
    response: AuthResponseMessage,
    options: VerifyResponseOptions = {},
  ): Promise<VerifyResponseOutcome> {
    const challenge = this.pendingChallenges.get(connectionId);
    if (!challenge) {
      return { result: createAuthResult(false, undefined, 'NO_PENDING_CHALLENGE') };
    }

    // Remove challenge (one-time use)
    this.pendingChallenges.delete(connectionId);

    // Step 1: Verify the signature FIRST (before checking authorization)
    let derivedFingerprint: string;
    try {
      derivedFingerprint = await validatePublicKey(response.clientPublicKey);
      const clientPublicKeyRaw = fromBase64(response.clientPublicKey);
      const clientPublicKey = await importPublicKey(clientPublicKeyRaw);
      const challengeData = fromBase64(challenge);
      const valid = await verify(clientPublicKey, challengeData, response.signature);

      if (!valid) {
        return { result: createAuthResult(false, undefined, 'INVALID_SIGNATURE') };
      }

      // Derive the fingerprint from the VERIFIED public key, not from the
      // client's claim (#671) — this is the only fingerprint value ever
      // treated as this client's identity from here on.
      if (response.clientFingerprint !== derivedFingerprint) {
        return { result: createAuthResult(false, undefined, 'FINGERPRINT_MISMATCH') };
      }
    } catch (err) {
      const code = err instanceof DOMException ? 'INVALID_KEY_DATA' : 'VERIFICATION_ERROR';
      return { result: createAuthResult(false, undefined, code) };
    }

    // Step 2: Check if client's key is authorized
    let isAuthorized: boolean;
    try {
      isAuthorized = this.store.isAuthorized(response.clientPublicKey, derivedFingerprint);
    } catch (err) {
      const detail = errorToString(err);
      console.error(`Auth store error during verification: ${detail}`);
      return { result: createAuthResult(false, undefined, 'AUTH_STORE_ERROR') };
    }

    // #1275: a pairing code ties this verified key to the `remi pair` that showed it; the person
    // still approves at the terminal. Checked only after the signature, so a forged answer never
    // claims a code.
    if (!isAuthorized && response.pairingNonce !== undefined) {
      return this.verifyPairing(challenge, response, derivedFingerprint, options.isOpen);
    }

    // #873: verified unknown identities request local human approval, never trust on first use.
    if (!isAuthorized) {
      try {
        await this.store.registerPendingKey(response.clientPublicKey);
      } catch (err) {
        // Concurrent explicit approval still requires a fresh challenge; no implicit admission.
        if (!(err instanceof DuplicateKeyError)) {
          const code =
            err instanceof PendingQueueFullError ? 'PENDING_QUEUE_FULL' : 'AUTH_STORE_ERROR';
          if (!(err instanceof PendingQueueFullError))
            console.error(`Auth store error during pending registration: ${errorToString(err)}`);
          return { result: createAuthResult(false, undefined, code) };
        }
      }
      return { result: createAuthResult(false, undefined, 'UNKNOWN_KEY') };
    }

    return this.admit(challenge, derivedFingerprint);
  }

  /** An authorized key: touch it and sign the same challenge for mutual authentication. */
  private async admit(challenge: string, fingerprint: string): Promise<VerifyResponseOutcome> {
    // Update lastUsedAt (non-critical; don't let failures break auth)
    this.store.touchAuthorizedKey(fingerprint);

    // Sign the same challenge with server's key for mutual authentication
    try {
      const challengeData = fromBase64(challenge);
      const serverSignature = await sign(this.identity.privateKey, challengeData);
      return {
        result: createAuthResult(true, serverSignature),
        verifiedFingerprint: fingerprint,
      };
    } catch (err) {
      const detail = errorToString(err);
      console.error(`Server failed to sign mutual auth challenge: ${detail}`);
      return { result: createAuthResult(false, undefined, 'SERVER_SIGN_ERROR') };
    }
  }

  /**
   * A verified, unknown key presenting a pairing code (#1275, ADR 0037). A malformed code or label,
   * or a code the store refuses, is answered with its own error and registers nothing. A claimed
   * code is held for the person's decision for up to `pairingWaitMs`: an approval is answered with
   * the ordinary success, a rejection or cancellation with its error, and no decision with
   * `PAIRING_PENDING`, after which the phone retries. The wait reads without the lock, so another
   * process holding it neither stalls nor fails the wait; it ends at once when the connection closes.
   */
  private async verifyPairing(
    challenge: string,
    response: AuthResponseMessage,
    fingerprint: string,
    isOpen: () => boolean = () => true,
  ): Promise<VerifyResponseOutcome> {
    const fail = (code: string): VerifyResponseOutcome => ({
      result: createAuthResult(false, undefined, code),
    });
    const nonce = response.pairingNonce;
    const label = pairingLabelOf(response.pairingLabel);
    if (!isPairingNonce(nonce) || label === null) {
      console.log(`[Pairing] refused a malformed code or label from ${fingerprint}`);
      return fail('PAIRING_MALFORMED');
    }
    let outcome: string;
    try {
      outcome = await this.store.claimPairing(nonce, response.clientPublicKey, label);
    } catch (err) {
      console.error(`Auth store error during pairing claim: ${errorToString(err)}`);
      return fail('AUTH_STORE_ERROR');
    }
    console.log(`[Pairing] ${fingerprint} presented a code: ${outcome}`);
    if (outcome !== 'CLAIMED') return fail(outcome);

    const deadline = Date.now() + this.pairingWaitMs;
    for (;;) {
      if (!isOpen()) return fail('PAIRING_PENDING');
      try {
        if (this.store.isAuthorized(response.clientPublicKey, fingerprint)) {
          return this.admit(challenge, fingerprint);
        }
        const state = this.store.peekPairing(nonce)?.state;
        if (state === 'rejected') return fail('PAIRING_REJECTED');
        if (state === 'cancelled') return fail('PAIRING_CANCELLED');
      } catch (err) {
        console.error(`Auth store error while a pairing waits: ${errorToString(err)}`);
        return fail('AUTH_STORE_ERROR');
      }
      const left = deadline - Date.now();
      if (left <= 0) return fail('PAIRING_PENDING');
      await Bun.sleep(Math.min(PAIRING_POLL_MS, left));
    }
  }

  /**
   * Verify a detached, connection-independent signed request (#575, P4a).
   *
   * Used by the HTTP `/answer` relay, which cannot run the interactive
   * challenge-response handshake but must still authenticate with the SAME
   * trust model the WebSocket uses: (1) verify the client's Ed25519 signature
   * over `message`, then (2) require the key to be in the authorized-keys store
   * (the exact gate `verifyResponse` step 2 applies). Unlike the live handshake,
   * this path does NOT register unknown candidates — a relayed answer must come
   * from an already-trusted client, never bootstrap trust.
   *
   * `message` is the canonical request string the client signed (the caller is
   * responsible for binding it to the request, e.g. sessionId|questionId|answer).
   * Returns true only when the signature verifies AND the key is authorized.
   */
  async verifyDetachedRequest(
    message: string,
    signatureBase64: string,
    clientPublicKeyBase64: string,
    clientFingerprint: string,
  ): Promise<boolean> {
    let derivedFingerprint: string;
    try {
      derivedFingerprint = await validatePublicKey(clientPublicKeyBase64);
      if (clientFingerprint !== derivedFingerprint) return false;
      const clientPublicKey = await importPublicKey(fromBase64(clientPublicKeyBase64));
      const data = new TextEncoder().encode(message).buffer as ArrayBuffer;
      const valid = await verify(clientPublicKey, data, signatureBase64);
      if (!valid) return false;
    } catch (err) {
      console.error(`Detached request verification error: ${errorToString(err)}`);
      return false;
    }

    try {
      return this.store.isAuthorized(clientPublicKeyBase64, derivedFingerprint);
    } catch (err) {
      console.error(`Auth store error during detached verification: ${errorToString(err)}`);
      return false;
    }
  }

  /**
   * Clean up a pending challenge (e.g., on connection close).
   */
  removePendingChallenge(connectionId: string): void {
    this.pendingChallenges.delete(connectionId);
  }

  /** Get the server's fingerprint for display. */
  get serverFingerprint(): string {
    return this.identity.fingerprint;
  }

  /** Get the server's public key (Base64) for display. */
  get serverPublicKey(): string {
    return this.identity.publicKeyRaw;
  }
}
