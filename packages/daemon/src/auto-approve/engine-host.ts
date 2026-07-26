/**
 * Engine ownership and supervision (#818).
 *
 * remi's auto-approve evaluator needs a Yooz engine answering on its reserved
 * loopback port (19924). PR #811 made remi speak to one but left the question
 * of who STARTS it unanswered, which meant that on a machine with no engine —
 * the normal state today — auto-approve silently degraded to escalating every
 * permission with no explanation anywhere.
 *
 * Two modes, and they are opposites. Getting this boundary wrong is the whole
 * risk in this file:
 *
 *   OWNED (standalone, the default and the only mode that exists today):
 *     remi spawns its own helper, supervises it, and may freely load, unload
 *     and delete models. The helper dies with its owner.
 *
 *   SHARED (a super-yooz host centralizing weights, later):
 *     the host owns the process. remi MUST NOT spawn, MUST NOT unload (another
 *     module may be mid-generate on the same weights), and MUST NOT delete.
 *     It reads and evaluates, nothing more.
 *
 * remi keeps its dedicated port (19924) in BOTH modes — coexistence with a
 * super-yooz host on 19920 is by port isolation, never by retargeting. So the
 * mode changes who owns the process and the residency policy, not the address
 * (owner decision, 2026-07-25).
 *
 * Ownership WITHIN remi: one engine per MACHINE, and it is an INDEPENDENT
 * process — a peer of the hub, never a child of a session daemon.
 *
 * The rule is: **ownership is about who STARTS it, not who holds it.**
 *   - If an engine is already answering, attach. It does not matter who
 *     started it — a hub, another session, or the user by hand.
 *   - If nothing is answering, the first process that needs one starts it
 *     DETACHED (`detached: true` + `unref()`, exactly how `daemon-manager.ts`
 *     launches the hub) and records `~/.remi/engine.pid`. In practice the hub
 *     usually wins that race by construction, because it starts at login from
 *     the LaunchAgent — but a hub is not REQUIRED, so a standalone
 *     `remi --daemon` on a machine with no hub still gets auto-approve.
 *   - Nobody kills it on their own exit. A session daemon that spawned the
 *     engine and then quit must not take auto-approve down for every other
 *     session — that is the whole reason it is detached.
 *
 * The expensive resource is the WEIGHTS, not the process, and `keep_alive`
 * (#820) already evicts those after idle. So a long-lived, cheap, idle engine
 * process plus aggressive weight eviction is the right shape; reaping the
 * process itself is not worth the coordination.
 *
 * The pidfile is a BEST-EFFORT start-race guard, not the guarantee: created
 * O_EXCL, so of two daemons booting simultaneously one normally spawns and the
 * other waits and attaches. It is not an exclusive lock — see
 * `engine-process.ts` for the window that survives, which Node cannot close
 * without an OS advisory lock.
 *
 * **The port is the guarantee.** 19924 admits one listener, so a claimant that
 * slips through the pidfile still fails to bind, and `startEngine` stops a
 * helper that turns out to be redundant. The pidfile exists to keep that case
 * rare and quiet — losing the race noisily is worse than not entering it.
 *
 * That cleanup is deliberately ordered: a redundant helper is stopped only
 * AFTER something else is confirmed to be answering. Killing on the strength of
 * the pidfile alone would bet a running engine against a competitor that has
 * not started one yet, which can leave the machine with none.
 */

import { errorToString } from '@remi/shared';
import { ensureHelperInstalled, resolveHelperPath } from './engine-install.ts';
import { probeEngine } from './engine-models.ts';

/** How remi relates to the engine on its port. */
export type EngineOwnership = 'owned' | 'shared';

export interface EngineHostConfig {
  /** Loopback root, e.g. `http://127.0.0.1:19924`. */
  readonly baseUrl: string;
  /** `owned` (spawn + supervise) or `shared` (read-only guest). */
  readonly ownership: EngineOwnership;
  /**
   * Absolute path to the helper executable to launch in `owned` mode. Absent
   * means remi has no helper to start: it still ATTACHES to an engine already
   * on the port, and otherwise reports the gap instead of failing silently.
   * (The LLM-only variant this should point at is yooz-engine#297.)
   */
  readonly helperPath?: string | undefined;
  /**
   * Where the engine should download weights (`HF_HUB_CACHE`). Empty/absent =
   * the engine's own default. Only reaches an engine remi STARTS — see
   * `AutoApproveConfig.model_cache`.
   */
  readonly modelCache?: string | undefined;
  /** How long to wait for a freshly-spawned helper to answer. */
  readonly startupTimeoutMs?: number;
  /** Interval between readiness probes during startup. */
  readonly probeIntervalMs?: number;
}

