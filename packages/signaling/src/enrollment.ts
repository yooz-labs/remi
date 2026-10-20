/** Enrollment epochs are internal authority, not signed wire fields or historical keys. */
import { b64u, fromB64u } from '@remi/shared/relay/index.ts';
import type { PushStorage } from './push-storage.ts';
export interface Enrollment {
  at: number;
  epoch?: string;
}
export function enrollment(value: unknown): Enrollment | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid enrollment');
  const row = value as Enrollment;
  if (!Number.isSafeInteger(row.at) || row.at < 0) throw new Error('invalid enrollment');
  if (
    row.epoch !== undefined &&
    (typeof row.epoch !== 'string' || fromB64u(row.epoch).length !== 32)
  )
    throw new Error('invalid enrollment');
  return row;
}
export function freshEpoch(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}
/** Capture before the first async proof/budget operation; absence never authorizes. */
export function captureEnrollment(storage: PushStorage, key: string): string | undefined {
  return storage.transactionSync(() => {
    const row = enrollment(storage.kv.get(key));
    if (!row) return undefined;
    if (row.epoch) return row.epoch;
    const epoch = freshEpoch();
    storage.kv.put(key, { ...row, epoch });
    return epoch;
  });
}
export function sameEnrollment(storage: PushStorage, key: string, epoch: string): boolean {
  return enrollment(storage.kv.get(key))?.epoch === epoch;
}
