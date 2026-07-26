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
 * The pidfile doubles as the start race guard: it is created O_EXCL, so of two
 * daemons booting simultaneously exactly one spawns and the other waits and
 * attaches. (The port would arbitrate anyway — the loser's engine would fail
 * to bind — but losing that race noisily is worse than not entering it.)
 */

import { errorToString } from '@remi/shared';
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
  private readonly log: EngineHostDeps['log'];
  private readonly probe: typeof probeEngine;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spawnFn: EngineHostDeps['spawn'];
  private readonly killFn: (pid: number) => void;
  private readonly pids: PidStore | undefined;

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
  }

  /** True when remi may load/unload/delete models on this engine. The single
   *  question every mutating caller should ask (#820's timer, `remi model
   *  unload`/`rm`). */
  get ownsEngine(): boolean {
    return this.config.ownership === 'owned';
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

    const helperPath = this.config.helperPath;
    if (helperPath === undefined || helperPath.length === 0) {
      const reason = `no engine on ${this.config.baseUrl} and no helper is bundled to start (auto_approve.engine_path unset)`;
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
    if (this.pids !== undefined && !this.pids.claim(pid)) {
      // Somebody else's engine now owns the record, so ours is redundant: it
      // will either lose the port bind or, worse, sit wedged forever. Logging
      // and carrying on would leak a multi-GB process nothing tracks -- the
      // pidfile would name their engine while we believed we owned ours.
      this.log(
        `[Engine] Started engine pid ${pid} but another process claimed the record first; stopping ours and attaching to theirs`,
      );
      this.killStarted(pid);
      if (await this.waitForReady()) {
        return { kind: 'attached', ownership: this.config.ownership };
      }
      const reason = `stopped our redundant engine (pid ${pid}) but the winner never answered on ${this.config.baseUrl}`;
      this.log(`[Engine] ${reason}`);
      return { kind: 'unavailable', reason };
    }
    this.startedPid = pid;
    this.log(`[Engine] Started detached engine pid ${pid} (${helperPath})`);

    if (await this.waitForReady()) return { kind: 'spawned', pid };

    // Started but never bound. Kill it rather than leaving a wedged headless
    // process behind: we cannot assume the helper exits on its own when it
    // cannot take the port.
    this.killStarted(pid);
    const reason = `engine started (pid ${pid}) but never answered on ${this.config.baseUrl}`;
    this.log(`[Engine] ${reason}`);
    return { kind: 'unavailable', reason };
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
