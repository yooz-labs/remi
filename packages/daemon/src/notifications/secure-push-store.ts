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
import {
  NotificationStorageError,
  readNotificationEnrollments,
} from '../storage/notification-enrollments.ts';
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
export interface SecurePushStoreOptions {
  /** The same configured push lease as legacy registrations; 0 never expires (#1272). */
  readonly leaseMs?: number;
}
export class SecurePushStore {
  private readonly leaseMs: number;
  /** Unknown notification authority is retained for key floors but never a recipient. */
  private readonly unavailableEnrollments = new WeakSet<StoredSecurePushSubscription>();
  constructor(
    private readonly directory: string,
    private readonly trust: IdentityStore,
    private readonly capacity = 64,
    options: SecurePushStoreOptions = {},
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64)
      throw new Error('SECURE_PUSH_CAPACITY_CONFIG');
    this.leaseMs = options.leaseMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs < 0)
      throw new Error('SECURE_PUSH_LEASE_CONFIG');
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
        if (!enrolled) {
          const notification = readNotificationEnrollments(this.directory).find(
            (row) =>
              row.publicKey === publicKey &&
              row.fingerprint === grant.fingerprint &&
              row.authorizationEpoch === authorizationEpoch,
          );
          if (!notification) return null;
          activateSecurePushLocked(this.directory);
          return Object.freeze({
            publicKey,
            fingerprint: grant.fingerprint,
            authorizationEpoch,
            enrollmentEpoch: notification.enrollmentEpoch,
          });
        }
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
  /**
   * READY peers keep the same captured generations for their entire channel lifetime.
   * A store fault (lock contention, an unreadable file) is not a revocation, but it cannot
   * show the authority is current either, so it answers false like one and, when given,
   * reports the error to `onFault` so a caller can tell the two apart (#1201).
   */
  isCurrentAuthority(authority: SecurePushAuthority, onFault?: (error: unknown) => void): boolean {
    try {
      return this.trust.withAuthorizationEpochNonblocking(authority.publicKey, (epoch) =>
        this.isCurrentAuthorityInsideLock(authority, epoch),
      );
    } catch (error) {
      onFault?.(error);
      return false;
    }
  }
  /** Pure reads under an already-held authorization lock; never migrates or re-enters it. */
  isCurrentAuthorityInsideLock(authority: SecurePushAuthority, epoch: string | null): boolean {
    return !!epoch && epoch === authority.authorizationEpoch && this.enrollmentCurrent(authority);
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
        const stored = this.subscriptionsInsideLock();
        const current = stored.filter((entry) => this.leaseCurrent(entry));
        const known = stored.find((entry) => entry.publicKey === captured.publicKey);
        const existing = current.find((entry) => entry.publicKey === captured.publicKey);
        if (
          known &&
          (prepared.keyVersion < known.keyVersion ||
            (prepared.keyVersion === known.keyVersion &&
              prepared.pushPublicKey !== known.pushPublicKey))
        )
          return { success: false, error: 'STALE_KEY_VERSION' };
        if (existing && this.sameRegistration(existing, prepared)) {
          this.touchInsideLock(stored, existing);
          return { success: true, keyVersion: existing.keyVersion };
        }
        if ((!existing && current.length >= this.capacity) || (!known && stored.length >= 64))
          return { success: false, error: 'CAPACITY' };
        const next: StoredSecurePushSubscription = {
          ...captured,
          ...prepared,
          subscriptionEpoch: newAuthorityEpoch(),
          lastSeenAt: Date.now(),
        };
        writeSecurePushSubscriptions(this.directory, [
          ...stored.filter((entry) => entry.publicKey !== captured.publicKey),
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
      this.currentSubscriptionsInsideLock().map(({ lastSeenAt: _lastSeenAt, ...entry }) =>
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
      const entry = this.currentSubscriptionsInsideLock().find(
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
  /** Never recreates an expired/unregistered subscription or waits on a busy grant lock. */
  renew(authority: SecurePushAuthority): boolean {
    return this.trust.withAuthorizationEpochNonblocking(authority.publicKey, (epoch) => {
      if (!this.isCurrentAuthorityInsideLock(authority, epoch)) return false;
      const stored = this.subscriptionsInsideLock();
      const entry = stored.find((row) => row.publicKey === authority.publicKey);
      if (!entry || !this.leaseCurrent(entry)) return false;
      this.touchInsideLock(stored, entry);
      return true;
    });
  }
  private touchInsideLock(
    current: StoredSecurePushSubscription[],
    entry: StoredSecurePushSubscription,
  ): void {
    const lastSeenAt = Date.now();
    if (entry.lastSeenAt === lastSeenAt) return;
    writeSecurePushSubscriptions(
      this.directory,
      current.map((row) => (row === entry ? { ...row, lastSeenAt } : row)),
    );
  }
  /** Every fan-out and final invocation applies expiry to fresh disk state under the lock. */
  private currentSubscriptionsInsideLock(): StoredSecurePushSubscription[] {
    return this.subscriptionsInsideLock().filter((entry) => this.leaseCurrent(entry));
  }
  private leaseCurrent(entry: StoredSecurePushSubscription): boolean {
    return (
      !this.unavailableEnrollments.has(entry) &&
      !entry.leaseExpired &&
      (this.leaseMs === 0 || Date.now() - (entry.lastSeenAt ?? 0) < this.leaseMs)
    );
  }
  private subscriptionsInsideLock(): StoredSecurePushSubscription[] {
    const stored = readSecurePushSubscriptions(this.directory);
    const now = Date.now();
    let changed = false;
    const current: StoredSecurePushSubscription[] = [];
    for (const entry of stored) {
      try {
        if (!this.currentInsideLock(entry)) {
          changed = true;
          continue;
        }
      } catch (error) {
        if (!(error instanceof NotificationStorageError)) throw error;
        // Scope-local damage must neither erase a recipient's key-version floor
        // nor stop independent valid full-relay recipients from being served.
        this.unavailableEnrollments.add(entry);
        current.push(entry);
        continue;
      }
      // Existing v1 records get one migration lease, not an unlimited historical registration.
      // Persist clock rollback clamping once, so re-reads cannot repeatedly extend the lease.
      const lastSeenAt = Math.min(entry.lastSeenAt ?? now, now);
      const leaseExpired =
        entry.leaseExpired === true || (this.leaseMs > 0 && now - lastSeenAt >= this.leaseMs);
      // Retain expired rows (at most 64 total) to keep their push-key version floor.
      // Only explicit unregister/revoke resets that floor; a fresh registration rotates epoch.
      const rowChanged = entry.lastSeenAt !== lastSeenAt || leaseExpired !== !!entry.leaseExpired;
      changed ||= rowChanged;
      current.push(
        rowChanged
          ? {
              ...entry,
              lastSeenAt,
              ...(leaseExpired ? { leaseExpired: true as const } : {}),
            }
          : entry,
      );
    }
    if (changed) writeSecurePushSubscriptions(this.directory, current);
    return current;
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
    if (!grant) return false;
    const relay = readRelayEnrollments(this.directory).find(
      (row) => row.publicKey === authority.publicKey && row.fingerprint === authority.fingerprint,
    );
    // A full enrollment supersedes notification-only authority. An upgrade cannot
    // silently broaden an already-open notification channel's captured generation.
    if (relay) return relay.enrollmentEpoch === authority.enrollmentEpoch;
    return readNotificationEnrollments(this.directory).some(
      (row) =>
        row.publicKey === authority.publicKey &&
        row.fingerprint === authority.fingerprint &&
        row.authorizationEpoch === authority.authorizationEpoch &&
        row.enrollmentEpoch === authority.enrollmentEpoch,
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