export interface EngineHostDeps {
  readonly log: (msg: string) => void;
  /**
   * Spawn seam. The real implementation launches DETACHED and unrefs, so the
   * engine survives this process; it returns only the pid because there is no
   * child handle to hold onto afterwards. Tests supply a fake.
   */
  readonly spawn?: (path: string, env: Record<string, string>) => number;
  /** Kill a pid. Needed on the failure paths: a helper we started that lost
   *  the race, or never bound, must not be left running. */
  readonly kill?: (pid: number) => void;
  readonly probe?: typeof probeEngine;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Pidfile seam (`~/.remi/engine.pid` in production). */
  readonly pidStore?: PidStore;
  /**
   * Helper-acquisition seam (#834). The real one fetches the pinned engine
   * release; an injected one keeps tests off the network. Returns the
   * executable path, or undefined when no helper could be obtained.
   *
   * Injectable for the same reason `spawn` and `probe` are: without it this
   * class reaches the internet during a unit test, which is both slow and a
   * dependency nobody declared.
   */
  readonly installHelper?: () => Promise<string | undefined>;
}

/**
 * The `~/.remi/engine.pid` record. Claiming is EXCLUSIVE: `claim` must fail
 * when a live pid already holds it, and must succeed (after clearing) when the
 * recorded pid is dead — a machine that lost power mid-download should not
 * need manual cleanup.
 */
export interface PidStore {
  /** The recorded pid, or null when absent/stale. */
  read(): number | null;
  /** Take the record for `pid`. False when another LIVE process holds it. */
  claim(pid: number): boolean;
  /** Release the record if it names `pid`. */
  release(pid: number): void;
}

/** What `ensureRunning` concluded, as a value — every outcome is reportable,
 *  because "no engine" must never be silent (#818). */
export type EngineHostState =
  | { readonly kind: 'attached'; readonly ownership: EngineOwnership }
  | { readonly kind: 'spawned'; readonly pid: number }
  | { readonly kind: 'unavailable'; readonly reason: string };

export class EngineHost {
  /** The pid THIS process started, if any. Not a child handle: the engine is
   *  detached and outlives us. */
  private startedPid: number | null = null;
  /** In-flight helper download, so concurrent callers share one fetch. */
  private installInFlight: Promise<string | undefined> | undefined;
  private readonly log: EngineHostDeps['log'];
  private readonly probe: typeof probeEngine;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spawnFn: EngineHostDeps['spawn'];
  private readonly killFn: (pid: number) => void;
  private readonly pids: PidStore | undefined;
  private readonly installFn: () => Promise<string | undefined>;

  constructor(
    private readonly config: EngineHostConfig,
    deps: EngineHostDeps,
  ) {
    this.log = deps.log;
    this.probe = deps.probe ?? probeEngine;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.spawnFn = deps.spawn;
    this.killFn = deps.kill ?? ((pid) => process.kill(pid));
    this.pids = deps.pidStore;
    this.installFn = deps.installHelper ?? (() => ensureHelperInstalled({ log: this.log }));
  }

  /** True when remi may load/unload/delete models on this engine. The single
   *  question every mutating caller should ask (#820's timer, `remi model
   *  unload`/`rm`). */
  get ownsEngine(): boolean {
    return this.config.ownership === 'owned';
  }

  /**
   * One reachability probe through this host's own seam.
   *
   * Exposed so callers that need to ask "is the engine actually down?" reuse
   * the injected probe rather than reaching for the module-level one. A caller
   * that bypasses this seam turns its own unit tests into network calls, with a
   * real connect timeout in the middle of them.
   */
  async probeOnce(): Promise<boolean> {
    return (await this.probe(this.config.baseUrl)).reachable;
  }

  /** The pid this process started, or null when it attached to an existing
   *  engine. NOT "is the engine running" — the engine usually outlives us. */
  get startedByUs(): number | null {
    return this.startedPid;
  }

