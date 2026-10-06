import type { SecurePushRegistration } from '@remi/shared';
import type { NativeSigningIdentity } from './client-signer';

export interface NativePushRegistrationTicket {
  readonly metadata: SecurePushRegistration;
  readonly ticket: string;
  readonly identity: NativeSigningIdentity;
  readonly localRevision: number;
}

/** Constructible fail-closed caller scaffold for actual bundled-provider pins. */
export async function enableNativeSecurePush(_identity: NativeSigningIdentity): Promise<void> {
  throw new Error('Secure notifications are unavailable.');
}

export async function prepareNativePushRegistration(
  _identity: NativeSigningIdentity,
  _machinePublicKey: string,
): Promise<NativePushRegistrationTicket> {
  throw new Error('Secure notifications are unavailable.');
}

export async function validateNativePushRegistration(
  _prepared: NativePushRegistrationTicket,
): Promise<void> {
  throw new Error('Secure notifications are unavailable.');
}
