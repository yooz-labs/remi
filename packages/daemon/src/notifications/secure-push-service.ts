/** One secure fan-out per event, with immutable prepared requests and current context (#1200). */
import type { UUID, relayV2 } from '@remi/shared';
import type { DeliveryOutcome } from './notification-dispatcher.ts';
import { sanitizePushPreferences, wantsPush } from './push-preferences.ts';
import type {
  SecurePushContext,
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
  private readonly options: SecurePushServiceOptions;
  private readonly deliveries = new WeakMap<SecurePushContext, Promise<DeliveryOutcome>>();
  constructor(options: SecurePushServiceOptions) {
    this.options = Object.freeze({ ...options });
  }
  forRuntime(runtime: SecurePushRuntime): SecureSessionPush {
    return Object.freeze({
      hasRecipients: (kind: relayV2.SecurePushKind) => {
        try {
          return this.recipients(kind).length > 0;
        } catch {
          // Unknown storage is a failed channel, not a claimed empty recipient list.
          this.report('refused');
          return true;
        }
      },
      send: (event: SecurePushEvent) => this.send(runtime, event),
    });
  }
  private recipients(kind: relayV2.SecurePushKind) {
    return this.options.store
      .listCurrent()
      .filter((snapshot) =>
        wantsPush({ pushPrefs: sanitizePushPreferences(snapshot.pushPrefs) }, kind),
      );
  }
  private send(runtime: SecurePushRuntime, event: SecurePushEvent): Promise<DeliveryOutcome> {
    try {
      const recipients = this.recipients(event.kind);
      if (recipients.length === 0) return Promise.resolve('no_channel');
      const tasks = recipients.map((snapshot) => {
        const context = this.options.contexts.capture(runtime, snapshot, event);
        if (!context) {
          this.report('refused');
          return Promise.resolve('failed' as const);
        }
        let delivery = this.deliveries.get(context);
        if (!delivery) {
          delivery = this.deliver(context);
          this.deliveries.set(context, delivery);
        }
        return delivery;
      });
      return Promise.all(tasks).then((outcomes) =>
        outcomes.includes('pushed') ? 'pushed' : 'failed',
      );
    } catch {
      this.report('refused');
      return Promise.resolve('failed');
    }
  }
  private async deliver(context: SecurePushContext): Promise<DeliveryOutcome> {
    try {
      const { contexts, transport } = this.options;
      const bound: { digest: string | undefined } = { digest: undefined };
      const isCurrent = () =>
        contexts.isCurrent(context) &&
        (!bound.digest ||
          !context.payload.actionable ||
          contexts.latestAction(
            context.runtime,
            context.payload.questionId as UUID,
            context.snapshot.publicKey,
          )?.contentDigest === bound.digest);
      const preparation = await transport.prepare(
        context.snapshot,
        {
          ...context.content,
          machinePublicKey: this.options.machinePublicKey,
          rid: this.options.rid,
        },
        context.payload,
        isCurrent,
      );
      if (
        preparation.outcome !== 'prepared' ||
        !contexts.bindDigest(context, preparation.prepared.contentDigest)
      ) {
        this.report('refused');
        return 'failed';
      }
      bound.digest = preparation.prepared.contentDigest;
      const result = await transport.sendPrepared(preparation.prepared);
      this.report(result.outcome);
      return result.outcome === 'accepted' ? 'pushed' : 'failed';
    } catch {
      this.report('refused');
      return 'failed';
    }
  }
  private report(outcome: 'accepted' | 'rejected' | 'uncertain' | 'refused'): void {
    try {
      this.options.log(outcome);
    } catch {
      /* Diagnostics never alter a delivery decision. */
    }
  }
}
