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
