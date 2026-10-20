/** Internal durable grant/enrollment generations; never client identity selectors (#1200). */
import { randomBytes } from 'node:crypto';

export function newAuthorityEpoch(): string {
  return randomBytes(32).toString('base64url');
}

export function isAuthorityEpoch(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}
