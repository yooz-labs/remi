/** Internal hub -> child descriptor. Shape alone grants no device or chat authority. */
import { createHash } from 'node:crypto';
import { isSmallOrderPublicKey } from '@remi/shared';
import type { SecurePushAuthority, SecurePushStore } from '../notifications/secure-push-store';
import type { Connection } from '../server/connection';
import { isAuthorityEpoch } from '../storage/authority-epoch';

export const RELAY_CHAT_AUTHORITY_HEADER = 'x-remi-relay-chat';

function snapshot(value: unknown): SecurePushAuthority | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
      'authorizationEpoch,enrollmentEpoch,fingerprint,publicKey' ||
    typeof row['publicKey'] !== 'string' ||
    typeof row['fingerprint'] !== 'string' ||
    !isAuthorityEpoch(row['authorizationEpoch']) ||
    !isAuthorityEpoch(row['enrollmentEpoch'])
  )
    return null;
  const key = Buffer.from(row['publicKey'], 'base64');
  if (
    key.length !== 32 ||
    key.toString('base64') !== row['publicKey'] ||
    isSmallOrderPublicKey(key) ||
    createHash('sha256').update(key).digest('hex').slice(0, 16) !== row['fingerprint']
  )
    return null;
  return Object.freeze({
    publicKey: row['publicKey'],
    fingerprint: row['fingerprint'],
    authorizationEpoch: row['authorizationEpoch'],
    enrollmentEpoch: row['enrollmentEpoch'],
  });
}

/** Only a capability-proved actual loopback upgrade may supply these bytes. */
export function decodeRelayChatAuthority(header: string): SecurePushAuthority | null {
  try {
    if (!header || header.length > 2048) return null;
    const bytes = Buffer.from(header, 'base64url');
    if (bytes.toString('base64url') !== header) return null;
    const text = bytes.toString('utf8');
    const value = snapshot(JSON.parse(text));
    // Canonical spelling also rejects duplicate members, invalid UTF-8 and extra whitespace.
    return value && JSON.stringify(value) === text ? value : null;
  } catch {
    return null;
  }
}

export function encodeRelayChatAuthority(authority: SecurePushAuthority): string {
  const value = snapshot(authority);
  if (!value) throw new Error('Invalid relay chat authority');
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** The historical header name is shared by child services; shape is never a grant. */
export interface ConnectionDeviceIdentity {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly proxy: SecurePushAuthority | null;
}
export function connectionDeviceKey(connection: Connection): string | null {
  return (
    connection.connectionClientPublicKey ??
    connection.structuredChatProxyAuthority?.publicKey ??
    null
  );
}
/** Caller already holds the original device grant lock; this never acquires it again. */
export function connectionDeviceIdentityInsideLock(
  connection: Connection,
  grant: string | null,
  relayAuthority?: SecurePushStore,
): ConnectionDeviceIdentity | null {
  if (!grant) return null;
  const proxy = connection.structuredChatProxyAuthority;
  if (proxy) {
    if (
      connection.connectionClientPublicKey ||
      connection.connectionClientFingerprint ||
      !relayAuthority?.isCurrentAuthorityInsideLock(proxy, grant)
    )
      return null;
    return { publicKey: proxy.publicKey, fingerprint: proxy.fingerprint, proxy };
  }
  const publicKey = connection.connectionClientPublicKey;
  const fingerprint = connection.connectionClientFingerprint;
  return publicKey && fingerprint ? { publicKey, fingerprint, proxy: null } : null;
}
