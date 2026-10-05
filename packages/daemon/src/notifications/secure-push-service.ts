/** One secure fan-out per event, with immutable prepared requests and current context (#1200). */
import type { relayV2 } from '@remi/shared';
import type { DeliveryOutcome } from './notification-dispatcher.ts';
import type {
  SecurePushContexts,
  SecurePushEvent,
  SecurePushRuntime,
} from './secure-push-contexts.ts';
import type { SecurePushStore } from './secure-push-store.ts';
import type { SecurePushTransport } from './secure-push-transport.ts';

export interface SecureSessionPush {
  hasRecipients(kind: relayV2.SecurePushKind): boolean;
  send(event: SecurePushEvent): Promise<DeliveryOutcome>;
}
export interface SecurePushServiceOptions {
  readonly store: SecurePushStore;
  readonly transport: SecurePushTransport;
  readonly contexts: SecurePushContexts;
  readonly machinePublicKey: string;
  readonly rid: string;
  readonly log: (outcome: 'accepted' | 'rejected' | 'uncertain' | 'refused') => void;
}
export class SecurePushService {
  constructor(private readonly options: SecurePushServiceOptions) {}
  forRuntime(_runtime: SecurePushRuntime): SecureSessionPush {
    return Object.freeze({
      hasRecipients: (_kind: relayV2.SecurePushKind) => false,
      send: (_event: SecurePushEvent) => Promise.resolve('failed' as const),
    });
  }
}
