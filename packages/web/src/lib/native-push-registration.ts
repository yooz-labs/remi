import { type SecurePushRegistration, relayV2, toBase64 } from '@remi/shared';
import type { NativeSigningIdentity } from './client-signer';
import { getIdentityRevision } from './identity-client';
import { currentNativeIdentity, nativeIdentityRequest } from './native-identity';

export interface NativePushRegistrationTicket {
  readonly metadata: SecurePushRegistration;
  readonly ticket: string;
  readonly identity: NativeSigningIdentity;
  readonly localRevision: number;
}

const unavailable = () => new Error('Secure notifications are unavailable. Enable notifications and check the signed app setup.');

function current(identity: NativeSigningIdentity, revision: number): void {
  const live = currentNativeIdentity();
  if (!live || getIdentityRevision() !== revision || live.publicKeyRaw !== identity.publicKeyRaw ||
      live.revision !== identity.revision || live.requiresAppUnlock !== identity.requiresAppUnlock)
    throw unavailable();
}

function context(identity: NativeSigningIdentity): {publicKey: string; revision: string} {
  return {publicKey: identity.publicKeyRaw, revision: identity.revision};
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)))
    throw unavailable();
  return value as Record<string, unknown>;
}

/** The user invokes the native OS owner. JavaScript supplies neither token nor environment. */
export async function enableNativeSecurePush(identity: NativeSigningIdentity): Promise<void> {
  const revision = getIdentityRevision();
  current(identity, revision);
  let result: unknown;
  try { result = await nativeIdentityRequest({op: 'enableSecurePush', ...context(identity)}); }
  catch { throw unavailable(); }
  current(identity, revision);
  if (object(result, ['requested'])['requested'] !== true) throw unavailable();
}

export async function prepareNativePushRegistration(
  identity: NativeSigningIdentity,
  machinePublicKey: string,
): Promise<NativePushRegistrationTicket> {
  const localRevision = getIdentityRevision();
  current(identity, localRevision);
  const machine = relayV2.fromB64u(machinePublicKey);
  if (machine.length !== 32 || relayV2.isSmallOrderPublicKey(machine)) throw unavailable();
  const rid = await relayV2.ridOf(machine);
  current(identity, localRevision);
  let result: unknown;
  try { result = await nativeIdentityRequest({op: 'preparePushRegistration', ...context(identity), rid: toBase64(rid.buffer as ArrayBuffer)}); }
  catch { throw unavailable(); }
  current(identity, localRevision);
  const reply = object(result, ['token', 'environment', 'pushPublicKey', 'keyVersion', 'ticket']);
  if (typeof reply['token'] !== 'string' || !/^[0-9a-f]{2,512}$/.test(reply['token']) || reply['token'].length % 2 !== 0 ||
      !['production', 'sandbox'].includes(reply['environment'] as string) ||
      typeof reply['pushPublicKey'] !== 'string' || typeof reply['keyVersion'] !== 'number' ||
      !Number.isSafeInteger(reply['keyVersion']) || reply['keyVersion'] < 1 ||
      typeof reply['ticket'] !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reply['ticket']))
    throw unavailable();
  const raw = relayV2.fromB64u(reply['pushPublicKey']);
  if (raw.length !== 65 || raw[0] !== 4) throw unavailable();
  await crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
  current(identity, localRevision);
  return Object.freeze({identity, localRevision, ticket: reply['ticket'], metadata: Object.freeze({
    token: reply['token'], environment: reply['environment'] as 'production' | 'sandbox',
    pushPublicKey: reply['pushPublicKey'], keyVersion: reply['keyVersion'],
  })});
}

export async function validateNativePushRegistration(
  prepared: NativePushRegistrationTicket,
): Promise<void> {
  current(prepared.identity, prepared.localRevision);
  let result: unknown;
  try { result = await nativeIdentityRequest({op: 'validatePushRegistration', ...context(prepared.identity), ticket: prepared.ticket}); }
  catch { throw unavailable(); }
  current(prepared.identity, prepared.localRevision);
  if (object(result, ['current'])['current'] !== true) throw unavailable();
}
