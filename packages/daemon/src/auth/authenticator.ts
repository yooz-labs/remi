/**
 * Authenticator - Server-side authentication logic.
 *
 * Handles the challenge-response handshake:
 * 1. Generate challenge with server's public key
 * 2. Verify client's signature and check authorized keys
 * 3. Sign challenge for mutual authentication
 */

import type {
  AuthChallengeMessage,
  AuthResponseMessage,
  AuthResultMessage,
  UnlockedIdentity,
} from '@remi/shared';
import {
  createAuthChallenge,
  createAuthResult,
  fromBase64,
  generateChallenge,
  importPublicKey,
  sign,
  verify,
} from '@remi/shared';
import type { IdentityStore } from './identity-store.ts';

export interface AuthenticatorConfig {
  identity: UnlockedIdentity;
  identityStore: IdentityStore;
}

export class Authenticator {
  private readonly identity: UnlockedIdentity;
  private readonly store: IdentityStore;
  /** Active challenges keyed by connection ID */
  private readonly pendingChallenges = new Map<string, string>();

  constructor(config: AuthenticatorConfig) {
    this.identity = config.identity;
    this.store = config.identityStore;
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

    // Check if client's key is authorized
    const isAuthorized = this.store.isAuthorized(
      response.clientPublicKey,
      response.clientFingerprint,
    );
    if (!isAuthorized) {
      return createAuthResult(false, undefined, 'UNKNOWN_KEY');
    }

    // Verify the signature
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

    // Update lastUsedAt
    this.store.touchAuthorizedKey(response.clientFingerprint);

    // Sign the challenge ourselves for mutual authentication
    const challengeData = fromBase64(challenge);
    const serverSignature = await sign(this.identity.privateKey, challengeData);

    return createAuthResult(true, serverSignature);
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
