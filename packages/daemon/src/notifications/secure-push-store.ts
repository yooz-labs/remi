/** Constructible fail-closed boundary for secure-subscription behavior pins (#1200). */
import type { SecurePushRegisterResult, SecurePushRegistration } from '@remi/shared';
import type { IdentityStore } from '../auth/identity-store.ts';
import { newAuthorityEpoch } from '../storage/authority-epoch.ts';
import { readRelayEnrollments, writeRelayEnrollments } from '../storage/relay-enrollments.ts';
import { activateSecurePushLocked } from '../storage/secure-push-activation.ts';

export interface SecurePushAuthority {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly authorizationEpoch: string;
  readonly enrollmentEpoch: string;
}
export interface SecurePushSnapshot extends SecurePushAuthority, SecurePushRegistration {
  readonly subscriptionEpoch: string;
}
export class SecurePushStore {
  constructor(
    private readonly directory: string,
    private readonly trust: IdentityStore,
    private readonly capacity = 64,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64)
      throw new Error('SECURE_PUSH_CAPACITY_CONFIG');
  }
  captureAuthority(publicKey: string): SecurePushAuthority | null {
    return this.trust.withAuthorizationEpoch(
      publicKey,
      (authorizationEpoch) => {
        if (!authorizationEpoch) return null;
        const grant = this.trust
          .loadAuthorizedKeys()
          .keys.find((key) => key.publicKey === publicKey);
        if (!grant) return null;
        const rows = readRelayEnrollments(this.directory);
        const enrolled = rows.find(
          (row) => row.publicKey === publicKey && row.fingerprint === grant.fingerprint,
        );
        if (!enrolled) return null;
        activateSecurePushLocked(this.directory);
        const enrollmentEpoch = enrolled.enrollmentEpoch ?? newAuthorityEpoch();
        if (!enrolled.enrollmentEpoch)
          writeRelayEnrollments(
            this.directory,
            rows.map((row) => (row === enrolled ? { ...enrolled, enrollmentEpoch } : row)),
          );
        return Object.freeze({
          publicKey,
          fingerprint: grant.fingerprint,
          authorizationEpoch,
          enrollmentEpoch,
        });
      },
      true,
    );
  }
  async register(
    _authority: SecurePushAuthority,
    _registration: SecurePushRegistration,
    _mayCommit: () => boolean = () => true,
  ): Promise<SecurePushRegisterResult> {
    return { success: false, error: 'NOT_AUTHORIZED' };
  }
  unregister(_authority: SecurePushAuthority): boolean {
    return false;
  }
  listCurrent(): SecurePushSnapshot[] {
    return [];
  }
  withCurrentSubscription<T>(_snapshot: SecurePushSnapshot, _operation: () => T): T | null {
    return null;
  }
}