  /**
   * Make sure an engine is answering, starting one if this remi owns the
   * engine and nothing is there yet.
   *
   * Attach first, always: it does not matter who started the engine, only that
   * one is up. Starting a second would load a second multi-GB copy of the same
   * weights and lose the port race anyway.
   */
  async ensureRunning(): Promise<EngineHostState> {
    const existing = await this.probe(this.config.baseUrl);
    if (existing.reachable) {
      this.log(`[Engine] Attached to the engine on ${this.config.baseUrl}`);
      return { kind: 'attached', ownership: this.config.ownership };
    }

    if (!this.ownsEngine) {
      // A shared host is somebody else's to start. Say so precisely: this is
      // the difference between "misconfigured" and "the host is down".
      const reason = `no engine on ${this.config.baseUrl} and remi is configured as a guest (engine = "shared"), so it will not start one`;
      this.log(`[Engine] ${reason}`);
      return { kind: 'unavailable', reason };
    }

    // Resolve, then acquire. `engine_path` wins when set -- someone pointing at
    // their own build is making a deliberate choice and must not have it
    // second-guessed by a download. Otherwise use the helper remi has already
    // installed, and failing that fetch it once (#834): before this, a fresh
    // install had no helper at all and auto-approve silently escalated
    // everything, which is the gap #818 could describe but not close.
    let helperPath = resolveHelperPath(this.config.helperPath ?? '');
    if (helperPath === undefined) {
      helperPath = await this.installHelper();
    }
    if (helperPath === undefined || helperPath.length === 0) {
      const reason = `no engine on ${this.config.baseUrl} and no helper available to start it`;
      this.log(`[Engine] ${reason}`);
      return { kind: 'unavailable', reason };
    }

    return await this.startEngine(helperPath);
  }

  /**
   * Stop the engine THIS process started. Deliberately NOT called on daemon
   * shutdown: the engine is a machine singleton and other sessions may be
   * using it, so taking it down on our own exit would break them. Exists for
   * an explicit operator teardown only.
   */
  stopStartedEngine(): void {
    const pid = this.startedPid;
    if (pid === null) return;
    // killStarted absorbs a failing kill and logs it, so only claim success
    // when it actually succeeded -- otherwise an operator sees "could not
    // stop pid N" immediately followed by "stopped pid N" for the same pid.
    if (this.killStarted(pid)) this.log(`[Engine] Stopped engine pid ${pid}`);
  }

  /**
   * Operator teardown from ANY process (`remi engine stop`), which is the case
   * that matters: the CLI invoking it is never the long-dead daemon that
   * started the engine, so `startedPid` is null there. Resolves the target
   * from the pidfile instead, mirroring how `daemon-manager.stopDaemon`
   * resolves the hub. Returns the pid it signalled, or null when no engine is
   * recorded.
   */
  static stopRecordedEngine(pids: PidStore, kill: (pid: number) => void): number | null {
    const pid = pids.read();
    if (pid === null) return null;
    kill(pid);
    pids.release(pid);
    return pid;
  }

