/** One secure fan-out per event, with immutable prepared requests and current context (#1200). */
import type { UUID, relayV2 } from '@remi/shared';
import type { DeliveryOutcome } from './notification-dispatcher.ts';
import { sanitizePushPreferences, wantsPush } from './push-preferences.ts';
import type {
  CaptureRefusal,
  SecurePushContext,
  SecurePushContexts,
  SecurePushEvent,
  SecurePushRuntime,
} from './secure-push-contexts.ts';
import type { SecurePushStore } from './secure-push-store.ts';
import type { SecurePushRefusal, SecurePushTransport } from './secure-push-transport.ts';

export interface SecureSessionPush {
  hasRecipients(kind: relayV2.SecurePushKind): boolean;
  send(event: SecurePushEvent): Promise<DeliveryOutcome>;
}
/**
 * What the service reports for each delivery step: a fixed class, never content or an id
 * (#1200, B8). `refused:<why>` names the refusal (a capture class or a transport preparation
 * class); `skipped:no_prior_push` is a dismissal with nothing to clear, which is not a refusal.
 */
export type SecurePushLog =
  | 'accepted'
  | 'rejected'
  | 'uncertain'
  | 'skipped:no_prior_push'
  | `refused:${CaptureRefusal | 'store' | Lowercase<SecurePushRefusal>}`;
export interface SecurePushServiceOptions {
  readonly store: SecurePushStore;
  readonly transport: SecurePushTransport;
  readonly contexts: SecurePushContexts;
  readonly machinePublicKey: string;
  readonly rid: string;
  readonly log: (outcome: SecurePushLog) => void;
}
export class SecurePushService {
  private readonly options: SecurePushServiceOptions;
  private readonly deliveries = new WeakMap<SecurePushContext, Promise<DeliveryOutcome>>();
  /** Sends not yet settled, per runtime, so a teardown can wait for its dismissals. */
  private readonly inflight = new Map<SecurePushRuntime, Set<Promise<unknown>>>();
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
          this.report('refused:store');
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
  /**
   * Wait, for at most `maxMs`, for the sends of `runtime` that are still in flight (#1200, B3).
   * A teardown retires the runtime, lets the session dispose emit its dismissals, drains here and
   * only then finishes the runtime. Never rejects.
   */
  async drain(runtime: SecurePushRuntime, maxMs: number): Promise<void> {
    const pending = this.inflight.get(runtime);
    if (!pending || pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }
  private send(runtime: SecurePushRuntime, event: SecurePushEvent): Promise<DeliveryOutcome> {
    const task = this.fanOut(runtime, event);
    const set = this.inflight.get(runtime) ?? new Set<Promise<unknown>>();
    this.inflight.set(runtime, set);
    set.add(task);
    void task.finally(() => {
      set.delete(task);
      if (set.size === 0 && this.inflight.get(runtime) === set) this.inflight.delete(runtime);
    });
    return task;
  }
  private fanOut(runtime: SecurePushRuntime, event: SecurePushEvent): Promise<DeliveryOutcome> {
    try {
      const recipients = this.recipients(event.kind);
      if (recipients.length === 0) return Promise.resolve('no_channel');
      const tasks = recipients.map((snapshot) => {
        const captured = this.options.contexts.captureResult(runtime, snapshot, event);
        if (!('context' in captured)) {
          const nothingToClear = captured.refused === 'no_prior_push';
          this.report(nothingToClear ? 'skipped:no_prior_push' : `refused:${captured.refused}`);
          return Promise.resolve(nothingToClear ? ('no_channel' as const) : ('failed' as const));
        }
        const { context } = captured;
        let delivery = this.deliveries.get(context);
        if (!delivery) {
          delivery = this.deliver(context);
          this.deliveries.set(context, delivery);
        }
        return delivery;
      });
      return Promise.all(tasks).then((outcomes) =>
        outcomes.includes('pushed')
          ? 'pushed'
          : outcomes.includes('uncertain')
            ? 'uncertain'
            : outcomes.every((outcome) => outcome === 'no_channel')
              ? 'no_channel'
              : 'failed',
      );
    } catch {
      this.report('refused:error');
      return Promise.resolve('failed');
    }
  }
  private async deliver(context: SecurePushContext): Promise<DeliveryOutcome> {
    const outcome = await this.deliverOnce(context);
    // A dismissal that did not go out may be sent again by the next dismissal event (B3).
    if (context.payload.type === 'dismiss' && outcome !== 'pushed')
      this.options.contexts.allowDismissRetry(context);
    return outcome;
  }
  private async deliverOnce(context: SecurePushContext): Promise<DeliveryOutcome> {
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
      if (preparation.outcome !== 'prepared') {
        this.report(`refused:${preparation.reason.toLowerCase() as Lowercase<SecurePushRefusal>}`);
        return 'failed';
      }
      if (!contexts.bindDigest(context, preparation.prepared.contentDigest)) {
        this.report('refused:stale');
        return 'failed';
      }
      bound.digest = preparation.prepared.contentDigest;
      const result = await transport.sendPrepared(preparation.prepared);
      this.report(
        result.outcome === 'refused'
          ? `refused:${result.reason.toLowerCase() as Lowercase<SecurePushRefusal>}`
          : result.outcome,
      );
      return result.outcome === 'accepted'
        ? 'pushed'
        : result.outcome === 'uncertain'
          ? 'uncertain'
          : 'failed';
    } catch {
      this.report('refused:error');
      return 'failed';
    }
  }
  private report(outcome: SecurePushLog): void {
    try {
      this.options.log(outcome);
    } catch {
      /* Diagnostics never alter a delivery decision. */
    }
  }
}

/**
 * The class of a failure while building the service, safe to log (#1200, B5): a fixed upper-case
 * code (this codebase's `SECURE_PUSH_*` convention) or the error's type name, never its message
 * text, which could carry key material, a path or a URL.
 */
export function initFailureClass(error: unknown): string {
  if (error instanceof Error) {
    if (/^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)) return error.message;
    if (/^[A-Za-z]{1,32}Error$/.test(error.name)) return error.name;
  }
  return 'UNKNOWN';
}
