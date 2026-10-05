/** Internal relay rows; synchronous helpers require the existing authorization lock for writes. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RelayDevice } from '@remi/shared';
import { isAuthorityEpoch } from './authority-epoch.ts';
import { writeRestrictedJson } from './restricted-json.ts';

export type StoredRelayDevice = RelayDevice & { readonly enrollmentEpoch?: string };

export function readRelayEnrollments(directory: string): StoredRelayDevice[] {
  let values: unknown;
  try {
    values = JSON.parse(fs.readFileSync(path.join(directory, 'relay_devices.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('RELAY_STORAGE_ERROR');
  }
  if (
    !Array.isArray(values) ||
    values.some(
      (value) =>
        !value ||
        typeof value.publicKey !== 'string' ||
        !/^[0-9a-f]{16}$/.test(value.fingerprint) ||
        typeof value.label !== 'string' ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        (value.lastUsedAt !== null && !Number.isFinite(Date.parse(value.lastUsedAt))) ||
        ('enrollmentEpoch' in value && !isAuthorityEpoch(value.enrollmentEpoch)),
    )
  )
    throw new Error('RELAY_STORAGE_ERROR');
  return values as StoredRelayDevice[];
}

export function writeRelayEnrollments(
  directory: string,
  values: readonly StoredRelayDevice[],
): void {
  writeRestrictedJson(path.join(directory, 'relay_devices.json'), values);
}
