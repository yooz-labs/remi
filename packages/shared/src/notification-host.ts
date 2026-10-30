/** Direct bootstrap carries no token or identity selector; registration stays encrypted. */
import { generateId, now } from './protocol.ts';
import type { Timestamp, UUID } from './types.ts';

export type NotificationHostAction = 'status' | 'enable' | 'continue' | 'revoke';
export interface NotificationHostRequest {
  readonly type: 'notification_host_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly action: NotificationHostAction;
}
export type NotificationHostState =
  | 'registration_required'
  | 'active'
  | 'renewal_required'
  | 'revoked';
export type NotificationHostError =
  | 'UNSUPPORTED'
  | 'NOT_AUTHORIZED'
  | 'HOST_SETUP_REQUIRED'
  | 'STORE_ERROR'
  | 'CAPACITY'
  | 'BUSY';
export type NotificationHostResult =
  | { readonly success: true; readonly state: 'revoked' }
  | {
      readonly success: true;
      readonly state: Exclude<NotificationHostState, 'revoked'>;
      readonly relayUrl: string;
      readonly expiresAt: string | null;
    }
  | { readonly success: false; readonly error: NotificationHostError };
export type NotificationHostResponse = NotificationHostResult & {
  readonly type: 'notification_host_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly requestId: UUID;
};
export function createNotificationHostRequest(
  action: NotificationHostAction,
): NotificationHostRequest {
  return { type: 'notification_host_request', id: generateId(), timestamp: now(), action };
}
export function createNotificationHostResponse(
  requestId: UUID,
  result: NotificationHostResult,
): NotificationHostResponse {
  return {
    type: 'notification_host_response',
    id: generateId(),
    timestamp: now(),
    requestId,
    ...result,
  };
}

const base = ['type', 'id', 'timestamp'];
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
function relayOrigin(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'wss:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      url.origin === value
    );
  } catch {
    return false;
  }
}
/** The shared protocol has already checked the string envelope before this validator. */
export function isValidNotificationHostMessage(value: Record<string, unknown>): boolean {
  const { type, action, requestId, success, error, state, relayUrl, expiresAt } = value;
  if (type === 'notification_host_request')
    return (
      exact(value, [...base, 'action']) &&
      ['status', 'enable', 'continue', 'revoke'].includes(action as string)
    );
  if (type !== 'notification_host_response' || typeof requestId !== 'string' || !requestId)
    return false;
  const keys = [...base, 'requestId', 'success'];
  if (success === false)
    return (
      exact(value, [...keys, 'error']) &&
      [
        'UNSUPPORTED',
        'NOT_AUTHORIZED',
        'HOST_SETUP_REQUIRED',
        'STORE_ERROR',
        'CAPACITY',
        'BUSY',
      ].includes(error as string)
    );
  if (success !== true) return false;
  if (state === 'revoked') return exact(value, [...keys, 'state']);
  return (
    exact(value, [...keys, 'state', 'relayUrl', 'expiresAt']) &&
    ['registration_required', 'active', 'renewal_required'].includes(state as string) &&
    relayOrigin(relayUrl) &&
    (expiresAt === null ||
      (typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt))))
  );
}
