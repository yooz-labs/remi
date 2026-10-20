import { type UnlockedIdentity, sign } from '@remi/shared';
import type { Base64, Fingerprint } from '@remi/shared';

/** Native identities expose an operation, never a CryptoKey or private bytes. */
export interface NativeSigningIdentity {
  readonly kind: 'native';
  readonly publicKeyRaw: Base64;
  readonly fingerprint: Fingerprint;
  readonly revision: string;
  readonly requiresAppUnlock: boolean;
  readonly sign: (message: Uint8Array) => Promise<Base64>;
}

export type ClientSigningIdentity = UnlockedIdentity | NativeSigningIdentity;

export function signClient(identity: ClientSigningIdentity, message: ArrayBuffer): Promise<Base64> {
  return 'kind' in identity
    ? identity.sign(new Uint8Array(message))
    : sign(identity.privateKey, message);
}
