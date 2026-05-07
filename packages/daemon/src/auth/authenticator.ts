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
  fromBase64,
  generateChallenge,
  importPublicKey,
  sign,
  verify,
} from '@remi/shared';
import { DuplicateKeyError, type IdentityStore } from './identity-store.ts';

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
   * Returns an AuthResultMessage with success/failure.
   *
   * Order: verify signature first (bad sigs never trigger TOFU),
   * then check authorization, then TOFU if applicable.
   */
  async verifyResponse(
    connectionId: string,
    response: AuthResponseMessage,
  ): Promise<AuthResultMessage> {
    const challenge = this.pendingChallenges.get(connectionId);
    if (!challenge) {
      return createAuthResult(false, undefined, 'NO_PENDING_CHALLENGE');
    }

    // Remove challenge (one-time use)
    this.pendingChallenges.delete(connectionId);

    // Step 1: Verify the signature FIRST (before checking authorization)
    try {
      const clientPublicKey = await importPublicKey(fromBase64(response.clientPublicKey));
      const challengeData = fromBase64(challenge);
      const valid = await verify(clientPublicKey, challengeData, response.signature);

      if (!valid) {
        return createAuthResult(false, undefined, 'INVALID_SIGNATURE');
      }
    } catch (err) {
      const code = err instanceof DOMException ? 'INVALID_KEY_DATA' : 'VERIFICATION_ERROR';
      return createAuthResult(false, undefined, code);
    }

    // Step 2: Check if client's key is authorized
    let isAuthorized: boolean;
    try {
      isAuthorized = this.store.isAuthorized(response.clientPublicKey, response.clientFingerprint);
    } catch (err) {
      const detail = errorToString(err);
      console.error(`Auth store error during verification: ${detail}`);
      return createAuthResult(false, undefined, `AUTH_STORE_ERROR: ${detail}`);
    }

    // Step 3: TOFU - if not authorized and auto-accept is enabled, add the key
    if (!isAuthorized) {
      if (this.tofuMode === 'auto-accept') {
        try {
          const label = `tofu-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
          await this.store.addAuthorizedKey(response.clientPublicKey, label);
          console.log(`New client auto-accepted (TOFU): ${response.clientFingerprint} [${label}]`);
          isAuthorized = true;
        } catch (err) {
          if (err instanceof DuplicateKeyError) {
            // Race condition: another connection added the key first
            isAuthorized = true;
          } else {
            const detail = errorToString(err);
            console.error(`TOFU auto-accept failed: ${detail}`);
            return createAuthResult(false, undefined, 'TOFU_FAILED');
          }
        }
      } else {
        return createAuthResult(false, undefined, 'UNKNOWN_KEY');
      }
    }

    // Update lastUsedAt (non-critical; don't let failures break auth)
    this.store.touchAuthorizedKey(response.clientFingerprint);

    // Sign the same challenge with server's key for mutual authentication
    try {
      const challengeData = fromBase64(challenge);
      const serverSignature = await sign(this.identity.privateKey, challengeData);
      return createAuthResult(true, serverSignature);
    } catch (err) {
      const detail = errorToString(err);
      console.error(`Server failed to sign mutual auth challenge: ${detail}`);
      return createAuthResult(false, undefined, 'SERVER_SIGN_ERROR');
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
