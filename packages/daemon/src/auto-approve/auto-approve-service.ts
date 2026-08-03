/**
 * Core auto-approve service.
 *
 * Evaluates PermissionRequest hook events using an LLM (via OpenAI-compatible
 * API). Returns one of: approve, deny, escalate, pick (multi-choice), or
 * cancelled (control plane).
 *
 * Designed to never throw. All errors result in escalation so the user
 * is never blocked by an LLM failure.
 */

import { errorToString } from '@remi/shared';
import { reconcileCounterfactual, shouldCounterfactual } from './authority-counterfactual.ts';
import { enforceAuthorityBoundary } from './authority.ts';
import { enforceDenyFloor } from './deny-floor.ts';
import { fileActivityRecord } from './engine-activity.ts';
import type { EngineHost } from './engine-host.ts';
import { clearModelCache, pullModel, unloadModel } from './engine-models.ts';
import type { PullProgress } from './engine-models.ts';
import { extractJsonObject } from './json-extract.ts';
import type { AutoApproveLevel } from './levels.ts';
import { chatCompletion, resolveProviderUrl, warmModel } from './llm-client.ts';
import type { LLMClientConfig } from './llm-client.ts';
import { ModelResidency } from './model-residency.ts';
import {
  buildMultiChoicePrompt,
  isDesignQuestion,
  isMultiChoicePermission,
  parseMultiChoiceDecision,
} from './multichoice.ts';
import { matchAllowPattern, matchSubstringPattern } from './pattern-matcher.ts';
import { matchGroups, matchGroupsBroad } from './permission-groups.ts';
import { buildPrompt } from './prompt-builder.ts';
import { classifyRisk, formatMatrixContext } from './risk-bands.ts';
import { enforceRiskCeiling } from './risk-ceiling.ts';
import type { AutoApproveConfig, AutoApproveResult, MultiChoiceMode } from './types.ts';

type BinaryDecision = 'approve' | 'deny' | 'escalate';
const VALID_DECISIONS = new Set<BinaryDecision>(['approve', 'deny', 'escalate']);

/**
 * Sentinel scope (#730) used when a caller omits `scope` from `evaluate()` /
 * `cancel()` — a direct-service unit test, or any other caller that never
 * mixes sessions. All such callers implicitly share this one scope, so their
 * behavior is unchanged from before per-session scoping existed: a single
 * caller's evalId is still enough to disambiguate. Only `AutoApproveGate`
 * (the one production caller) passes a real scope, its own `sessionId`.
 */
const DEFAULT_SCOPE = '__default__';

/**
 * One line describing a pull in flight, for `ensureModelPresent`.
 *
 * Deliberately leads with SIZE and ELAPSED rather than a percentage. The
 * engine's parent `Progress` advances per completed FILE, and these repos are
 * one multi-GB `model.safetensors` plus a few small ones, so the fraction steps
 * ~0.6% and then sits still for the entire transfer. Rendering that as a
 * percentage reads as a stuck download; `advancing` is the engine's own signal
 * for whether the number means anything yet (#292/#293).
 */
function describePullProgress(p: PullProgress): string {
  const parts: string[] = [];
  if (p.sizeBytes !== undefined && p.sizeBytes > 0) {
    parts.push(`${(p.sizeBytes / 1_000_000_000).toFixed(2)} GB`);
  }
  parts.push(`${Math.round(p.elapsedMs / 1000)}s elapsed`);
  // Only quote a percentage once it is demonstrably moving.
  if (p.advancing && p.fraction !== undefined) {
    parts.push(`${Math.round(p.fraction * 100)}%`);
  }
  return parts.join(', ');
}

/**
 * Convert one `permission_suggestions` entry into an LLM-ready label, or
 * null when the entry carries no useful content. Strings pass through;
 * objects are JSON-serialised so the LLM can read a structured option like
 * `{"type":"addDirectories",...}` (very long serialisations are truncated).
 */
