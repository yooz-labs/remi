/** Fail-closed construction scaffold; no delivery effects until the boundary pins pass (#1200). */
import type { relayV2 as r } from '@remi/shared';
import type { SecurePushSnapshot, SecurePushStore } from './secure-push-store.ts';

export interface SecurePushTransportOptions {
  readonly store: SecurePushStore;
  readonly signer: r.Signer;
  readonly audience: string;
  readonly maxAttempts?: 1 | 2 | 3;
  readonly retryDelayMs?: number;
}
export interface OwnedLoopbackPushTestOptions extends SecurePushTransportOptions {
  readonly ownedOrigin: string;
}
export interface PreparedSecurePush {
  readonly carrier: r.PushCarrier;
  readonly contentDigest: string;
  readonly requestDigest: string;
  readonly submitNonce: string;
  readonly expiresAt: number;
}
export type SecurePushRefusal =
  | 'AUTHORITY_CHANGED'
  | 'NOT_CURRENT'
  | 'EXPIRED'
  | 'STORE_ERROR'
  | 'INVALID_CONTENT'
  | 'NOT_PREPARED';
export type SecurePushPreparation =
  | { readonly outcome: 'prepared'; readonly prepared: PreparedSecurePush }
  | { readonly outcome: 'refused'; readonly reason: SecurePushRefusal };
export type SecurePushDelivery =
  | { readonly outcome: 'refused'; readonly reason: SecurePushRefusal; readonly attempts: number }
  | {
      readonly outcome: 'accepted' | 'uncertain';
      readonly requestDigest: string;
      readonly attempts: number;
    }
  | {
      readonly outcome: 'rejected';
      readonly requestDigest: string;
      readonly reason: r.PushRejectReason;
      readonly retryable: boolean;
      readonly attempts: number;
    };
const ownedTests = new WeakMap<SecurePushTransportOptions, string>();
export class SecurePushTransport {
  constructor(options: SecurePushTransportOptions) {
    let url: URL;
    try {
      url = new URL(options.audience);
    } catch {
      throw new Error('SECURE_PUSH_AUDIENCE');
    }
    if (
      url.origin !== options.audience ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          ownedTests.get(options) === url.origin
        ))
    )
      throw new Error('SECURE_PUSH_AUDIENCE');
  }
  /** Exact owned HTTP127 listener only; production constructor never enables HTTP. */
  static forOwnedLoopbackTest(options: OwnedLoopbackPushTestOptions): SecurePushTransport {
    if (options.ownedOrigin !== options.audience) throw new Error('SECURE_PUSH_AUDIENCE');
    const copy: SecurePushTransportOptions = { ...options };
    ownedTests.set(copy, options.ownedOrigin);
    try {
      return new SecurePushTransport(copy);
    } finally {
      ownedTests.delete(copy);
    }
  }
  async prepare(
    _snapshot: SecurePushSnapshot,
    _metadata: r.PushContentMetadata,
    _payload: r.SecurePushPayload,
    _isCurrent: () => boolean,
  ): Promise<SecurePushPreparation> {
    return { outcome: 'refused', reason: 'INVALID_CONTENT' };
  }
  async sendPrepared(_prepared: PreparedSecurePush): Promise<SecurePushDelivery> {
    return { outcome: 'refused', reason: 'NOT_PREPARED', attempts: 0 };
  }
}
