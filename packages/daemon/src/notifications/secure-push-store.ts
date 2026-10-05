/** Constructible fail-closed boundary for secure-subscription behavior pins (#1200). */
import type { SecurePushRegisterResult, SecurePushRegistration } from '@remi/shared';
import type { IdentityStore } from '../auth/identity-store.ts';

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
  captureAuthority(_publicKey: string): SecurePushAuthority | null {
    return null;
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
