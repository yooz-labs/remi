/** Notification-only enrollment is deliberately invisible to older relay readers (#1678). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAuthorityEpoch } from './authority-epoch.ts';
import { writeRestrictedJson } from './restricted-json.ts';

export class NotificationStorageError extends Error {
  constructor() {
    super('NOTIFICATION_STORAGE_ERROR');
    this.name = 'NotificationStorageError';
  }
}

export interface NotificationEnrollment {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly label: string;
  readonly createdAt: string;
  readonly authorizationEpoch: string;
  readonly enrollmentEpoch: string;
}

/** Pure reads; mutations and authorization comparisons require the authorization lock. */
export function readNotificationEnrollments(directory: string): NotificationEnrollment[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(directory, 'notification_devices.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new NotificationStorageError();
  }
  if (!Array.isArray(value) || value.length > 64) throw new NotificationStorageError();
  const keys = new Set<string>();
  for (const row of value) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(',') !==
        'authorizationEpoch,createdAt,enrollmentEpoch,fingerprint,label,publicKey' ||
      typeof row.publicKey !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(row.publicKey) ||
      typeof row.fingerprint !== 'string' ||
      !/^[0-9a-f]{16}$/.test(row.fingerprint) ||
      typeof row.label !== 'string' ||
      row.label.length > 128 ||
      typeof row.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      !isAuthorityEpoch(row.authorizationEpoch) ||
      !isAuthorityEpoch(row.enrollmentEpoch) ||
      keys.has(row.publicKey)
    )
      throw new NotificationStorageError();
    keys.add(row.publicKey);
  }
  return value as NotificationEnrollment[];
}

export function writeNotificationEnrollments(
  directory: string,
  rows: readonly NotificationEnrollment[],
): void {
  writeRestrictedJson(join(directory, 'notification_devices.json'), rows);
}
