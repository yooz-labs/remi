/**
 * Two-stage idle policy for the local LLM (#820) — the replacement for
 * ollama's `keep_alive`.
 *
 * ollama evicted an idle model on its own (a `keep_alive` duration, default
 * 5 min server-side; remi's warm path asked for 30). The Yooz engine has **no
 * keep-alive concept at all**: weights stay resident until `POST
 * /v1/llm/unload` or the engine's own eviction. Retiring ollama (#809)
 * therefore quietly turned a self-limiting memory cost into an unbounded
 * one — a remi daemon left open overnight pins multi-GB of GPU memory it has
 * not used since the afternoon.
 *
 * Unload alone is blunt, though: measured on an M4 Pro for this workload
 * (~1K-token prompts), the serving process sits at 2.9 GB after loading the
 * 4B model and plateaus at 4.4 GB after evaluations. The ~1.5 GB delta is
 * retained prompt-KV cache — a WIN in steady state (remi sends an identical
 * system prompt every time, so the hit is why p50 stays ~1.0 s) but pure
 * cost on an idle laptop, and unloading to reclaim it pays a multi-second
 * cold reload on the very next permission.
 *
 * So this class runs TWO independent timers off the same activity signal:
 *
 *   Stage 1 (`cacheIdleMs`, `clearCache`) — drop the prompt-KV cache but
 *   KEEP the weights resident. Cheap and recomputable: the next evaluation
 *   just re-primes the cache, at the cost of one extra prefix pass instead
 *   of a cold model load.
 *
 *   Stage 2 (`keepAliveMs`, `unload`) — the original #820 behavior: free
 *   the weights entirely. Every evaluation calls `noteActivity`, and
 *   `keepAliveMs` after the LAST one, the models remi loaded are unloaded.
 *
 * Stage 1 firing does not disarm or otherwise affect stage 2 — they are
 * separate timers reset by the same `noteActivity`, so a cache drop at 5 min
 * idle does not delay or skip the unload at 30 min idle.
 *
 * Three rules neither stage may break:
 *
 *   1. **Only act on what remi owns.** Under a shared (super-yooz) engine,
 *      another module may be mid-generate on the same weights, so touching
 *      either the cache or the weights is hostile — `ownsEngine: false`
 *      disables BOTH timers entirely rather than making it configurable,
 *      because this is a correctness boundary and not a preference (#818).
 *      A cache clear is less destructive than an unload, but it still steals
 *      another module's warm-prefix latency, so it gets no separate carve-out.
 *   2. **Never act mid-eval.** `noteActivity` is called when an eval starts
 *      AND when it settles, so a long-running evaluation keeps pushing both
 *      deadlines out rather than having its cache or weights pulled out from
 *      under it.
 *   3. **Degrade silently when the engine lacks stage 1.** The clear-cache
 *      endpoint may ship after this code does (#820 was split across two
 *      repos in flight). An engine that 404s/501s on it must not break
 *      auto-approve, must not spam the log every idle window, and must not
 *      stop stage 2 from working — see `cacheUnsupported` below.
 *
 * **Cross-daemon coordination (#818 advisory).** Every daemon runs its own
 * timers, but they all share ONE engine. With ten sessions open, the first
 * daemon to sit idle for `cache_idle`/`keep_alive` would act on weights the
 * other nine are actively using — at that fleet size this is the common
 * case, not an edge, and it reads to the user as "remi randomly gets slow"
 * (every eviction costs the next session a multi-second cold load; even a
 * cache drop costs it the warm-prefix hit).
 *
 * The fix is deliberately the cheapest thing that works, not a protocol:
 * every eval touches a shared activity file, and a timer that fires checks it
 * before acting. If the MACHINE saw an eval within the relevant window, this
 * daemon re-arms instead of acting. One `utimes` per eval, one `stat` per
 * fire, no locks and no IPC. Anything heavier belongs with #620's GPU
 * admission work.
 */

import { ClearCacheUnsupportedError } from './engine-models.ts';

