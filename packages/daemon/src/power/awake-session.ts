import { performance } from 'node:perf_hooks';
import type { UUID } from '@remi/shared';
import type { MessageAPI } from '../api/message-api.ts';
import type { AwakeConfig } from '../config/config.ts';
import {
  AwakeHolder,
  type AwakeHolderBoundary,
  type AwakeHolderResult,
  describeHolderFailure,
  isPermanentHolderFailure,
} from './awake-holder.ts';
import {
  type AwakePolicyEvent,
  type AwakePolicyState,
  initialAwakePolicyState,
  stepAwakePolicy,
} from './awake-policy.ts';

type Log = (message: string) => void;

/** The session's monotonic clock and timers; tests may drive their own. */
export interface AwakeClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export const REAL_AWAKE_CLOCK: AwakeClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Delays before each re-spawn after an unexpected caffeinate exit or a failed
 * spawn that is not ENOENT or EACCES. After the last one the session stops
 * trying until the policy's next hold transition (#1773 C5).
 */
export const AWAKE_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000];

export interface AwakeSessionOptions {
  /** Builds the holder; `onUnexpectedExit` must reach the holder's own callback. */
  readonly createHolder?: (onUnexpectedExit: (detail: string) => void) => AwakeHolderBoundary;
  readonly clock?: AwakeClock;
  readonly retryDelaysMs?: readonly number[];
}

/** Drives the pure policy and the per-session caffeinate boundary. */
export class AwakeSession {
  private readonly holder: AwakeHolderBoundary;
  private readonly clock: AwakeClock;
  private readonly retryDelaysMs: readonly number[];
  private readonly unsubscribe: () => void;
  private state: AwakePolicyState;
  private timer: unknown = null;
  private retryTimer: unknown = null;
  private operationPending = false;
  private holdLogged = false;
  private unavailableLogged = false;
  /** Failed spawns or unexpected exits since the last hold transition. */
  private failures = 0;
  private troubleLogged = false;
  private disposed = false;
  private pendingReason = 'turn open';

  constructor(
    private readonly sessionId: UUID,
    messageApi: MessageAPI,
    private readonly config: AwakeConfig,
    private readonly log: Log,
    options: AwakeSessionOptions = {},
  ) {
    this.clock = options.clock ?? REAL_AWAKE_CLOCK;
    this.retryDelaysMs = options.retryDelaysMs ?? AWAKE_RETRY_DELAYS_MS;
    this.state = initialAwakePolicyState(this.clock.now());
    const onUnexpectedExit = (detail: string): void => this.holderLost(detail);
    this.holder =
      options.createHolder?.(onUnexpectedExit) ??
      new AwakeHolder({
        targetPid: process.pid,
        ttlSeconds: config.ttl_minutes * 60,
        onUnexpectedExit,
      });
    this.unsubscribe = messageApi.subscribeWorkEvents((event) => this.handle(event));
  }

  /** True while the policy wants a hold and a caffeinate holder is running. */
  get isHolding(): boolean {
    return this.state.held && this.holder.pid !== null;
  }

  questionsChanged(count: number): void {
    this.handle({ type: 'questions', count });
  }

  dispose(): void {
    if (this.disposed) return;
    this.handle({ type: 'session-end' });
    this.disposed = true;
    this.clearTimers();
    this.unsubscribe();
    this.holder.dispose();
  }

  private handle(event: AwakePolicyEvent): void {
    if (this.disposed && event.type !== 'session-end') return;
    try {
      const result = stepAwakePolicy(this.config, this.state, event, this.clock.now());
      this.state = result.state;
      for (const effect of result.effects) {
        switch (effect.type) {
          case 'hold':
            this.pendingReason = effect.reason;
            this.failures = 0;
            this.troubleLogged = false;
            this.cancelRetry();
            void this.ensureHolder();
            break;
          case 'release':
            this.cancelRetry();
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
    await this.runHolder(() => this.holder.start());
  }

  private async renewHolder(): Promise<void> {
    if (this.disposed || this.operationPending || !this.state.held) return;
    await this.runHolder(() => this.holder.renew());
  }

  private async runHolder(operation: () => Promise<AwakeHolderResult>): Promise<void> {
    this.operationPending = true;
    let result: AwakeHolderResult;
    try {
      result = await operation();
    } catch (error) {
      result = {
        ok: false,
        failure: { kind: 'transient', detail: `failed (${(error as Error)?.name ?? 'error'})` },
      };
    } finally {
      this.operationPending = false;
    }
    if (this.disposed || !this.state.held) {
      if (result.ok) this.holder.release();
      return;
    }
    if (result.ok) {
      this.handle({ type: 'holder-started' });
      if (!this.holdLogged) {
        this.holdLogged = true;
        this.log(`[Awake] Hold started for ${this.sessionId} (${this.pendingReason})`);
      }
      return;
    }
    if (isPermanentHolderFailure(result.failure)) {
      if (!this.unavailableLogged) {
        this.unavailableLogged = true;
        this.log(
          `[Awake] caffeinate unavailable for ${this.sessionId}: ${describeHolderFailure(result.failure)}; hold disabled`,
        );
      }
      this.handle({ type: 'holder-failed' });
      return;
    }
    // A failed renewal leaves the previous holder running; either way no
    // renewal is due until a holder starts again.
    this.handle({ type: 'holder-lost' });
    this.holderTrouble(describeHolderFailure(result.failure));
  }

  private holderLost(detail: string): void {
    if (this.disposed) return;
    this.handle({ type: 'holder-lost' });
    this.holderTrouble(detail);
  }

  /** Re-spawn a bounded number of times, then wait for the next hold transition. */
  private holderTrouble(detail: string): void {
    if (this.disposed || !this.state.held || this.retryTimer !== null) return;
    if (this.failures >= this.retryDelaysMs.length) {
      if (this.holder.pid === null && this.holdLogged) {
        this.holdLogged = false;
        this.log(
          `[Awake] Hold ended for ${this.sessionId} (caffeinate ${detail}; no retry until the next hold)`,
        );
      }
      return;
    }
    if (!this.troubleLogged) {
      this.troubleLogged = true;
      this.log(
        `[Awake] caffeinate ${detail} for ${this.sessionId}; restarting it up to ${this.retryDelaysMs.length} times`,
      );
    }
    const delay = this.retryDelaysMs[this.failures] ?? 0;
    this.failures += 1;
    this.retryTimer = this.clock.setTimer(() => {
      this.retryTimer = null;
      if (this.disposed || !this.state.held) return;
      if (this.holder.pid === null) void this.ensureHolder();
      else void this.renewHolder();
    }, delay);
  }

  private schedule(deadline: number | null): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    if (deadline === null || this.disposed) return;
    const delay = Math.max(0, deadline - this.clock.now());
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.handle({ type: 'tick' });
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  private clearTimers(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    this.cancelRetry();
  }

  private failClosed(): void {
    if (this.holdLogged)
      this.log(`[Awake] Hold ended for ${this.sessionId} (caffeinate unavailable)`);
    this.holdLogged = false;
    this.holder.dispose();
    this.disposed = true;
    this.unsubscribe();
    this.clearTimers();
    this.log(`[Awake] Awake policy failed for ${this.sessionId}; hold disabled`);
  }
}
