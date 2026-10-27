/** Identity-bound direct bootstrap; APNs tokens are registered only over encrypted v2. */
import type { NotificationHostRequest, NotificationHostResult, UUID } from '@remi/shared';
import type { IdentityStore } from '../auth/identity-store.ts';
import type { HubRelay } from '../remote/hub-relay.ts';
import { NotificationDeviceStore } from '../remote/notification-device-store.ts';
import type { SecurePushStore, SecureSubscriptionState } from './secure-push-store.ts';

export interface NotificationHostClient {
  readonly publicKey: string;
  /** In-memory connection identity/lifecycle only: never acquire a grant lock here. */
  readonly isCurrent: () => boolean;
}
export interface NotificationHostServiceOptions {
  readonly directory: string;
  readonly trust: IdentityStore;
  readonly subscriptions: SecurePushStore;
  readonly client: (id: UUID) => NotificationHostClient | null;
  readonly relay: () => HubRelay | undefined;
  readonly senderReady: () => boolean;
  readonly relayUrl: string;
}
export class NotificationHostService {
  private readonly pending = new Set<UUID>();
  private readonly enrollments: NotificationDeviceStore;
  private readonly origin: string | null;
  constructor(private readonly options: NotificationHostServiceOptions) {
    this.enrollments = new NotificationDeviceStore(options.directory, options.trust);
    try {
      const url = new URL(options.relayUrl);
      this.origin =
        url.protocol === 'wss:' &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
          ? url.origin
          : null;
    } catch {
      this.origin = null;
    }
  }
  isAvailable(connectionId: UUID): boolean {
    return this.options.client(connectionId)?.isCurrent() === true;
  }
  async handle(
    connectionId: UUID,
    request: NotificationHostRequest,
  ): Promise<NotificationHostResult> {
    const client = this.options.client(connectionId);
    if (!client?.isCurrent()) return { success: false, error: 'NOT_AUTHORIZED' };
    if (this.pending.has(connectionId) || this.pending.size >= 32)
      return { success: false, error: 'BUSY' };
    this.pending.add(connectionId);
    const deadline = performance.now() + 10_000;
    const current = () => performance.now() < deadline && client.isCurrent();
    try {
      const epoch = this.options.trust.captureAuthorizationEpoch(client.publicKey);
      if (!epoch || !current()) return { success: false, error: 'NOT_AUTHORIZED' };
      const relay = this.options.relay();
      let authority = this.options.subscriptions.captureAuthority(client.publicKey);
      if (authority && authority.authorizationEpoch !== epoch)
        return { success: false, error: 'NOT_AUTHORIZED' };
      if (request.action === 'revoke') {
        if (relay?.isRunning) await relay.revokeNotifications(client.publicKey, epoch, current);
        else {
          if (authority) this.options.subscriptions.unregister(authority);
          if (!this.enrollments.removeForAuthority(client.publicKey, epoch, current))
            return { success: false, error: 'NOT_AUTHORIZED' };
        }
        return { success: true, state: 'revoked' };
      }
      let state: SecureSubscriptionState = authority
        ? (this.options.subscriptions.subscriptionState(authority) ?? {
            state: 'registration_required',
            expiresAt: null,
          })
        : { state: 'registration_required', expiresAt: null };
      // Observe and persist expiry even while provider/room setup is unavailable.
      if (!relay?.notificationReady || !this.options.senderReady() || !this.origin)
        return { success: false, error: 'HOST_SETUP_REQUIRED' };
      if (state.state === 'renewal_required' && request.action !== 'continue')
        return { success: true, ...state, relayUrl: this.origin };
      if (request.action === 'enable' || request.action === 'continue') {
        await relay.enrollNotifications(client.publicKey, epoch, current);
        if (!current()) return { success: false, error: 'NOT_AUTHORIZED' };
        authority = this.options.subscriptions.captureAuthority(client.publicKey);
        if (!authority || authority.authorizationEpoch !== epoch)
          return { success: false, error: 'NOT_AUTHORIZED' };
        state = this.options.subscriptions.subscriptionState(authority) ?? state;
        if (request.action === 'continue' && state.state === 'renewal_required')
          state = { state: 'registration_required', expiresAt: null };
      }
      // Active authenticated use extends only a current epoch. Continue performs
      // a fresh encrypted registration, never an in-place revival here.
      if (authority && state.state === 'active') {
        this.options.subscriptions.renew(authority);
        state = this.options.subscriptions.subscriptionState(authority) ?? state;
      }
      if (!current() || this.options.trust.captureAuthorizationEpoch(client.publicKey) !== epoch)
        return { success: false, error: 'NOT_AUTHORIZED' };
      return { success: true, ...state, relayUrl: this.origin };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'NOTIFICATION_NOT_AUTHORIZED')
        return { success: false, error: 'NOT_AUTHORIZED' };
      if (code === 'NOTIFICATION_CAPACITY') return { success: false, error: 'CAPACITY' };
      if (code === 'HOST_SETUP_REQUIRED') return { success: false, error: 'HOST_SETUP_REQUIRED' };
      return { success: false, error: 'STORE_ERROR' };
    } finally {
      this.pending.delete(connectionId);
    }
  }
}