export interface ModelResidencyDeps {
  /** Free a model's weights. Wired to `engine-models.unloadModel`. */
  readonly unload: (model: string) => Promise<void>;
  /**
   * Drop the resident prompt-KV cache WITHOUT freeing weights (#820 stage
   * 1). Wired to `engine-models.clearModelCache` called with no model —
   * stage 1 only ever arms when `ownsEngine` is true (rule 1), so "every
   * loaded tier" already means "everything remi could have loaded."
   */
  readonly clearCache: () => Promise<readonly string[]>;
  readonly log: (msg: string) => void;
  /**
   * Shared machine-wide activity record (`~/.remi/engine-activity`), so ten
   * daemons sharing one engine do not act on each other's weights or cache.
   * Absent => this instance behaves as a lone daemon (the old per-process
   * semantics), which is correct for tests and for a single-session machine.
   */
  readonly activity?: ActivityRecord;
  /** Timer seams so tests do not wait in real time. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** The shared "when did any remi on this machine last evaluate?" record. */
export interface ActivityRecord {
  /** Mark an evaluation happening now. Must not throw. */
  touch(): void;
  /** Milliseconds since the last recorded eval by ANY daemon, or null when
   *  unknown (no record yet, or the read failed — treated as "no reason to
   *  wait", so a missing file never blocks eviction forever). */
  sinceLastMs(): number | null;
}

export interface ModelResidencyConfig {
  /** Idle window before dropping the prompt-KV cache while KEEPING weights
   *  resident (#820 stage 1). <= 0 disables stage 1 entirely. */
  readonly cacheIdleMs: number;
  /** Idle window before unloading (freeing weights) entirely — stage 2, the
   *  original #820 behavior. <= 0 disables the timer (never unload). */
  readonly keepAliveMs: number;
  /** Models remi may act on — its configured model and, when set, the
   *  escalate_model. Anything the engine loaded for somebody else is not
   *  remi's to free or clear. */
  readonly models: readonly string[];
  /** False under a shared engine: neither timer ever arms. See rule 1. */
  readonly ownsEngine: boolean;
}

export class ModelResidency {
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimerFn: (handle: ReturnType<typeof setTimeout>) => void;

  /** Stage 1: the cache has already been dropped this idle window, so a
   *  second fire (or a stray fire after stage 2 already unloaded) is a
   *  no-op until real activity clears the flag. */
  private cacheCleared = false;
  /** Stage 2: same idea, for the weights. */
  private unloaded = false;
  /** Bumped by every `noteActivity`. A stage whose "we decided to act"
   *  predates the bump aborts rather than acting on weights/cache an
   *  evaluation is now using — each stage is a sequence of awaited HTTP
   *  calls, so "we decided" and "we finished" are far enough apart for a new
   *  eval to arrive in between (rule 2 in the module doc). */
  private activityGeneration = 0;
  /** One retry per idle window after a TRANSIENT stage-1 failure; reset by
   *  real activity. Does not apply to `ClearCacheUnsupportedError` — see
   *  `cacheUnsupported`. */
  private cacheRetried = false;
  /** One retry per idle window after a TRANSIENT stage-2 failure. */
  private unloadRetried = false;
  /**
   * Set permanently once the engine has told us the clear-cache route does
   * not exist (404/501, rule 3). A route that is missing now will not
   * appear between one idle window and the next, so unlike a transient
   * failure this gets no retry and no re-arm — just one log line for the
   * life of this process, and stage 1 goes quiet. Stage 2 is untouched.
   */
  private cacheUnsupported = false;

  constructor(
    private readonly config: ModelResidencyConfig,
    private readonly deps: ModelResidencyDeps,
  ) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn = deps.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** True when this instance will ever unload anything (stage 2). Predates
   *  stage 1 and is kept with this exact meaning for existing callers/tests. */
  get enabled(): boolean {
    return this.keepAliveEnabled;
  }

  /** True when stage 1 (cache-drop) will ever fire. */
  get cacheStageEnabled(): boolean {
    return (
      this.config.ownsEngine &&
      this.config.cacheIdleMs > 0 &&
      this.config.models.length > 0 &&
      !this.cacheUnsupported
    );
  }

  private get keepAliveEnabled(): boolean {
    return this.config.ownsEngine && this.config.keepAliveMs > 0 && this.config.models.length > 0;
  }

  /**
   * An evaluation happened (started, or settled). Pushes BOTH idle deadlines
   * out. Cheap enough to call on every eval — it replaces at most two timers.
   */
  noteActivity(): void {
    const keepAlive = this.keepAliveEnabled;
    const cache = this.cacheStageEnabled;
    if (!keepAlive && !cache) return;
    this.unloaded = false;
    this.unloadRetried = false;
    this.cacheCleared = false;
    this.cacheRetried = false;
    this.activityGeneration += 1;
    // Record for the whole machine, not just this process: another daemon's
    // timer must be able to see that WE are busy.
    this.deps.activity?.touch();
    if (keepAlive) this.armUnload();
    if (cache) this.armCache();
  }

  /** Cancel both timers (daemon shutdown). Does NOT act: a shutting-down
   *  daemon should not evict or clear a model another one may be using. */
  stop(): void {
    if (this.unloadTimer !== null) {
      this.clearTimerFn(this.unloadTimer);
      this.unloadTimer = null;
    }
    if (this.cacheTimer !== null) {
      this.clearTimerFn(this.cacheTimer);
      this.cacheTimer = null;
    }
  }

