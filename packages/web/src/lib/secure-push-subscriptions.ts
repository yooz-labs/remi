import type {
  PushPreferences,
  SecurePushRegisterResponseMessage,
  SecurePushRegistration,
} from '@remi/shared';

/** A connected relay machine this device may subscribe to (#1200). */
export interface SecurePushTarget {
  readonly connectionId: string;
  readonly machinePublicKey: string;
}

/** Native metadata plus its one-use check, run immediately before sending. */
export interface PreparedSecurePush {
  readonly metadata: SecurePushRegistration;
  readonly validate: () => Promise<void>;
}

export interface SecurePushPort {
  readonly prepare: (machinePublicKey: string) => Promise<PreparedSecurePush>;
  readonly register: (
    connectionId: string,
    registration: SecurePushRegistration,
  ) => Promise<SecurePushRegisterResponseMessage>;
}

export type SecurePushOutcome =
  | { readonly kind: 'registered' }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unverified' };

/** Constructible scaffold for the pinned subscription tests. */
export class SecurePushSubscriptions {
  constructor(
    _port: SecurePushPort,
    _onOutcome: (connectionId: string, outcome: SecurePushOutcome) => void = () => {},
  ) {}
  tokenChanged(): void {}
  reset(): void {}
  sync(_targets: readonly SecurePushTarget[], _prefs: PushPreferences): void {}
}
