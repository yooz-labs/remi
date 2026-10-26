/** An existing direct grant can enroll for notifications without granting full relay access. */
import { join } from 'node:path';
import type { AuthorizedKey } from '@remi/shared';
import { type IdentityStore, validatePublicKey } from '../auth/identity-store.ts';
import { newAuthorityEpoch } from '../storage/authority-epoch.ts';
import { withInterprocessFileLock } from '../storage/interprocess-file-lock.ts';
import {
  type NotificationEnrollment,
  readNotificationEnrollments,
  writeNotificationEnrollments,
} from '../storage/notification-enrollments.ts';
import { activateSecurePushLocked } from '../storage/secure-push-activation.ts';

export class NotificationDeviceStore {
  constructor(
    private readonly directory: string,
    private readonly trust: IdentityStore,
  ) {}

  list(): NotificationEnrollment[] {
    return readNotificationEnrollments(this.directory).filter((row) =>
      this.trust.withAuthorizationEpochNonblocking(
        row.publicKey,
        (epoch) => epoch === row.authorizationEpoch,
      ),
    );
  }

  isEnrolled(publicKey: string): boolean {
    return this.trust.withAuthorizationEpochNonblocking(
      publicKey,
      (epoch) =>
        !!epoch &&
        readNotificationEnrollments(this.directory).some(
          (row) => row.publicKey === publicKey && row.authorizationEpoch === epoch,
        ),
    );
  }

  async add(
    publicKey: string,
    authorizationEpoch: string,
    label: string,
    mayCommit: () => boolean = () => true,
  ): Promise<NotificationEnrollment> {
    const fingerprint = await validatePublicKey(publicKey);
    if (label.length > 128) throw new Error('NOTIFICATION_LABEL_INVALID');
    return this.trust.withAuthorizationEpoch(publicKey, (epoch) => {
      if (!epoch || epoch !== authorizationEpoch || !mayCommit())
        throw new Error('NOTIFICATION_NOT_AUTHORIZED');
      const rows = readNotificationEnrollments(this.directory);
      const existing = rows.find(
        (row) => row.publicKey === publicKey && row.authorizationEpoch === epoch,
      );
      if (existing) return existing;
      // Revoked generations cannot become current again and must not consume
      // the finite enrollment budget for newly paired devices.
      const grants = this.trust.loadAuthorizedKeys().keys as readonly (AuthorizedKey & {
        readonly authorizationEpoch?: string;
      })[];
      const retained = rows.filter(
        (row) =>
          row.publicKey !== publicKey &&
          grants.some(
            (grant) =>
              grant.publicKey === row.publicKey &&
              grant.authorizationEpoch === row.authorizationEpoch,
          ),
      );
      if (retained.length >= 64) throw new Error('NOTIFICATION_CAPACITY');
      const enrolled = Object.freeze({
        publicKey,
        fingerprint,
        label,
        createdAt: new Date().toISOString(),
        authorizationEpoch: epoch,
        enrollmentEpoch: newAuthorityEpoch(),
      });
      activateSecurePushLocked(this.directory);
      writeNotificationEnrollments(this.directory, [...retained, enrolled]);
      return enrolled;
    });
  }

  remove(fingerprint: string): void {
    withInterprocessFileLock(join(this.directory, 'authorized_keys.json'), () => {
      const rows = readNotificationEnrollments(this.directory);
      if (rows.length > 0) activateSecurePushLocked(this.directory);
      writeNotificationEnrollments(
        this.directory,
        rows.filter((row) => row.fingerprint !== fingerprint),
      );
    });
  }
}
