/**
 * Authenticator - Server-side authentication logic.
 *
 * Handles the Ed25519 challenge-response handshake:
 * 1. Generate a random one-time challenge, include server's fingerprint and public key
 * 2. Verify client's Ed25519 signature first (bad signatures never trigger TOFU)
 * 3. Check authorized keys; if unknown and TOFU is enabled, auto-accept
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
import { errorToString } from '@remi/shared';
import {
  createAuthChallenge,
  createAuthResult,
  fingerprint,
  fromBase64,
  generateChallenge,
  importPublicKey,
  sign,
  verify,
} from '@remi/shared';
import { DuplicateKeyError, type IdentityStore } from './identity-store.ts';

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

export type TofuMode = 'auto-accept' | 'reject';

export interface AuthenticatorConfig {
  readonly identity: UnlockedIdentity;
  readonly identityStore: IdentityStore;
  readonly tofuMode?: TofuMode;
}

export class Authenticator {
  private readonly identity: UnlockedIdentity;
  private readonly store: IdentityStore;
  private readonly tofuMode: TofuMode;
  /** Active challenges keyed by connection ID */
  private readonly pendingChallenges = new Map<string, string>();

  constructor(config: AuthenticatorConfig) {
    this.identity = config.identity;
    this.store = config.identityStore;
    this.tofuMode = config.tofuMode ?? 'reject';
  }

  /**
   * Create an auth challenge for a new connection.
   * @param connectionId Unique connection identifier to track the challenge
   */
  createChallenge(connectionId: string): AuthChallengeMessage {
    const challenge = generateChallenge();
    this.pendingChallenges.set(connectionId, challenge);
    return createAuthChallenge(challenge, this.identity.fingerprint, this.identity.publicKeyRaw);
  }

  /**
   * Verify a client's auth response.
   * Returns a `VerifyResponseOutcome`: the wire `AuthResultMessage` plus,
   * on success, the server-derived `verifiedFingerprint`.
   *
   * Order: verify signature first (bad sigs never trigger TOFU),
   * then check authorization, then TOFU if applicable.
   *
   * `response.clientFingerprint` is NEVER used for authorization or identity
   * binding (#671): it is a client-supplied wire field, and Ed25519
   * signature verification only proves possession of `clientPublicKey`, not
   * that the claimed fingerprint actually hashes from that key. Every
   * identity-bearing check here (authorized-keys lookup, TOFU, lastUsedAt,
   * and the fingerprint returned to the caller) uses `derivedFingerprint`,
   * computed server-side from the verified public key.
   */
  async verifyResponse(
    connectionId: string,
    response: AuthResponseMessage,
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
      derivedFingerprint = await fingerprint(clientPublicKeyRaw);
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
      return { result: createAuthResult(false, undefined, `AUTH_STORE_ERROR: ${detail}`) };
    }

    // Step 3: TOFU - if not authorized and auto-accept is enabled, add the key
    if (!isAuthorized) {
      if (this.tofuMode === 'auto-accept') {
        try {
          const label = `tofu-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
          await this.store.addAuthorizedKey(response.clientPublicKey, label);
          console.log(`New client auto-accepted (TOFU): ${derivedFingerprint} [${label}]`);
          isAuthorized = true;
        } catch (err) {
          if (err instanceof DuplicateKeyError) {
            // Race condition: another connection added the key first
            isAuthorized = true;
          } else {
            const detail = errorToString(err);
            console.error(`TOFU auto-accept failed: ${detail}`);
            return { result: createAuthResult(false, undefined, 'TOFU_FAILED') };
          }
        }
      } else {
        return { result: createAuthResult(false, undefined, 'UNKNOWN_KEY') };
      }
    }

    // Update lastUsedAt (non-critical; don't let failures break auth)
    this.store.touchAuthorizedKey(derivedFingerprint);

    // Sign the same challenge with server's key for mutual authentication
    try {
      const challengeData = fromBase64(challenge);
      const serverSignature = await sign(this.identity.privateKey, challengeData);
      return {
        result: createAuthResult(true, serverSignature),
        verifiedFingerprint: derivedFingerprint,
      };
    } catch (err) {
      const detail = errorToString(err);
      console.error(`Server failed to sign mutual auth challenge: ${detail}`);
      return { result: createAuthResult(false, undefined, 'SERVER_SIGN_ERROR') };
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
   * this path does NOT TOFU-accept unknown keys — a relayed answer must come
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
    try {
      const clientPublicKey = await importPublicKey(fromBase64(clientPublicKeyBase64));
      const data = new TextEncoder().encode(message).buffer as ArrayBuffer;
      const valid = await verify(clientPublicKey, data, signatureBase64);
      if (!valid) return false;
    } catch (err) {
      console.error(`Detached request verification error: ${errorToString(err)}`);
      return false;
    }

    try {
      return this.store.isAuthorized(clientPublicKeyBase64, clientFingerprint);
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