export function normalisePermissionSuggestion(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (entry !== null && typeof entry === 'object') {
    try {
      const serialised = JSON.stringify(entry);
      if (!serialised || serialised === '{}') return null;
      return serialised.length > 200 ? `${serialised.slice(0, 197)}...` : serialised;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse an LLM response string into a binary approve/deny/escalate decision.
 * Tries JSON first. If JSON fails, escalates (no guessing from substring matches).
 * Exported for unit testing.
 */
export function parseDecision(raw: string): {
  decision: BinaryDecision;
  reasoning: string;
  /** #628: a one-sentence, lock-screen-friendly question the model produces on
   *  escalate (e.g. "Force-push to main?"). Absent for approve/deny or when the
   *  model omits it. */
  summary?: string;
} {
  // extractJsonObject tolerates a markdown code fence or a short preamble around
  // the JSON (deterministic, string-aware — never a free-text keyword guess).
  // Many reasoning-tuned local models, notably qwen3.6:35b-mlx, fence every
  // response; without this they escalate every safe verdict on formatting alone.
  const parsed = extractJsonObject(raw);
  if (parsed !== null) {
    const decisionStr = String(parsed['decision'] ?? '').toLowerCase();
    const reasoning = String(parsed['reasoning'] ?? '');
    const summaryRaw = parsed['summary'];
    const summary =
      typeof summaryRaw === 'string' && summaryRaw.trim().length > 0
        ? summaryRaw.trim()
        : undefined;
    if (VALID_DECISIONS.has(decisionStr as BinaryDecision)) {
      return summary
        ? { decision: decisionStr as BinaryDecision, reasoning, summary }
        : { decision: decisionStr as BinaryDecision, reasoning };
    }
  }

  return {
    decision: 'escalate',
    reasoning: `Unparsable LLM response: ${raw.slice(0, 100)}`,
  };
}

export class AutoApproveService {
  private readonly llmConfig: LLMClientConfig;
  private readonly logFn: (msg: string) => void;
  private readonly logDecisions: boolean;
  private readonly allow: readonly string[];
  private readonly deny: readonly string[];
  private readonly approveGroups: readonly string[];
  private readonly denyGroups: readonly string[];
  private readonly instructions: string;
  /** Strictness preset, threaded into the prompt's default guidelines (#966). */
  private readonly level: AutoApproveLevel;
  private readonly multichoiceMode: MultiChoiceMode;
  /** Tool names that always escalate to the user, never auto-decided (#572). */
  private readonly alwaysEscalateTools: ReadonlySet<string>;
  /** Falls back to llmConfig.model when empty. */
  private readonly multichoiceModel: string;
  /** Second-opinion model on a primary 'escalate' (#522); empty = none. Public
   *  so the gate can read it without re-threading the config. */
  readonly escalateModel: string;
  /** Dedicated timeout (ms) for escalate_model calls; 0 => fall back to the
   *  fast model's timeout. The heavy model is usually cold, so it needs a longer
   *  budget than the fast path. */
  private readonly escalateTimeoutMs: number;
  /** True when the provider is the Yooz engine (enables the /v1/llm/preload warm-up). */
  private readonly providerIsYooz: boolean;
  /** True when remi owns this engine and may therefore mutate its disk/memory
   *  state (fetch, unload, delete). False for a shared super-yooz host, where
   *  all of that is the host's policy (#818). */
  private readonly ownsEngine: boolean;

  /**
   * Two-stage idle policy (#820). The engine never evicts or drops cache on
   * its own, so without this a daemon holds both for its entire life. Armed
   * on every evaluation: `cache_idle` seconds of silence drops the retained
   * prompt-KV cache (weights stay resident), `keep_alive` seconds unloads
   * the weights entirely.
   */
  private readonly residency: ModelResidency;
  /**
   * Who starts the engine (#818). Absent when remi has no business supervising
   * one — a non-engine provider (OpenRouter, llama.cpp), or a caller that did
   * not supply it (tests). Absent means the old behavior: attach to whatever is
   * on the port, or escalate.
   */
  private readonly engineHost: EngineHost | undefined;
  /** In-flight self-heal, so a burst of failed evals triggers one repair. */
  private healInFlight: Promise<void> | null = null;
  /** How many times we concluded a DIFFERENT engine is now serving (#826).
   *  Diagnostic: the decision is otherwise invisible, and treating a healthy
   *  engine as replaced silently re-arms a degrade that exists to stay off. */
  private engineChanges = 0;
  /** Max ms a permission eval may wait in the serialization queue before it
   *  escalates gracefully (#551); 0 = no bound. */
  private readonly queueTimeoutMs: number;
  /** Serialize LLM evals: one runs at a time (one GPU). Concurrent requests
   *  QUEUE here instead of escalating-on-busy (#551). `evalActive` is true while
   *  a slot is held; `evalQueue` holds the FIFO waiters. The fast-path
   *  deny/allow/group checks run BEFORE acquiring a slot, so they are never
   *  queued. */
  private evalActive = false;
  private readonly evalQueue: Array<{
    /** Caller's scope (#730), normally an `AutoApproveGate`'s own sessionId —
     *  see `DEFAULT_SCOPE`. Lets `drainScope` drop one session's queued
     *  waiters without touching a sibling session's. */
    scope: string;
    /** Id of the queued eval (#617), so cancel(reason, evalId, scope) can drop
     *  a waiter whose question was answered before it ever reached the GPU. */
    evalId: number | undefined;
    /** Tags a subagent/team-member eval (#730), so `drainScope(scope,
     *  {mainOnly: true})` can spare it the same way `cancelStale`'s running-
     *  eval cancel already spares a subagent eval via `evalIsSubagentById`. */
    isSubagent: boolean;
    /** Take the slot (becomes the running eval). */
    grant: () => void;
    /** Resolve as NOT acquired -> the eval escalates gracefully instead of
     *  seizing the slot. The outcome distinguishes the global `drainQueue`
     *  (force-release) from the scoped `drainScope` (#730, cancelStale) so
     *  the escalation reasoning never misattributes one to the other. */
    deny: (outcome: 'drained' | 'drained-scope') => void;
  }> = [];
  /** Active LLM call's controller; cleared in the eval finally block. cancel()
   *  aborts via this. Held alongside the active slot so they share the same
   *  lifecycle window. */
  private currentAbortController: AbortController | null = null;
  /** Caller's scope (#730) for the eval currently holding the slot — see
   *  `DEFAULT_SCOPE`. `cancel(reason, evalId, scope)` only aborts the running
   *  eval when this matches the caller's own scope, so one session's teardown
   *  can never abort a DIFFERENT session's eval just because it happens to be
   *  the one holding the shared (daemon-wide) slot. null when idle. */
  private currentScope: string | null = null;
  /** Caller-supplied id of the eval currently holding the slot (#617). Lets
   *  `cancel(reason, evalId, scope)` abort ONLY the targeted eval instead of
   *  whatever happens to be running — so a manual answer for question X frees
   *  X's eval and never a different permission's (the wrong-victim risk that
   *  forced the old answer-cancel to be gated). null when the running eval
   *  supplied no id. */
  private currentEvalId: number | null = null;
  /** Set by cancel() so the catch block can distinguish a user-driven abort
   *  (Claude advanced past the prompt) from a timeout abort. */
  private cancelReason: string | null = null;

  constructor(config: AutoApproveConfig, logFn: (msg: string) => void, engineHost?: EngineHost) {
    this.engineHost = engineHost;
    this.llmConfig = {
      baseUrl: resolveProviderUrl(config.provider, config.base_url),
      apiKey: config.api_key,
      model: config.model,
      timeoutMs: config.timeout * 1000,
      // The Yooz engine's /v1/llm/generate is the only transport that is not
      // OpenAI-compatible (a thin llama.cpp server, OpenRouter, and any custom
      // URL all speak /v1/chat/completions already).
      kind: config.provider === 'yooz' ? 'yooz' : 'openai',
      // Suppress the model's chain-of-thought. Defaults ON, and applies to BOTH
      // transports -- `/no_think` is a chat-template convention the Qwen3 family
      // itself recognizes, so it is a property of the model, not the server, and
      // the openai kind additionally sends `chat_template_kwargs`. Not a tuning
      // knob: unsuppressed, the QAT-lean 0.8B spent its whole token budget
      // reasoning and returned NO content, so every eval became an error (#822).
      disableThinking: config.disable_thinking,
    };
    this.logFn = logFn;
    this.logDecisions = config.log_decisions;
    this.allow = config.allow;
    this.deny = config.deny;
    this.approveGroups = config.approve_groups;
    this.denyGroups = config.deny_groups;
    this.instructions = config.instructions;
    // #966: the LLM handles whatever no group covers, so its DEFAULT
    // GUIDELINES must agree with the level the user chose. Without this the
    // same policy gives different answers depending on whether a curated
    // prefix happens to exist.
    this.level = config.level;
    this.multichoiceMode = config.multichoice;
    this.alwaysEscalateTools = new Set(config.always_escalate_tools);
    this.multichoiceModel = config.multichoice_model;
    this.escalateModel = config.escalate_model;
    this.escalateTimeoutMs = config.escalate_timeout > 0 ? config.escalate_timeout * 1000 : 0;
    this.queueTimeoutMs = config.queue_timeout > 0 ? config.queue_timeout * 1000 : 0;
    this.providerIsYooz = config.provider === 'yooz';
    this.ownsEngine = this.providerIsYooz && config.engine === 'owned';
    // Only the engine transport has an unload endpoint at all, and (today)
    // remi always owns its own engine -- #818 introduces the shared-engine
    // mode, where `ownsEngine` flips false and this timer must never arm.
    this.residency = new ModelResidency(
      {
        cacheIdleMs: config.cache_idle * 1000,
        keepAliveMs: config.keep_alive * 1000,
        // EVERY model this service can cause the engine to load, or the timer
        // silently exempts one: multichoice_model is a third tier `evaluate`
        // dispatches against when a multi-choice prompt arrives.
        models: [
          ...new Set(
            [config.model, config.escalate_model, config.multichoice_model].filter(
              (m): m is string => typeof m === 'string' && m.length > 0,
            ),
          ),
        ],
        // #818: both stages are gated on OWNERSHIP, not on the transport. A
        // shared (super-yooz) engine's residency is the host's policy, and
        // touching weights (or even just the cache) another module is
        // mid-generate on is hostile.
        ownsEngine: this.ownsEngine,
      },
      {
        unload: (model) => unloadModel(this.llmConfig.baseUrl, model),
        // No model => every loaded tier. Safe because stage 1 only ever arms
        // in owned mode (above), where remi is the only thing that can have
        // loaded anything on this engine.
        clearCache: () => clearModelCache(this.llmConfig.baseUrl),
        log: logFn,
        // #818: ten daemons, one engine — coordinate eviction through a shared
        // mtime so no daemon acts on weights/cache another is actively using.
        activity: fileActivityRecord(),
      },
    );
  }

  /** Stop both idle timers (daemon shutdown). Does not act: another daemon
   *  may still be using the model or its cache (#820). */
  stopResidencyTimer(): void {
    this.residency.stop();
  }

  /**
   * Evaluations this service currently has in flight on the engine (#827).
   *
   * Exposed because the `beginEval`/`endEval` pairing is the one thing that can
   * silently disable BOTH eviction stages for the rest of the daemon's life if
   * it ever leaks — a failure strictly worse than the bug the counter fixes,
   * and otherwise unobservable from outside this class.
   */
  get evalsInFlight(): number {
    return this.residency.inFlightCount;
  }

  /**
   * Make sure an engine is answering, starting one if this remi owns the engine
   * (#818). Safe to call repeatedly: `EngineHost.ensureRunning` attaches to an
   * existing engine before considering a spawn, and claims the pidfile before
   * spawning, so concurrent callers across daemons cannot start two.
   *
   * Returns whether an engine is now reachable, so a caller at boot can report
   * the gap. A missing engine is NOT fatal — evaluation escalates, which is the
   * safe direction — but it must never be silent, which is what #818 was filed
   * for in the first place.
   */
  async ensureEngine(opts?: { readonly afterFailure?: boolean }): Promise<boolean> {
    const host = this.engineHost;
    if (host === undefined) return false;
    const state = await host.ensureRunning();
    if (state.kind === 'unavailable') {
      this.logFn(`[AutoApprove] No engine available: ${state.reason}`);
      return false;
    }
    // Any capability we learned about the previous engine (notably "this build
    // has no clear-cache route") is a fact about a PROCESS, so it must be
    // discarded whenever a different one is now serving (#826). Two cases:
    //
    //   - `spawned`: unambiguously a new process.
    //   - `attached` after a repair that only ran BECAUSE the engine was
    //     unreachable (`repairIfUnreachable` establishes that precondition):
    //     the engine went away and something answers now, so it is a different
    //     process. Without this a `shared` guest could NEVER clear the flag --
    //     it can never spawn -- and the loser of a heal race would keep a flag
    //     learned from an engine that no longer exists.
    //
    // The down-then-up transition is the ONLY evidence of a new process we
    // have: `EngineProbe` carries `loaded`/`modelId`/`progress`/`state` but no
    // pid and no start time, so a bare `attached` cannot distinguish "a
    // replacement" from "the same engine, still alive, that merely failed one
    // request". A boot-time `attached` is likewise not a change: nothing has
    // been learned about that engine yet.
    if (state.kind === 'spawned' || (opts?.afterFailure === true && state.kind === 'attached')) {
      this.engineChanges += 1;
      this.residency.noteEngineChanged();
    }
    return true;
  }

  /** Times a new engine has been detected (#826). Exposed because "we decided
   *  the engine was replaced" is otherwise unobservable, and deciding it
   *  wrongly is the failure this path has to be held to. */
  get engineChangeCount(): number {
    return this.engineChanges;
  }

  /**
   * Make sure the configured model is on disk, fetching it if it is not.
   *
   * Owner decision 2026-07-26: "if we don't have the model locally we pull it;
   * if the model is in, there would not be a reason to pull."
   *
   * Without this the model still arrives — the engine downloads it implicitly
   * on the first `preload`/`generate` — but that means a fresh install's FIRST
   * permission blocks on a silent multi-GB fetch. Doing it deliberately at boot
   * makes it a visible, progress-reporting pull instead, and by the time a
   * permission arrives the weights are already there.
   *
   * The "already present" half is cheap and doubly guarded: `pullModel` returns
   * immediately when the inventory reports the model cached, and the engine's
   * own `requestDownload` no-ops on a cached/loaded row. Concurrent pulls
   * across daemons collapse onto one download engine-side, so ten daemons
   * calling this produce one fetch.
   *
   * NOT awaited by the caller: a cold pull is minutes, and the daemon must be
   * serving long before that. Evaluations escalate meanwhile, which is the safe
   * direction.
   */
  async ensureModelPresent(): Promise<void> {
    // Only when remi owns the engine. On a shared (super-yooz) host, what is on
    // disk is the host's business -- the same boundary that stops the residency
    // timer touching a shared engine's weights (#818).
    if (!this.providerIsYooz || !this.ownsEngine) return;
    const model = this.llmConfig.model;
    if (model.length === 0) return;

    try {
      await pullModel(this.llmConfig.baseUrl, model, {
        onProgress: (p) => {
          // Report SIZE and elapsed, never a bare percentage: the engine's
          // download fraction is flat for the whole multi-GB transfer (the
          // weights file is staged outside the hub dir and moved in at the
          // end), so a percentage would sit at ~0.6% and read as stuck.
          this.logFn(`[AutoApprove] Fetching ${model}: ${describePullProgress(p)}`);
        },
      });
    } catch (err) {
      // Never fatal. A missing model means evaluations escalate, which is the
      // behavior without this method at all.
      this.logFn(
        `[AutoApprove] Could not fetch ${model} (auto-approve will escalate until it is present): ${errorToString(err)}`,
      );
    }
  }

  /**
   * Repair, but ONLY when the engine is genuinely unreachable.
   *
   * `evaluate()`'s catch wraps the whole evaluation, including response
   * parsing — so an unparsable reply from a perfectly healthy engine reaches
   * the heal path exactly like a dead socket does. Without this probe, one bad
   * LLM response would be treated as "a new engine appeared" and would clear
   * `cacheUnsupported` against the very same process that already told us its
   * clear-cache route is missing, re-arming the doomed request and the log line
   * the degrade exists to stop.
   *
   * Probing first also makes the down-then-up transition a real precondition
   * rather than an assumption, which is what licenses `afterFailure` below.
   */
  private async repairIfUnreachable(): Promise<boolean> {
    // Through the host's seam, not the module-level `probeEngine`: the host
    // already owns an injectable probe, and bypassing it made this path do a
    // real network connect (with a real timeout) inside unit tests.
    const host = this.engineHost;
    const reachable = host === undefined ? false : await host.probeOnce();
    // Reachable => the process never went anywhere; the failure was about this
    // request, not about the engine. Nothing to repair, nothing new to learn.
    if (reachable) return true;
    return await this.ensureEngine({ afterFailure: true });
  }

  /**
   * Fire-and-forget repair after a failed evaluation. Single-flight: a burst of
   * failures (every queued permission failing against the same dead engine)
   * must produce ONE repair attempt, not one per question — `ensureRunning`
   * waits up to 30s for a spawned helper to bind, so an unguarded call per
   * failure would pile up dozens of overlapping waits.
   */
  private healEngine(): void {
    if (this.engineHost === undefined || this.healInFlight !== null) return;
    this.healInFlight = this.repairIfUnreachable()
      .catch((err) => {
        this.logFn(`[AutoApprove] Engine self-heal failed: ${errorToString(err)}`);
        return false;
      })
      .then(() => {
        this.healInFlight = null;
      });
  }

  /**
   * Acquire the single eval slot, serializing concurrent LLM evaluations (one
   * GPU). Resolves `'acquired'` when the slot is held; `'timeout'` if the wait
   * exceeded `deadlineMs` (the caller then escalates gracefully rather than
   * risking the ~600s hook budget); `'drained'` if force-release (#617) dropped
   * the waiter. When the slot is free it is taken immediately; otherwise the
   * caller is queued FIFO and granted by `releaseSlot`. `evalId` tags the waiter
   * so a per-question cancel can drop it while still queued; `scope` (#730)
   * and `isSubagent` let `drainScope` drop it (or spare it, mainOnly) without
   * touching a sibling session's queue.
   */
  private acquireSlot(
    deadlineMs: number,
    scope: string,
    evalId: number | undefined,
    isSubagent: boolean,
  ): Promise<SlotOutcome> {
    if (!this.evalActive) {
      this.evalActive = true;
      return Promise.resolve('acquired');
    }
    return new Promise<SlotOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      // One-shot settle: grant / deny / timeout can race (e.g. drainQueue vs the
      // deadline timer); the first wins and the rest are inert.
      let settled = false;
      const settle = (outcome: SlotOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(outcome);
      };
      const waiter = {
        scope,
        evalId,
        isSubagent,
        grant: () => settle('acquired'),
        // Accepts which 'drained' flavor happened (#730): the global
        // `drainQueue` (forceRelease) vs. the scoped `drainScope`
        // (cancelStale) produce DIFFERENT escalation reasoning below, so a
        // log reader is never told "remi unstick" for a plain session
        // teardown.
        deny: (outcome: 'drained' | 'drained-scope') => settle(outcome),
      };
      this.evalQueue.push(waiter);
      if (deadlineMs > 0) {
        timer = setTimeout(() => {
          const i = this.evalQueue.indexOf(waiter);
          if (i !== -1) this.evalQueue.splice(i, 1);
          settle('timeout');
        }, deadlineMs);
      }
    });
  }

  /**
   * Release the eval slot. Hands it to the next FIFO waiter (the slot stays
   * active, just changes owner) or marks the evaluator idle when none wait.
   */
  private releaseSlot(): void {
    const next = this.evalQueue.shift();
    if (next) {
      next.grant();
    } else {
      this.evalActive = false;
    }
  }

  /**
   * Drain every queued waiter, resolving each as NOT acquired so its eval takes
   * the graceful escalate path instead of running on the GPU (#617 force-release).
   * Does NOT touch the eval currently holding the slot — `cancel()` aborts that.
   * Returns the number of waiters drained. Called synchronously right after
   * `cancel()` in `forceRelease`, so the aborted eval's `releaseSlot` (a later
   * microtask) cannot hand the slot to a waiter before they are all drained.
   */
  drainQueue(): number {
    let drained = 0;
    for (let next = this.evalQueue.shift(); next; next = this.evalQueue.shift()) {
      next.deny('drained');
      drained++;
    }
    return drained;
  }

  /**
   * Drain queued waiters belonging to `scope` (#730), resolving each as NOT
   * acquired so its eval takes the graceful escalate path instead of
   * eventually being promoted to the GPU for permission work `cancelStale`
   * has already decided is moot (session ended, or a mainOnly Stop). Unlike
   * `drainQueue` (the global `forceRelease`/`remi unstick` escape hatch) this
   * never touches a sibling session's queue. `opts.mainOnly` additionally
   * SPARES a subagent/team-member waiter — mirrors how `AutoApproveGate.
   * cancelStale('Stop', {mainOnly:true})` already spares a subagent's RUNNING
   * eval via `evalIsSubagentById`, so a lead's Stop can never starve a
   * teammate's still-legitimate queued eval. Does NOT touch the eval
   * currently holding the slot — `cancel()` targets that. Returns the number
   * of waiters drained.
   */
  drainScope(scope: string, opts?: { mainOnly?: boolean }): number {
    const mainOnly = opts?.mainOnly ?? false;
    let drained = 0;
    for (let i = this.evalQueue.length - 1; i >= 0; i--) {
      const waiter = this.evalQueue[i];
      if (!waiter || waiter.scope !== scope) continue;
      if (mainOnly && waiter.isSubagent) continue;
      this.evalQueue.splice(i, 1);
      waiter.deny('drained-scope');
      drained++;
    }
    return drained;
  }

  /** Whether the lazy first-eval warm has been kicked off (#818 advisory). */
  private warmDispatched = false;

  /**
   * Warm-load the escalate_model so the FIRST second opinion does not pay a
   * cold model-load (15s+ for a 35B). Yooz engine only (`POST
   * /v1/llm/preload?wait=true`); a no-op otherwise (e.g. an OpenAI-compatible
   * provider, which has no equivalent preload route) or when no escalate_model
   * is configured. Best-effort and never throws — a failed warm just means the
   * first real consult loads the model itself.
   */
  async warmEscalateModel(): Promise<void> {
    if (!this.escalateModel || !this.providerIsYooz) return;
    // Counted as in-flight work (#827) even though it is not an evaluation: on
    // a cold machine this is a multi-GB HuggingFace pull, and a ~20 GB model on
    // a slow link can outlast `cache_idle` (300s) or even `keep_alive` (1800s).
    // Uncounted, the idle timer would then call `unload` on a model that is
    // still downloading. First-boot-only and low probability, but the counter
    // already expresses exactly this rule, so there is no reason to leave it
    // outside.
    this.residency.beginEval();
    try {
      await warmModel(this.llmConfig.baseUrl, this.escalateModel);
      this.logFn(`[AutoApprove] Warmed escalate_model ${this.escalateModel} (preloaded)`);
    } catch (err) {
      this.logFn(
        `[AutoApprove] escalate_model warm-up failed (will load on first consult): ${errorToString(err)}`,
      );
    } finally {
      this.residency.endEval();
    }
  }

  /**
   * Evaluate a permission request. Never throws.
   * On any error, returns escalate so the user gets the question as normal.
   *
   * @param toolName Name of the Claude Code tool (Bash, Edit, etc.)
   * @param toolInput Raw tool input from the PermissionRequest hook
   * @param tag Optional short tag (e.g. sessionId prefix) to include in logs
   *            so multi-session deployments can distinguish whose decision this is.
   * @param permissionSuggestions Optional `permission_suggestions` from the
   *            hook. When present and shape qualifies as multi-choice (#399),
   *            evaluation is routed through the multi-choice path instead of
   *            the binary approve/deny path.
   * @param scope #730: the caller's own scope (an `AutoApproveGate`'s
   *            sessionId), so this shared daemon-wide service can isolate
   *            concurrent sessions — `cancel()`/`drainScope()` can then act
   *            on exactly this session's eval without risk of hitting a
   *            different session's. Omitted callers (direct-service unit
   *            tests) implicitly share `DEFAULT_SCOPE`.
   * @param isSubagent #730: tags this eval as belonging to a subagent/team-
   *            member permission (mirrors the gate's own `evalIsSubagentById`),
   *            so a QUEUED waiter for it can be spared by
   *            `drainScope(scope, {mainOnly: true})`.
   * @param authority Optional recent-human-turns summary (Q9, #893; see
   *            `authority.ts`). Passed straight to `buildPrompt` as the
   *            CONVERSATION CONTEXT block. When present, an `approve` verdict
   *            is re-checked by `enforceAuthorityBoundary` against a hardcoded
   *            catastrophic-pattern list AFTER the LLM decides — the code-level
   *            trust boundary that holds regardless of what the model's
   *            reasoning said, so authority text can lower escalation for a
   *            benign operation but can never approve a DENY-FLOOR-shaped one.
   */
  async evaluate(
    toolName: string,
    toolInput: Record<string, unknown>,
    tag?: string,
    permissionSuggestions?: readonly unknown[],
    modelOverride?: string,
    evalId?: number,
    scope?: string,
    isSubagent?: boolean,
    authority?: string,
  ): Promise<AutoApproveResult> {
    const start = Date.now();
    // #820: push the idle-unload deadline out. Called at the START so a long
    // eval cannot have the model unloaded out from under it, and again when it
    // settles so the window measures from the LAST activity.
    this.residency.noteActivity();
    // #818 advisory: warm the heavy escalate_model on the FIRST evaluation
    // rather than at daemon boot, so a session that never sees a permission
    // never pulls ~20 GB resident. Fire-and-forget: it must not delay this
    // decision, and it still lands long before a typical escalation.
    if (!this.warmDispatched) {
      this.warmDispatched = true;
      void this.warmEscalateModel();
    }
    // modelOverride (#522: the escalate_model second opinion) replaces the base
    // model for this call; the fast-path deny/allow/group checks below still run.
    const baseModel = modelOverride || this.llmConfig.model;
    const model = baseModel;
    const prefix = tag ? `[AutoApprove ${tag}]` : '[AutoApprove]';
    const resolvedScope = scope ?? DEFAULT_SCOPE;

    const normalisedSuggestions = Array.isArray(permissionSuggestions)
      ? permissionSuggestions
          .map((s) => normalisePermissionSuggestion(s))
          .filter((s): s is string => s !== null)
      : undefined;

    // Entire body wrapped in try/catch so the "never throws" contract holds
    // even if the matchers or other sync code fail (e.g. malformed config).
    try {
      // Deny list + deny groups: checked first, always win. No LLM call.
      const denyMatch = matchSubstringPattern(toolName, toolInput, this.deny);
      if (denyMatch !== null) {
        const reasoning = `deny-matched pattern: "${denyMatch}"`;
        this.logFn(`${prefix} DENIED ${toolName}: ${reasoning} (0ms)`);
        return { decision: 'deny', reasoning, durationMs: 0, model };
      }
      // BROAD, not precise (#1001, ADR 0010). `matchGroups` requires the WHOLE
      // command to be covered and is right for the allow question below; asking
      // it a deny question meant `mkdir /tmp/x && ls -la` defeated a
      // `deny_groups = ["fs-write"]` that stopped the bare `mkdir`.
      const denyGroupMatch = matchGroupsBroad(toolName, toolInput, this.denyGroups);
      if (denyGroupMatch !== null) {
        const reasoning = `deny-matched group: "${denyGroupMatch}"`;
        this.logFn(`${prefix} DENIED ${toolName}: ${reasoning} (0ms)`);
        return { decision: 'deny', reasoning, durationMs: 0, model };
      }

      // Allow list + approve groups: bypass the LLM for known-safe operations.
      const allowMatch = matchAllowPattern(toolName, toolInput, this.allow);
      if (allowMatch !== null) {
        const reasoning = `allow-matched pattern: "${allowMatch}"`;
        if (this.logDecisions) {
          this.logFn(`${prefix} ${toolName}: approve (0ms) - ${reasoning}`);
        }
        return { decision: 'approve', reasoning, durationMs: 0, model };
      }
      const approveGroupMatch = matchGroups(toolName, toolInput, this.approveGroups);
      if (approveGroupMatch !== null) {
        const reasoning = `approve-matched group: "${approveGroupMatch}"`;
        if (this.logDecisions) {
          this.logFn(`${prefix} ${toolName}: approve (0ms) - ${reasoning}`);
        }
        return { decision: 'approve', reasoning, durationMs: 0, model };
      }

      // Design / plan-mode / long-form questions are never auto-decided by the
      // LLM (#572): AskUserQuestion, ExitPlanMode, or any tool that structurally
      // poses a non-binary question. Runs AFTER the deny/allow/group checks
      // (those are deterministic, explicit user rules and intentionally win),
      // but BEFORE the queue and the LLM, so it costs zero latency, takes no
      // eval-queue slot, and never triggers the escalate_model second opinion.
      // Logged unconditionally (like the deny branches): a structural router
      // that bypasses the LLM must be traceable even when log_decisions is off.
      if (isDesignQuestion(toolName, toolInput, permissionSuggestions, this.alwaysEscalateTools)) {
        const reasoning = `always-escalate (design/plan/long-form), tool=${toolName}; never auto-decided by LLM`;
        this.logFn(`${prefix} ${toolName}: escalate (0ms) - ${reasoning}`);
        return { decision: 'escalate', reasoning, durationMs: 0, model };
      }

      const isMultiChoice = isMultiChoicePermission(toolName, permissionSuggestions);

      // Multi-choice + skip mode: never call the LLM. The binary approve/
      // deny mapping cannot express "pick option 2 of N", so evaluating
      // would just produce option-1 (approve) for every plan-mode prompt
      // regardless of what the user actually wanted (#399).
      if (isMultiChoice && this.multichoiceMode === 'skip') {
        const reasoning = `multi-choice prompt (tool=${toolName}, ${permissionSuggestions?.length ?? 0} options); auto_approve.multichoice = "skip"`;
        if (this.logDecisions) {
          this.logFn(`${prefix} ${toolName}: escalate (0ms) - ${reasoning}`);
        }
        return { decision: 'escalate', reasoning, durationMs: 0, model };
      }

      // Index-mismatch guard: when normalisation dropped one or more raw
      // entries (empty object, Map/Set serialising to "{}", null, etc.),
      // the LLM's pick-index would address the normalised list while
      // inject() sends that index to the PTY, which interprets it against
      // the original positions. Different orderings mean a "pick No"
      // decision could land on a different option in the terminal. Escalate
      // instead of risk silently injecting the wrong choice.
      if (
        isMultiChoice &&
        this.multichoiceMode === 'evaluate' &&
        Array.isArray(permissionSuggestions) &&
        normalisedSuggestions !== undefined &&
        normalisedSuggestions.length !== permissionSuggestions.length
      ) {
        const dropped = permissionSuggestions.length - normalisedSuggestions.length;
        const reasoning = `permission_suggestions had ${dropped} unreadable entries (length ${permissionSuggestions.length} -> ${normalisedSuggestions.length}); cannot safely map LLM pick to PTY index`;
        this.logFn(`${prefix} ${toolName}: escalate (0ms) - ${reasoning}`);
        return { decision: 'escalate', reasoning, durationMs: 0, model };
      }

      // Serialize concurrent evals (#551): one LLM call at a time (one GPU).
      // A second request QUEUES instead of escalating-on-busy; only a request
      // that waits past queue_timeout escalates gracefully so a deep burst
      // (parallel subagents) never risks the ~600s hook budget.
      const slot = await this.acquireSlot(
        this.queueTimeoutMs,
        resolvedScope,
        evalId,
        isSubagent ?? false,
      );
      if (slot !== 'acquired') {
        const durationMs = Date.now() - start;
        // #730: 'drained-scope' (cancelStale) gets its OWN reasoning, distinct
        // from 'drained' (force-release/remi unstick) and from a per-question
        // answered-while-queued cancel — a log reader must never be told
        // "remi unstick" for a plain session teardown or Stop.
        const reasoning =
          slot === 'drained'
            ? 'force-released (remi unstick) before slot acquisition; escalating to user'
            : slot === 'drained-scope'
              ? 'session queue drained (cancelStale) before slot acquisition; escalating to user'
              : `eval queue wait exceeded ${this.queueTimeoutMs}ms; escalating to user`;
        this.logFn(`${prefix} ${toolName}: escalate (${durationMs}ms) - ${reasoning}`);
        return { decision: 'escalate', reasoning, durationMs, model };
      }

      this.currentAbortController = new AbortController();
      this.currentScope = resolvedScope;
      this.currentEvalId = evalId ?? null;
      const externalSignal = this.currentAbortController.signal;
      // The heavy escalate_model gets its dedicated (longer) budget when set, so
      // a cold model-load does not abort the fast model's shorter timeout.
      const isEscalateModelCall =
        modelOverride !== undefined && modelOverride === this.escalateModel;
      const timeoutMs =
        isEscalateModelCall && this.escalateTimeoutMs > 0
          ? this.escalateTimeoutMs
          : this.llmConfig.timeoutMs;
      // Hold the race timer handle so we can clear it whichever side wins.
      // Without clearTimeout, a successful chatCompletion at t=200ms would
      // leave a timer scheduled at t=timeoutMs that fires on the NEXT eval
      // and aborts a healthy call (currentAbortController is shared instance
      // state).
      let raceTimer: ReturnType<typeof setTimeout> | null = null;
      // #827: the evaluation is now genuinely in flight on the engine. Marking
      // it HERE rather than at `evaluate()` entry also takes the queue wait out
      // of the idle arithmetic -- the window now measures from when the LLM
      // actually started, not from when we joined the queue. Paired with
      // `endEval()` in the `finally` immediately below; nothing runs between
      // this statement and the `try`, so the pairing cannot be skipped.
      this.residency.beginEval();
      try {
        // Multi-choice + evaluate mode: dedicated prompt, optional alt model.
        // Otherwise the binary approve/deny prompt.
        const useMultiChoice = isMultiChoice && this.multichoiceMode === 'evaluate';
        const callModel =
          useMultiChoice && this.multichoiceModel ? this.multichoiceModel : baseModel;
        // Reuse the base config only when neither the model nor the timeout
        // differs; the escalate_model path overrides both.
        const callConfig: LLMClientConfig =
          callModel === this.llmConfig.model && timeoutMs === this.llmConfig.timeoutMs
            ? this.llmConfig
            : { ...this.llmConfig, model: callModel, timeoutMs };
        const messages = useMultiChoice
          ? buildMultiChoicePrompt(
              toolName,
              toolInput,
              normalisedSuggestions ?? [],
              this.instructions,
            )
          : buildPrompt(toolName, toolInput, this.instructions, authority, this.level);
        // Hard kill via Promise.race: even if fetch ignores the abort signal
        // (provider hang, Bun runtime quirk), evaluate() returns within
        // timeoutMs. The race timer also calls abort() so a fetch that does
        // honor the signal releases socket resources promptly.
        const response = await Promise.race([
          chatCompletion(callConfig, messages, externalSignal),
          new Promise<never>((_, reject) => {
            raceTimer = setTimeout(() => {
              this.currentAbortController?.abort();
              reject(new DOMException(`Hard kill after ${timeoutMs}ms`, 'AbortError'));
            }, timeoutMs);
          }),
        ]);
        const durationMs = Date.now() - start;

        let result: AutoApproveResult = useMultiChoice
          ? (() => {
              const parsedMc = parseMultiChoiceDecision(
                response.content,
                normalisedSuggestions?.length ?? 0,
              );
              if (parsedMc.decision === 'pick') {
                return {
                  decision: 'pick' as const,
                  pickIndex: parsedMc.index,
                  reasoning: parsedMc.reasoning,
                  durationMs,
                  model: response.model,
                };
              }
              return {
                decision: 'escalate' as const,
                reasoning: parsedMc.reasoning,
                durationMs,
                model: response.model,
              };
            })()
          : (() => {
              const parsed = parseDecision(response.content);
              return {
                decision: parsed.decision,
                reasoning: parsed.reasoning,
                durationMs,
                model: response.model,
                // #628: carry the model's lock-screen summary ON ESCALATE ONLY,
                // enforced here (not just by the gate) so approve/deny results never
                // expose a stray summary a model may have tacked on.
                ...(parsed.decision === 'escalate' && parsed.summary
                  ? { summary: parsed.summary }
                  : {}),
              };
            })();

        // Q9 (#893) trust boundary: a binary (non-multichoice) 'approve' verdict
        // reached with an authority block in the prompt is re-checked here,
        // deliberately AFTER parsing and with no access to `parsed.reasoning` --
        // the whole point is that this check cannot be talked into skipping
        // itself by whatever the model's own reasoning says. Only ever
        // downgrades approve -> escalate; never touches deny/escalate/pick.
        // #953 DENY FLOOR: the prompt's "deny ONLY DENY-FLOOR operations;
        // everything else you would not approve must ESCALATE, never deny"
        // rule, enforced in code instead of by instruction. A `deny` is
        // SILENT -- the gate returns 'deny' to the hook and pushes no card --
        // so an over-eager deny takes the human out of a decision that was
        // explicitly routed to them. Measured at 10 of 12 escalate-expected
        // operations before this guard (see `deny-floor.ts`).
        //
        // Runs BEFORE the authority boundary below purely for readability;
        // the two are disjoint by construction (this one only ever sees
        // `deny`, that one only ever sees `approve`), so the order carries no
        // behavioral meaning and neither can observe the other's output.
        //
        // Config deny/deny_groups matches never reach here -- they return
        // early, above, without calling the LLM. This applies to
        // MODEL-produced denies only.
        if (!useMultiChoice && result.decision === 'deny') {
          const floored = enforceDenyFloor(toolName, toolInput, result.decision);
          if (floored.overridden) {
            const original = result;
            result = {
              decision: 'escalate',
              reasoning: `Deny floor (#953): model denied an operation matching no DENY FLOOR pattern, so it is escalated for you to answer rather than blocked silently. Original model reasoning: ${original.reasoning}`,
              durationMs,
              model: original.model,
              summary: 'Allow this command to run?',
            };
            this.logFn(
              `${prefix} DENY FLOOR ${toolName}: deny -> escalate (no catastrophic pattern) (${durationMs}ms)`,
            );
          }
        }

        const authorityPresent = (authority?.trim().length ?? 0) > 0;
        if (!useMultiChoice && authorityPresent && result.decision === 'approve') {
          const guarded = enforceAuthorityBoundary(toolName, toolInput, result.decision, true);
          if (guarded.overridden) {
            const original = result;
            result = {
              decision: 'escalate',
              reasoning: `Trust boundary (#893): authority-influenced approve blocked, matched DENY FLOOR pattern "${guarded.matchedPattern}". Original model reasoning: ${original.reasoning}`,
              durationMs,
              model: original.model,
              summary: 'Review this command before it runs?',
            };
            this.logFn(
              `${prefix} TRUST BOUNDARY ${toolName}: approve -> escalate (matched "${guarded.matchedPattern}") (${durationMs}ms)`,
            );
          }
        }

        // #976 RISK CEILING: the "must escalate, never approve, unless the
        // user's own config says otherwise" rule, enforced in code instead of
        // by instruction -- the DENY FLOOR's mirror image (see
        // `risk-ceiling.ts`'s module doc). Runs unconditionally on any
        // `approve`, NOT gated on `authorityPresent` like the trust boundary
        // above: `classifyRisk` is a property of the operation, not of
        // whether the prompt happened to carry authority text, and an
        // authority-free approve of a high-risk operation was previously
        // unguarded by anything (verified: `enforceDenyFloor` only ever sees
        // `deny`; the trust boundary and the #954 counterfactual below both
        // require `authorityPresent`).
        //
        // Placed AFTER the trust boundary so a downgrade already applied
        // above short-circuits this one (decision is no longer 'approve');
        // placed BEFORE the counterfactual so that when THIS guard fires, the
        // counterfactual's own `result.decision === 'approve'` guard is
        // already false and the second LLM call is skipped structurally --
        // there is no approve left to re-check.
        if (!useMultiChoice && result.decision === 'approve') {
          const ceilinged = enforceRiskCeiling(toolName, toolInput, result.decision);
          if (ceilinged.overridden) {
            const original = result;
            result = {
              decision: 'escalate',
              reasoning: `Risk ceiling (#976): model approved a ${ceilinged.band}-risk operation, which may not be auto-approved by the model regardless of stated reasoning or conversation instructions -- only a deterministic allow/approve_groups match can. Original model reasoning: ${original.reasoning}`,
              durationMs,
              model: original.model,
              summary: 'Approve this high-risk command?',
            };
            this.logFn(
              `${prefix} RISK CEILING ${toolName}: approve -> escalate (band=${ceilinged.band}) (${durationMs}ms)`,
            );
          }
        }

        // #954 COUNTERFACTUAL: the authority trust boundary, enforced by
        // re-asking rather than by pattern.
        //
        // `enforceAuthorityBoundary` above checks eight catastrophic
        // substrings and caught NONE of the measured failure: `rm -rf ./build`
        // went from `deny` (no authority) to `approve` (authority) 5 runs out
        // of 5, on nothing stronger than "please clean out the build
        // directory, it is stale". Widening that substring list does not
        // scale -- the rule it backstops covers "remote, destructive,
        // unfamiliar, or irreversible", which is not a substring set.
        //
        // So instead of asking WHETHER authority should have approved this,
        // ask whether it DECIDED it: run the same evaluation with the
        // authority block removed. If the answer changes, the conversation
        // text was the deciding factor, which the prompt-level rule forbids.
        //
        // Runs INLINE rather than via a nested `evaluate()` call: that would
        // re-enter `acquireSlot` while still holding this eval's slot, and
        // deadlock on a single-slot pool.
        if (
          !useMultiChoice &&
          result.decision === 'approve' &&
          shouldCounterfactual(toolName, toolInput, result.decision, authorityPresent)
        ) {
          const cfStart = Date.now();
          try {
            const cfResponse = await chatCompletion(
              { ...this.llmConfig, model },
              // Same prompt, same instructions, authority block OMITTED.
              // Same level, same instructions -- ONLY the authority block differs,
              // which is what makes the comparison a counterfactual rather than
              // a different question (#954).
              buildPrompt(toolName, toolInput, this.instructions, undefined, this.level),
              this.currentAbortController?.signal,
            );
            const cfParsed = parseDecision(cfResponse.content);
            const reconciled = reconcileCounterfactual(cfParsed.decision);
            if (reconciled.overridden) {
              const original = result;
              result = {
                decision: 'escalate',
                reasoning: `Authority counterfactual (#954): the same operation evaluated to "${cfParsed.decision}" WITHOUT the conversation-context block, so that text decided the outcome rather than merely resolving ambiguity. Escalating instead. Authority-free reasoning: ${cfParsed.reasoning} | Original: ${original.reasoning}`,
                durationMs,
                model: original.model,
                summary: 'Approve this? (the chat, not you, allowed it)',
              };
              this.logFn(
                `${prefix} COUNTERFACTUAL ${toolName}: approve -> escalate (authority-free verdict was ${cfParsed.decision}) (+${Date.now() - cfStart}ms)`,
              );
            }
          } catch (err) {
            // The counterfactual is a SAFETY check, so failing to run it must
            // not leave the authority-influenced approve standing. Escalate --
            // the same direction every other failure in this module takes.
            result = {
              decision: 'escalate',
              reasoning: `Authority counterfactual (#954) could not be evaluated (${errorToString(err)}); escalating rather than trusting an authority-influenced approve. Original: ${result.reasoning}`,
              durationMs,
              model: result.model,
              summary: 'Approve this? (safety check unavailable)',
            };
            this.logFn(
              `${prefix} COUNTERFACTUAL ${toolName}: check failed, escalating - ${errorToString(err)}`,
            );
          }
        }

        if (this.logDecisions) {
          const denyPrefix = result.decision === 'deny' ? `${prefix} DENIED` : prefix;
          // #976 instrumentation. The matrix's WIDENING half is only worth
          // building if a meaningful share of final escalates are
          // (band=moderate + authority present) -- that is the sole population
          // a text-derived grade could decide, since critical never approves
          // and high needs a witness text cannot supply. Nobody has counted it.
          //
          // Emitted on every decision rather than only on escalates so the
          // denominator is visible too: "12% of escalates are eligible" means
          // nothing without knowing how many escalates there were.
          this.logFn(
            `${denyPrefix} ${toolName}: ${result.decision} (${durationMs}ms) ${formatMatrixContext(
              classifyRisk(toolName, toolInput),
              authorityPresent,
            )} - ${result.reasoning}`,
          );
        }

        // Clear cancelReason on success so a cancel() that raced with the
        // resolved response (set the flag, but the success path won the
        // microtask race) cannot leak into the NEXT eval's catch block and
        // turn a real timeout into a phantom 'cancelled'. The catch path
        // does its own read-and-clear.
        this.cancelReason = null;
        return result;
      } finally {
        if (raceTimer !== null) clearTimeout(raceTimer);
        this.currentAbortController = null;
        this.currentScope = null;
        this.currentEvalId = null;
        this.releaseSlot();
        // #820: re-arm from the END of the eval, so the idle window measures
        // silence rather than "time since we started thinking". #827: also
        // drops the in-flight count, releasing both stages to act again.
        this.residency.endEval();
      }
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = errorToString(err);
      // Bun's fetch can throw plain Error or wrap a TypeError on abort, not
      // always DOMException. Detect by the conventional `name === 'AbortError'`
      // on the error or its `cause` so the signal-shape choice in any runtime
      // routes through the cancel/timeout branch instead of the generic
      // 'Error: ...' escalate. Without this, the stale-decision regression
      // (#387) silently re-occurs on Bun.
      const errName = (err as { name?: unknown } | null)?.name;
      const causeName = (err as { cause?: { name?: unknown } } | null)?.cause?.name;
      const isAbort = errName === 'AbortError' || causeName === 'AbortError';
      // cancelReason is set ONLY by cancel(); a timeout abort leaves it null.
      // Read-and-clear so the next eval starts fresh.
      const cancelledReason = this.cancelReason;
      this.cancelReason = null;

      if (isAbort && cancelledReason !== null) {
        const reasoning = `Cancelled: ${cancelledReason}`;
        this.logFn(`${prefix} CANCELLED ${toolName}: ${reasoning} (${durationMs}ms)`);
        return { decision: 'cancelled', reasoning, durationMs };
      }

      const reasoning = isAbort ? `LLM timeout after ${durationMs}ms` : `Error: ${errorMsg}`;
      // Always log errors regardless of logDecisions setting
      this.logFn(`${prefix} ERROR ${toolName}: ${reasoning} (${durationMs}ms)`);

      // #818 self-heal, LAZY by design. A daemon started at 09:00 must survive
      // the engine dying at 14:00, and boot-time-only supervision cannot do
      // that. A timeout is excluded: the engine answered, it was just slow, and
      // treating "slow" as "dead" would try to start a second engine against a
      // busy one. Deliberately NOT awaited -- this eval has already escalated,
      // so the repair is for the NEXT one and must not add latency here.
      if (!isAbort) this.healEngine();

      return {
        decision: 'escalate',
        reasoning,
        durationMs,
        model,
      };
    }
  }

  /**
   * Abort an in-flight LLM evaluation. Called by the hook bridge when Claude
   * advances past the prompt (PreToolUse / PostToolUse / Stop / SessionEnd) so a
   * slow LLM call cannot return a stale decision after the user already answered
   * in the local terminal, and by a manual answer to free the GPU (#617).
   *
   * When `evalId` is given, the abort fires ONLY if that id matches the eval
   * currently holding the slot — so a manual answer for question X cancels X's
   * eval and never a different permission's that happens to be running now. If
   * that eval is still QUEUED (answered under contention before it reached the
   * GPU), the queued waiter is dropped instead (it escalates gracefully) so the
   * answer never triggers a now-pointless LLM call. With no `evalId` it aborts
   * whatever is in flight (session teardown / force-release).
   *
   * `scope` (#730): the caller's own scope (an `AutoApproveGate`'s sessionId).
   * When given, an abort of the RUNNING eval fires ONLY if it ALSO belongs to
   * that scope — this is what stops one session's SessionEnd (or a stale
   * per-question cancel) from ever aborting a DIFFERENT session's eval just
   * because it happens to be the one holding the single daemon-wide slot
   * (`evalId` alone cannot tell — it is only unique per-gate, so two sessions
   * can legitimately stamp the same number). A QUEUED waiter is likewise only
   * dropped by `evalId` when its own `scope` also matches. Omitting `scope`
   * skips this check entirely (matches ANY scope) — reserved for
   * `forceRelease` (`remi unstick`), the one caller that is DELIBERATELY
   * global; every per-session caller (`cancelStale`, `cancelEvalForQuestion`)
   * must pass its own scope.
   *
   * Returns true if a call was actually cancelled (running aborted or queued
   * dropped), false otherwise (idempotent, safe to call always).
   */
  cancel(reason: string, evalId?: number, scope?: string): boolean {
    const scopeMatches = scope === undefined || this.currentScope === scope;
    // The running eval: abort when untargeted (by evalId), or when the target
    // matches — and, when a scope was given, only when it too matches.
    if (
      this.currentAbortController !== null &&
      scopeMatches &&
      (evalId === undefined || this.currentEvalId === evalId)
    ) {
      this.cancelReason = reason;
      this.currentAbortController.abort();
      return true;
    }
    // A targeted eval still waiting for the slot: drop it so it escalates
    // instead of running after its question was already answered (#617).
    // Scope-filtered the same way when given (#730).
    if (evalId !== undefined) {
      const i = this.evalQueue.findIndex(
        (w) => w.evalId === evalId && (scope === undefined || w.scope === scope),
      );
      if (i !== -1) {
        const waiter = this.evalQueue.splice(i, 1)[0];
        // Same 'drained' outcome/reasoning as the global drainQueue (unchanged
        // from before #730): this is the #617 answered-while-queued path, not
        // a scoped cancelStale drain.
        waiter?.deny('drained');
        return true;
      }
    }
    return false;
  }
}

/** Outcome of an `acquireSlot` request: the eval ran, timed out waiting, was
 *  dropped by force-release / a per-question cancel (#617, 'drained'), or was
 *  dropped by a scoped `drainScope` (#730, 'drained-scope') — kept distinct
 *  from 'drained' so the escalation reasoning never misattributes a plain
 *  session teardown to `remi unstick`. */
type SlotOutcome = 'acquired' | 'timeout' | 'drained' | 'drained-scope';
