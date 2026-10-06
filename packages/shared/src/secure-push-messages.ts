/** Secure subscription requests carry no authority selectors: the READY channel owns identity. */
import { generateId, now } from './protocol.ts';
import type { PushPreferences } from './protocol.ts';
import type { ApnsEnvironment } from './relay/push.ts';
import type { Timestamp, UUID } from './types.ts';

export type SecurePushSubscriptionError =
  | 'UNSUPPORTED'
  | 'NOT_AUTHORIZED'
  | 'NOT_ENROLLED'
  | 'INVALID_SUBSCRIPTION'
  | 'STALE_KEY_VERSION'
  | 'CAPACITY'
  | 'STORE_ERROR';
export interface SecurePushRegistration {
  readonly token: string;
  readonly environment: ApnsEnvironment;
  readonly pushPublicKey: string;
  readonly keyVersion: number;
  readonly pushPrefs?: PushPreferences;
}
export interface SecurePushRegisterRequestMessage extends SecurePushRegistration {
  readonly type: 'secure_push_register_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
}
export type SecurePushRegisterResult =
  | { readonly success: true; readonly keyVersion: number }
  | { readonly success: false; readonly error: SecurePushSubscriptionError };
export type SecurePushRegisterResponseMessage = {
  readonly type: 'secure_push_register_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly requestId: UUID;
} & SecurePushRegisterResult;
export interface SecurePushUnregisterRequestMessage {
  readonly type: 'secure_push_unregister_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
}
export type SecurePushUnregisterResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: SecurePushSubscriptionError };
export type SecurePushUnregisterResponseMessage = {
  readonly type: 'secure_push_unregister_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly requestId: UUID;
} & SecurePushUnregisterResult;
export function createSecurePushRegisterRequest(
  r: SecurePushRegistration,
): SecurePushRegisterRequestMessage {
  return {
    type: 'secure_push_register_request',
    id: generateId(),
    timestamp: now(),
    token: r.token,
    environment: r.environment,
    pushPublicKey: r.pushPublicKey,
    keyVersion: r.keyVersion,
    ...(r.pushPrefs === undefined ? {} : { pushPrefs: r.pushPrefs }),
  };
}
export function createSecurePushRegisterResponse(
  requestId: UUID,
  result: SecurePushRegisterResult,
): SecurePushRegisterResponseMessage {
  return {
    type: 'secure_push_register_response',
    id: generateId(),
    timestamp: now(),
    requestId,
    ...(result.success
      ? { success: true, keyVersion: result.keyVersion }
      : { success: false, error: result.error }),
  };
}
export function createSecurePushUnregisterRequest(): SecurePushUnregisterRequestMessage {
  return { type: 'secure_push_unregister_request', id: generateId(), timestamp: now() };
}
export function createSecurePushUnregisterResponse(
  requestId: UUID,
  result: SecurePushUnregisterResult,
): SecurePushUnregisterResponseMessage {
  return {
    type: 'secure_push_unregister_response',
    id: generateId(),
    timestamp: now(),
    requestId,
    ...(result.success ? { success: true } : { success: false, error: result.error }),
  };
}

const ERRORS: readonly SecurePushSubscriptionError[] = [
  'UNSUPPORTED',
  'NOT_AUTHORIZED',
  'NOT_ENROLLED',
  'INVALID_SUBSCRIPTION',
  'STALE_KEY_VERSION',
  'CAPACITY',
  'STORE_ERROR',
];
const BASE = ['type', 'id', 'timestamp'];
const hasExactly = (o: Record<string, unknown>, required: string[]) =>
  required.every((key) => key in o) && Object.keys(o).every((key) => required.includes(key));
/**
 * Field validation of the two `secure_push_*` RESPONSES (#1200). Nothing but `isValidMessage`
 * guards them on their way to a client, so they must be a correlated typed success or typed error
 * with an exact shape. The caller has already checked that `type`, `id` and `timestamp` are
 * strings. The REQUESTS stay envelope-checked on purpose: the daemon validates them with
 * `normalizeSecureRegistration` and answers a typed INVALID_SUBSCRIPTION, which a stricter parse
 * would turn into a dropped message and a closed channel (owner decision, see the #1200 report).
 */
export function isValidSecurePushResponse(o: Record<string, unknown>): boolean {
  const withKeyVersion = o['type'] === 'secure_push_register_response';
  const requestId = o['requestId'];
  if (typeof requestId !== 'string' || requestId.length < 1) return false;
  if (o['success'] === true) {
    const keys = [...BASE, 'requestId', 'success', ...(withKeyVersion ? ['keyVersion'] : [])];
    const version = o['keyVersion'];
    return (
      hasExactly(o, keys) &&
      (!withKeyVersion ||
        (typeof version === 'number' && Number.isSafeInteger(version) && version >= 1))
    );
  }
  return (
    o['success'] === false &&
    hasExactly(o, [...BASE, 'requestId', 'success', 'error']) &&
    ERRORS.includes(o['error'] as SecurePushSubscriptionError)
  );
}
