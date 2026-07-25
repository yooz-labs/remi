/**
 * Idle-unload timer for the local LLM (#820) — the replacement for ollama's
 * `keep_alive`.
 *
 * ollama evicted an idle model on its own (a `keep_alive` duration, default
 * 5 min server-side; remi's warm path asked for 30). The Yooz engine has **no
 * keep-alive concept at all**: weights stay resident until `POST /v1/llm/unload`
 * or the engine's own eviction. Retiring ollama (#809) therefore quietly turned
 * a self-limiting memory cost into an unbounded one — a remi daemon left open
 * overnight pins multi-GB of GPU memory it has not used since the afternoon.
 *
 * This class restores the old behavior: every evaluation calls `noteActivity`,
 * and `keepAliveMs` after the LAST one, the models remi loaded are unloaded.
 *
 * Two rules it must not break:
 *
 *   1. **Only unload what remi owns.** Under a shared (super-yooz) engine,
 *      another module may be mid-generate on the same weights, so unloading is
 *      hostile — `ownsEngine: false` disables the timer entirely rather than
 *      making it configurable, because this is a correctness boundary and not
 *      a preference (#818).
 *   2. **Never unload mid-eval.** `noteActivity` is called when an eval starts
 *      AND when it settles, so a long-running evaluation keeps pushing the
 *      deadline out rather than being cut out from under.
 *
 * Known limitation, deliberately accepted for now: each daemon process runs its
 * own timer. Two remi daemons sharing one engine means the first to idle
 * unloads a model the other may still want, costing that one a cold reload —
 * annoying, not incorrect. Proper cross-daemon coordination is the same problem
 * #620 tracks for GPU admission, and belongs there rather than being
 * half-solved here.
 */

export interface ModelResidencyDeps {
  /** Free a model's weights. Wired to `engine-models.unloadModel`. */
  readonly unload: (model: string) => Promise<void>;
  readonly log: (msg: string) => void;
  /** Timer seams so tests do not wait in real time. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ModelResidencyConfig {
  /** Idle window before unloading. <= 0 disables the timer (never unload). */
  readonly keepAliveMs: number;
  /** Models remi may unload — its configured model and, when set, the
   *  escalate_model. Anything the engine loaded for somebody else is not
   *  remi's to free. */
  readonly models: readonly string[];
  /** False under a shared engine: the timer never arms. See rule 1. */
  readonly ownsEngine: boolean;
}

export class ModelResidency {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  /** Models this instance has actually unloaded, so a second fire is a no-op
   *  until real activity re-loads them. */
  private unloaded = false;
  /** Bumped by every `noteActivity`. An unload loop that started before the
   *  bump aborts rather than freeing weights an evaluation is now using —
   *  the unload is a sequence of awaited HTTP calls, so "we decided to unload"
   *  and "we finished unloading" are far enough apart for a new eval to
   *  arrive in between (rule 2 in the module doc). */
  private activityGeneration = 0;
  /** One retry per idle window after a failed unload; reset by real activity. */
  private retried = false;

  constructor(
    private readonly config: ModelResidencyConfig,
    private readonly deps: ModelResidencyDeps,
  ) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** True when this instance will ever unload anything. */
  get enabled(): boolean {
    return this.config.ownsEngine && this.config.keepAliveMs > 0 && this.config.models.length > 0;
  }

  /**
   * An evaluation happened (started, or settled). Pushes the idle deadline out.
   * Cheap enough to call on every eval — it replaces one timer.
   */
  noteActivity(): void {
    if (!this.enabled) return;
    this.unloaded = false;
    this.retried = false;
    this.activityGeneration += 1;
    this.arm();
  }

  /** Cancel the timer (daemon shutdown). Does NOT unload: a shutting-down
   *  daemon should not evict a model another one may be using. */
  stop(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    this.stop();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.unloadIdle();
    }, this.config.keepAliveMs);
    this.timer.unref?.();
  }

  /**
   * Fire: free every model remi loaded. Best-effort per model — one failure
   * (engine restarted, model already gone) must not skip the others, and none
   * of it is worth throwing into a timer callback.
   */
  private async unloadIdle(): Promise<void> {
    if (this.unloaded) return;
    this.unloaded = true;
    let anyFailed = false;
    const generation = this.activityGeneration;
    const idleSec = Math.round(this.config.keepAliveMs / 1000);
    for (const model of this.config.models) {
      // Re-check before EACH unload: an eval that arrived mid-loop must not
      // have the next model pulled out from under it.
      if (this.activityGeneration !== generation) {
        this.deps.log(
          '[AutoApprove] keep_alive unload aborted: an evaluation started while unloading',
        );
        return;
      }
      try {
        await this.deps.unload(model);
        this.deps.log(`[AutoApprove] Unloaded ${model} after ${idleSec}s idle (keep_alive)`);
      } catch (err) {
        anyFailed = true;
        this.deps.log(
          `[AutoApprove] keep_alive unload of ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // A transient failure (engine mid-restart, a blip) must not defeat the
    // feature for the rest of the idle window: without a retry, a daemon left
    // idle overnight keeps pinning the weights this timer exists to free, and
    // the only trace is one log line nobody is watching. Re-arm ONCE.
    if (anyFailed && !this.retried) {
      this.retried = true;
      this.unloaded = false;
      this.deps.log(
        '[AutoApprove] keep_alive unload failed; retrying once after another idle window',
      );
      this.arm();
    }
  }

  /** Test-only: whether a timer is currently armed. */
  hasArmedTimerForTest(): boolean {
    return this.timer !== null;
  }
}