  private armUnload(): void {
    if (this.unloadTimer !== null) this.clearTimerFn(this.unloadTimer);
    this.unloadTimer = this.setTimer(() => {
      this.unloadTimer = null;
      void this.unloadIdle();
    }, this.config.keepAliveMs);
    this.unloadTimer.unref?.();
  }

  private armCache(): void {
    if (this.cacheTimer !== null) this.clearTimerFn(this.cacheTimer);
    this.cacheTimer = this.setTimer(() => {
      this.cacheTimer = null;
      void this.clearCacheIdle();
    }, this.config.cacheIdleMs);
    this.cacheTimer.unref?.();
  }

  /**
   * Fire: free every model remi loaded. Best-effort per model — one failure
   * (engine restarted, model already gone) must not skip the others, and none
   * of it is worth throwing into a timer callback.
   */
  private async unloadIdle(): Promise<void> {
    if (this.unloaded) return;

    // Another daemon on this machine may have evaluated during OUR idle
    // window. Unloading now would cold-load that session's next permission.
    const sinceMachineActivity = this.deps.activity?.sinceLastMs() ?? null;
    if (sinceMachineActivity !== null && sinceMachineActivity < this.config.keepAliveMs) {
      this.armUnload();
      return;
    }

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
    if (anyFailed && !this.unloadRetried) {
      this.unloadRetried = true;
      this.unloaded = false;
      this.deps.log(
        '[AutoApprove] keep_alive unload failed; retrying once after another idle window',
      );
      this.armUnload();
    }
  }

  /**
   * Fire: drop the prompt-KV cache for whatever remi has resident, WITHOUT
   * unloading (#820 stage 1). A single call covering every loaded tier —
   * see the module/deps docs for why "no model" is safe here — so there is
   * no per-model loop to partially fail the way stage 2's does.
   */
  private async clearCacheIdle(): Promise<void> {
    // Nothing resident to clear either because we already cleared it this
    // window, or because stage 2 already unloaded everything outright.
    if (this.cacheCleared || this.unloaded) return;

    // Same machine-wide coordination as stage 2: another daemon's session
    // may be relying on this cache RIGHT NOW for its own warm-prefix hit.
    const sinceMachineActivity = this.deps.activity?.sinceLastMs() ?? null;
    if (sinceMachineActivity !== null && sinceMachineActivity < this.config.cacheIdleMs) {
      this.armCache();
      return;
    }

    this.cacheCleared = true;
    const generation = this.activityGeneration;
    const idleSec = Math.round(this.config.cacheIdleMs / 1000);
    try {
      const cleared = await this.deps.clearCache();
      // An eval landed while the HTTP call was in flight: noteActivity()
      // already reset cacheCleared/generation for us, so there is nothing to
      // undo here — the cache simply repopulates on the next request — but
      // the log should say what actually happened rather than claim a clean
      // idle-window clear.
      if (this.activityGeneration !== generation) {
        this.deps.log('[AutoApprove] cache_idle clear finished after an evaluation started');
        return;
      }
      this.deps.log(
        `[AutoApprove] Cleared prompt cache for ${cleared.length > 0 ? cleared.join(', ') : 'nothing loaded'} after ${idleSec}s idle (cache_idle)`,
      );
    } catch (err) {
      if (err instanceof ClearCacheUnsupportedError) {
        // This engine build will never grow the route between now and the
        // next fire, so unlike a transient failure this is not worth
        // retrying — and rule 3 requires exactly one log line, not one per
        // idle window for the rest of the process's life.
        if (!this.cacheUnsupported) {
          this.cacheUnsupported = true;
          this.deps.log(
            '[AutoApprove] cache_idle: engine does not support cache-clear (404/501); ' +
              'disabling stage 1 for this session. keep_alive (stage 2) is unaffected.',
          );
        }
        return;
      }
      this.deps.log(
        `[AutoApprove] cache_idle clear failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Same one-retry treatment as stage 2: a transient blip (engine
      // mid-restart) must not defeat cache-dropping for a whole idle
      // overnight session.
      if (!this.cacheRetried) {
        this.cacheRetried = true;
        this.cacheCleared = false;
        this.deps.log(
          '[AutoApprove] cache_idle clear failed; retrying once after another idle window',
        );
        this.armCache();
      }
    }
  }

  /** Test-only: whether the stage-2 (unload) timer is currently armed. */
  hasArmedTimerForTest(): boolean {
    return this.unloadTimer !== null;
  }

  /** Test-only: whether the stage-1 (cache-drop) timer is currently armed. */
  hasArmedCacheTimerForTest(): boolean {
    return this.cacheTimer !== null;
  }
}
