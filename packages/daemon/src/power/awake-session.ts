import { performance } from 'node:perf_hooks';
import type { UUID } from '@remi/shared';
import type { MessageAPI } from '../api/message-api.ts';
import type { AwakeConfig } from '../config/config.ts';
import { AwakeHolder } from './awake-holder.ts';
import type { AwakeHolderBoundary } from './awake-holder.ts';
import {
  type AwakePolicyEvent,
  type AwakePolicyState,
  initialAwakePolicyState,
  stepAwakePolicy,
} from './awake-policy.ts';

type Log = (message: string) => void;

/** Drives the pure policy and the per-session caffeinate boundary. */
export class AwakeSession {
  private readonly holder: AwakeHolderBoundary;
  private readonly unsubscribe: () => void;
  private state: AwakePolicyState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private operationPending = false;
  private holdLogged = false;
  private failureLogged = false;
  private disposed = false;
  private pendingReason = 'turn open';

  constructor(
    private readonly sessionId: UUID,
    private readonly messageApi: MessageAPI,
    private readonly config: AwakeConfig,
    private readonly log: Log,
    holder?: AwakeHolderBoundary,
  ) {
    this.state = initialAwakePolicyState(performance.now());
    this.holder =
      holder ??
      new AwakeHolder({
        targetPid: process.pid,
        ttlSeconds: config.ttl_minutes * 60,
        onUnexpectedExit: (exitCode, signal) => {
          if (exitCode === 0 && signal === null) this.handle({ type: 'tick' });
          else {
            this.logFailureOnce();
            this.handle({ type: 'holder-failed' });
          }
        },
        onTermination: () => this.dispose(),
      });
    this.unsubscribe = messageApi.subscribeWorkEvents((event) => this.handle(event));
  }

  get isHolding(): boolean {
    return this.state.held && this.holdLogged;
  }

  questionsChanged(count: number): void {
    this.handle({ type: 'questions', count });
  }

  dispose(): void {
    if (this.disposed) return;
    this.handle({ type: 'session-end' });
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribe();
    this.holder.dispose();
  }

  private handle(event: AwakePolicyEvent): void {
    if (this.disposed && event.type !== 'session-end') return;
    try {
      const result = stepAwakePolicy(this.config, this.state, event, performance.now());
      this.state = result.state;
      for (const effect of result.effects) {
        switch (effect.type) {
          case 'hold':
            this.pendingReason = effect.reason;
            void this.ensureHolder();
            break;
          case 'release':
            if (this.holdLogged)
              this.log(`[Awake] Hold ended for ${this.sessionId} (${effect.reason})`);
            this.holdLogged = false;
            this.holder.release();
            break;
          case 'warning':
            this.log(`[Awake] ${effect.reason} reached for ${this.sessionId}`);
            break;
          case 'renew':
            void this.renewHolder();
            break;
        }
      }
      this.schedule(result.nextDeadline);
    } catch {
      this.failClosed();
    }
  }

  private async ensureHolder(): Promise<void> {
    if (this.disposed || this.operationPending || this.holder.pid !== null) return;
    this.operationPending = true;
    let started = false;
    try {
      started = await this.holder.start();
    } catch {
      started = false;
    } finally {
      this.operationPending = false;
    }
    if (this.disposed || !this.state.held) {
      if (started) this.holder.release();
      return;
    }
    if (!started) {
      this.logFailureOnce();
      this.handle({ type: 'holder-failed' });
      return;
    }
    this.handle({ type: 'holder-started' });
    if (!this.holdLogged) {
      this.holdLogged = true;
      this.log(`[Awake] Hold started for ${this.sessionId} (${this.pendingReason})`);
    }
  }

  private async renewHolder(): Promise<void> {
    if (this.disposed || this.operationPending || !this.state.held) return;
    this.operationPending = true;
    let renewed = false;
    try {
      renewed = await this.holder.renew();
    } catch {
      renewed = false;
    } finally {
      this.operationPending = false;
    }
    if (this.disposed || !this.state.held) {
      if (renewed) this.holder.release();
      return;
    }
    if (!renewed) {
      this.logFailureOnce();
      this.handle({ type: 'holder-failed' });
      return;
    }
    this.handle({ type: 'holder-started' });
  }

  private schedule(deadline: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (deadline === null || this.disposed) return;
    const delay = Math.max(0, deadline - performance.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.handle({ type: 'tick' });
    }, delay);
    this.timer.unref?.();
  }

  private failClosed(): void {
    if (this.holdLogged)
      this.log(`[Awake] Hold ended for ${this.sessionId} (caffeinate unavailable)`);
    this.holdLogged = false;
    this.holder.dispose();
    this.disposed = true;
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.log(`[Awake] Awake policy failed for ${this.sessionId}; hold disabled`);
  }

  private logFailureOnce(): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    this.log(`[Awake] caffeinate unavailable for ${this.sessionId}; hold disabled`);
  }
}
