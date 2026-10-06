/** Secure subscriptions bind current grant, enrollment and token/key generations (#1200). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type AuthorizedKey,
  type SecurePushRegisterResult,
  type SecurePushRegistration,
  relayV2,
} from '@remi/shared';
import type { IdentityStore } from '../auth/identity-store.ts';
import { newAuthorityEpoch } from '../storage/authority-epoch.ts';
import { withInterprocessFileLock } from '../storage/interprocess-file-lock.ts';
import { readRelayEnrollments, writeRelayEnrollments } from '../storage/relay-enrollments.ts';
import { activateSecurePushLocked } from '../storage/secure-push-activation.ts';
import {
  type StoredSecurePushSubscription,
  normalizeSecureRegistration,
  readSecurePushSubscriptions,
  writeSecurePushSubscriptions,
} from '../storage/secure-push-subscriptions.ts';
import { sanitizePushPreferences } from './push-preferences.ts';

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
  /** READY peers keep the same captured generations for their entire channel lifetime. */
  isCurrentAuthority(authority: SecurePushAuthority): boolean {
    try {
      return this.trust.withAuthorizationEpoch(
        authority.publicKey,
        (epoch) =>
          !!epoch && epoch === authority.authorizationEpoch && this.enrollmentCurrent(authority),
      );
    } catch {
      return false;
    }
  }
  async register(
    authority: SecurePushAuthority,
    registration: SecurePushRegistration,
    mayCommit: () => boolean = () => true,
  ): Promise<SecurePushRegisterResult> {
    // Copy before the first await: mutable callers cannot replace token/key/authority later.
    const captured = Object.freeze({ ...authority });
    let prepared: ReturnType<typeof normalizeSecureRegistration>;
    try {
      // Preferences cross a trust boundary and fail toward delivering, as everywhere else
      // (`sanitizePushPreferences`, #968): a non-boolean field or an unknown key never refuses
      // the registration, it resolves to "deliver" (#1200, B7).
      prepared = normalizeSecureRegistration({
        ...registration,
        pushPrefs: sanitizePushPreferences(registration.pushPrefs),
      });
      const point = relayV2.fromB64u(prepared.pushPublicKey);
      await crypto.subtle.importKey('raw', point, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    } catch {
      return { success: false, error: 'INVALID_SUBSCRIPTION' };
    }
    try {
      return this.trust.withAuthorizationEpoch(captured.publicKey, (grantEpoch) => {
        if (!mayCommit() || grantEpoch !== captured.authorizationEpoch || !grantEpoch)
          return { success: false, error: 'NOT_AUTHORIZED' };
        if (!this.enrollmentCurrent(captured)) return { success: false, error: 'NOT_ENROLLED' };
        activateSecurePushLocked(this.directory);
        const stored = readSecurePushSubscriptions(this.directory);
        const current = stored.filter((entry) => this.currentInsideLock(entry));
        const existing = current.find((entry) => entry.publicKey === captured.publicKey);
        if (
          existing &&
          (prepared.keyVersion < existing.keyVersion ||
            (prepared.keyVersion === existing.keyVersion &&
              prepared.pushPublicKey !== existing.pushPublicKey))
        )
          return { success: false, error: 'STALE_KEY_VERSION' };
        if (existing && this.sameRegistration(existing, prepared))
          return { success: true, keyVersion: existing.keyVersion };
        if (!existing && current.length >= this.capacity)
          return { success: false, error: 'CAPACITY' };
        const next: StoredSecurePushSubscription = {
          ...captured,
          ...prepared,
          subscriptionEpoch: newAuthorityEpoch(),
        };
        writeSecurePushSubscriptions(this.directory, [
          ...current.filter((entry) => entry.publicKey !== captured.publicKey),
          next,
        ]);
        return { success: true, keyVersion: next.keyVersion };
      });
    } catch {
      return { success: false, error: 'STORE_ERROR' };
    }
  }
  /** Idempotent for a currently authorized/enrolled READY authority, never for stale generations. */
  unregister(authority: SecurePushAuthority): boolean {
    return this.trust.withAuthorizationEpoch(authority.publicKey, (grantEpoch) => {
      if (
        !grantEpoch ||
        grantEpoch !== authority.authorizationEpoch ||
        !this.enrollmentCurrent(authority)
      )
        return false;
      const stored = readSecurePushSubscriptions(this.directory);
      const kept = stored.filter((entry) => entry.publicKey !== authority.publicKey);
      if (kept.length !== stored.length) writeSecurePushSubscriptions(this.directory, kept);
      return true;
    });
  }
  listCurrent(): SecurePushSnapshot[] {
    return this.transaction(() =>
      readSecurePushSubscriptions(this.directory)
        .filter((entry) => this.currentInsideLock(entry))
        .map((entry) =>
          Object.freeze({ ...entry, pushPrefs: Object.freeze({ ...entry.pushPrefs }) }),
        ),
    );
  }
  /** Recheck captured epochs and invoke the effect synchronously; await returned promises outside. */
  withCurrentSubscription<T>(snapshot: SecurePushSnapshot, operation: () => T): T | null {
    return this.trust.withAuthorizationEpoch(snapshot.publicKey, (grantEpoch) => {
      if (
        !grantEpoch ||
        grantEpoch !== snapshot.authorizationEpoch ||
        !this.enrollmentCurrent(snapshot)
      )
        return null;
      const entry = readSecurePushSubscriptions(this.directory).find(
        (value) => value.publicKey === snapshot.publicKey,
      );
      if (
        !entry ||
        entry.authorizationEpoch !== snapshot.authorizationEpoch ||
        entry.enrollmentEpoch !== snapshot.enrollmentEpoch ||
        entry.subscriptionEpoch !== snapshot.subscriptionEpoch ||
        !this.sameRegistration(entry, snapshot)
      )
        return null;
      return operation();
    });
  }
  private transaction<T>(operation: () => T): T {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    return withInterprocessFileLock(path.join(this.directory, 'authorized_keys.json'), operation);
  }
  private enrollmentCurrent(authority: SecurePushAuthority): boolean {
    const grant = this.trust
      .loadAuthorizedKeys()
      .keys.find(
        (key) => key.publicKey === authority.publicKey && key.fingerprint === authority.fingerprint,
      );
    return (
      grant !== undefined &&
      readRelayEnrollments(this.directory).some(
        (row) =>
          row.publicKey === authority.publicKey &&
          row.fingerprint === authority.fingerprint &&
          row.enrollmentEpoch === authority.enrollmentEpoch,
      )
    );
  }
  private currentInsideLock(entry: SecurePushAuthority): boolean {
    const keys = this.trust.loadAuthorizedKeys().keys as readonly (AuthorizedKey & {
      readonly authorizationEpoch?: string;
    })[];
    return (
      keys.some(
        (key) =>
          key.publicKey === entry.publicKey &&
          key.fingerprint === entry.fingerprint &&
          key.authorizationEpoch === entry.authorizationEpoch,
      ) && this.enrollmentCurrent(entry)
    );
  }
  private sameRegistration(left: SecurePushRegistration, right: SecurePushRegistration): boolean {
    const a = normalizeSecureRegistration({
      token: left.token,
      environment: left.environment,
      pushPublicKey: left.pushPublicKey,
      keyVersion: left.keyVersion,
      ...(left.pushPrefs ? { pushPrefs: left.pushPrefs } : {}),
    });
    const b = normalizeSecureRegistration({
      token: right.token,
      environment: right.environment,
      pushPublicKey: right.pushPublicKey,
      keyVersion: right.keyVersion,
      ...(right.pushPrefs ? { pushPrefs: right.pushPrefs } : {}),
    });
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
