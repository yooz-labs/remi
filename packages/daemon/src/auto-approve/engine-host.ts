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
 * Ownership WITHIN remi: one helper per machine. When a hub (`remi serve`) is
 * running it owns the helper and session daemons attach to it; N session
 * daemons must never spawn N engines, each loading its own multi-GB copy of
 * the same weights. A standalone `remi --daemon` with no hub spawns and
 * supervises its own.
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
  /** How long to wait for a freshly-spawned helper to answer. */
  readonly startupTimeoutMs?: number;
  /** Interval between readiness probes during startup. */
  readonly probeIntervalMs?: number;
}

export interface EngineHostDeps {
  readonly log: (msg: string) => void;
  /** Spawn seam. Returns a handle; tests supply a fake process. */
  readonly spawn?: (path: string, env: Record<string, string>) => SpawnedProcess;
  readonly probe?: typeof probeEngine;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The subset of a child process this file needs. */
export interface SpawnedProcess {
  readonly pid: number;
  kill(): void;
  /** Resolves when the process exits, with its code. */
  readonly exited: Promise<number>;
}

/** What `ensureRunning` concluded, as a value — every outcome is reportable,
 *  because "no engine" must never be silent (#818). */
export type EngineHostState =
  | { readonly kind: 'attached'; readonly ownership: EngineOwnership }
  | { readonly kind: 'spawned'; readonly pid: number }
  | { readonly kind: 'unavailable'; readonly reason: string };

export class EngineHost {
  private child: SpawnedProcess | null = null;
  private readonly log: EngineHostDeps['log'];
  private readonly probe: typeof probeEngine;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spawnFn: EngineHostDeps['spawn'];

  constructor(
    private readonly config: EngineHostConfig,
    deps: EngineHostDeps,
  ) {
    this.log = deps.log;
    this.probe = deps.probe ?? probeEngine;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.spawnFn = deps.spawn;
  }

  /** True when remi may load/unload/delete models on this engine. The single
   *  question every mutating caller should ask (#820's timer, `remi model
   *  unload`/`rm`). */
  get ownsEngine(): boolean {
    return this.config.ownership === 'owned';
  }

  /** True when THIS process spawned the running helper. */
  get isSupervising(): boolean {
    return this.child !== null;
  }

  /**
   * Make sure an engine is answering, spawning one if this remi owns the
   * engine and nothing is there yet.
   *
   * Attach-before-spawn is deliberate even in `owned` mode: a hub may already
   * have started the helper for the machine, and spawning a second one would
   * load a second multi-GB copy of the same weights and lose the port race.
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

    return await this.spawnHelper(helperPath);
  }

  /** Stop a helper THIS process started. Never touches an engine it merely
   *  attached to — that one belongs to a hub, a host, or the user. */
  stop(): void {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    try {
      child.kill();
      this.log(`[Engine] Stopped the helper this daemon started (pid ${child.pid})`);
    } catch (err) {
      this.log(`[Engine] Failed to stop helper pid ${child.pid}: ${errorToString(err)}`);
    }
  }

  private async spawnHelper(helperPath: string): Promise<EngineHostState> {
    const spawnFn = this.spawnFn;
    if (spawnFn === undefined) {
      const reason = 'no spawn implementation wired (engine supervision unavailable)';
      this.log(`[Engine] ${reason}`);
      return { kind: 'unavailable', reason };
    }

    let child: SpawnedProcess;
    try {
      child = spawnFn(helperPath, {
        // Headless: no menu-bar UI for a helper nobody looks at.
        YOOZ_ENGINE_HEADLESS: '1',
        // remi's reserved port, in every configuration (see the module doc).
        YOOZ_ENGINE_PORT: String(portOf(this.config.baseUrl)),
      });
    } catch (err) {
      const reason = `failed to start the engine helper at ${helperPath}: ${errorToString(err)}`;
      this.log(`[Engine] ${reason}`);
      return { kind: 'unavailable', reason };
    }
    this.child = child;
    this.log(`[Engine] Started helper pid ${child.pid} (${helperPath})`);

    // A helper that dies is not silently forgotten: clear our handle so a
    // later ensureRunning() starts a fresh one rather than assuming this is
    // still alive.
    void child.exited
      .then((code) => {
        if (this.child === child) {
          this.child = null;
          this.log(`[Engine] Helper pid ${child.pid} exited (code ${code})`);
        }
      })
      .catch(() => {
        /* exit reporting is best-effort */
      });

    const ready = await this.waitForReady();
    if (ready) return { kind: 'spawned', pid: child.pid };

    // Started but never answered: leave nothing half-supervised behind.
    this.stop();
    const reason = `engine helper started (pid ${child.pid}) but never answered on ${this.config.baseUrl}`;
    this.log(`[Engine] ${reason}`);
    return { kind: 'unavailable', reason };
  }

  private async waitForReady(): Promise<boolean> {
    const timeoutMs = this.config.startupTimeoutMs ?? 30_000;
    const intervalMs = this.config.probeIntervalMs ?? 500;
    const attempts = Math.max(1, Math.floor(timeoutMs / intervalMs));
    for (let i = 0; i < attempts; i++) {
      // A helper that already exited will never answer; fail fast rather than
      // burning the whole startup window on a dead process.
      if (this.child === null) return false;
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