  private async startEngine(helperPath: string): Promise<EngineHostState> {
    const spawnFn = this.spawnFn;
    if (spawnFn === undefined) {
      const reason = 'no spawn implementation wired (engine supervision unavailable)';
      this.log(`[Engine] ${reason}`);
      return { kind: 'unavailable', reason };
    }

    // CLAIM BEFORE SPAWNING. Claiming after would leave a window where two
    // daemons both spawn and only then discover the conflict — by which point
    // two multi-GB processes exist and one has to be killed. Claiming first
    // means the loser never starts anything.
    if (this.pids !== undefined && !this.pids.claim(process.pid)) {
      const holder = this.pids.read();
      this.log(`[Engine] Engine is being started elsewhere (pid ${holder ?? 'unknown'}); waiting`);
      if (await this.waitForReady()) {
        return { kind: 'attached', ownership: this.config.ownership };
      }
      const reason = `another remi holds the engine start record (pid ${holder ?? 'unknown'}) but no engine answered on ${this.config.baseUrl}`;
      this.log(`[Engine] ${reason}`);
      return { kind: 'unavailable', reason };
    }

    let pid: number;
    try {
      const cache = this.config.modelCache;
      pid = spawnFn(helperPath, {
        // Headless: no menu-bar UI for a helper nobody looks at.
        YOOZ_ENGINE_HEADLESS: '1',
        // remi's reserved port, in every configuration (see the module doc).
        YOOZ_ENGINE_PORT: String(portOf(this.config.baseUrl)),
        // Weights location, via the standard HuggingFace variable the engine
        // already reads. Omitted entirely when unset so the engine keeps its
        // own default rather than being handed an empty path.
        ...(cache !== undefined && cache.length > 0 ? { HF_HUB_CACHE: cache } : {}),
      });
    } catch (err) {
      // Release the claim we took above, or the next attempt is blocked by a
      // record for a process that never existed.
      this.pids?.release(process.pid);
      const reason = `failed to start the engine helper at ${helperPath}: ${errorToString(err)}`;
      this.log(`[Engine] ${reason}`);
      return { kind: 'unavailable', reason };
    }

    // Re-record under the child's pid now that we have it. The window between
    // release and reclaim is a few synchronous statements, but a third process
    // claiming inside it would leave the pidfile naming someone else's engine
    // while we believe we own it -- so the reclaim is checked, not assumed.
    this.pids?.release(process.pid);
    const lostRecord = this.pids !== undefined && !this.pids.claim(pid);
    if (lostRecord) {
      this.log(`[Engine] Started engine pid ${pid} but another process claimed the record first`);
    }
    this.startedPid = pid;
    this.log(`[Engine] Started detached engine pid ${pid} (${helperPath})`);

    if (await this.waitForReady()) {
      if (!lostRecord) return { kind: 'spawned', pid };

      // Something is serving and the record says it is not ours to track, so
      // ours is probably redundant -- but killing it BEFORE confirming that is
      // a bad bet. The process that took the record has not necessarily started
      // anything yet; it may only just have decided to. Killing on that basis
      // can leave the machine with NO engine while a competitor is still
      // downloading multi-GB weights.
      //
      // So: only now, with the port confirmed answering, stop ours -- then
      // re-probe. The probe carries no pid, so "someone answers" cannot tell us
      // WHO; if the port goes dark once ours is gone, ours was the one serving
      // and we must report that rather than claim a healthy attach.
      this.killStarted(pid);
      const after = await this.probe(this.config.baseUrl);
      if (after.reachable) {
        this.log(`[Engine] Stopped our redundant engine (pid ${pid}); attached to theirs`);
        return { kind: 'attached', ownership: this.config.ownership };
      }
      const reason = `stopped our engine (pid ${pid}) after another process claimed the record, but ${this.config.baseUrl} then went dark`;
      this.log(`[Engine] ${reason}`);
      return { kind: 'unavailable', reason };
    }

    // Started but never bound, and nothing else answered either. Kill it rather
    // than leaving a wedged headless process behind: we cannot assume the
    // helper exits on its own when it cannot take the port.
    this.killStarted(pid);
    const reason = `engine started (pid ${pid}) but never answered on ${this.config.baseUrl}`;
    this.log(`[Engine] ${reason}`);
    return { kind: 'unavailable', reason };
  }

  /**
   * Fetch the helper once, if this machine can run one (#834). Single-flight:
   * a burst of daemons booting together must produce one download, not ten of
   * the same 30 MB archive.
   */
  private async installHelper(): Promise<string | undefined> {
    this.installInFlight ??= this.installFn();
    try {
      return await this.installInFlight;
    } finally {
      // Cleared so a later failure can retry rather than caching "no helper"
      // for the daemon's whole life -- a transient network failure at boot
      // must not permanently disable auto-approve.
      this.installInFlight = undefined;
    }
  }

  /** Kill a pid we started and drop its record. Never throws; reports whether
   *  the kill itself succeeded so callers do not log success over a failure. */
  private killStarted(pid: number): boolean {
    let killed = true;
    try {
      this.killFn(pid);
    } catch (err) {
      killed = false;
      this.log(`[Engine] Could not stop engine pid ${pid}: ${errorToString(err)}`);
    }
    this.pids?.release(pid);
    if (this.startedPid === pid) this.startedPid = null;
    return killed;
  }

  private async waitForReady(): Promise<boolean> {
    const timeoutMs = this.config.startupTimeoutMs ?? 30_000;
    const intervalMs = this.config.probeIntervalMs ?? 500;
    const attempts = Math.max(1, Math.floor(timeoutMs / intervalMs));
    for (let i = 0; i < attempts; i++) {
      const probe = await this.probe(this.config.baseUrl, intervalMs);
      if (probe.reachable) return true;
      await this.sleep(intervalMs);
    }
    return false;
  }
}

/** Port from a loopback base URL; 19924 (remi's reserved port) when the URL
 *  names none. */
function portOf(baseUrl: string): number {
  try {
    const parsed = new URL(baseUrl);
    return parsed.port.length > 0 ? Number(parsed.port) : 19924;
  } catch {
    return 19924;
  }
}
