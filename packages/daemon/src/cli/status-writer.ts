/**
 * Debounced writer for the per-session status file that the Claude Code
 * statusline script reads on every prompt.
 *
 * Encapsulates three concerns that used to live as free-functions in cli.ts:
 *
 *   1. Mutable in-memory status object (`RemiStatus`).
 *   2. 300 ms debounce — many updates in quick succession (e.g. during a
 *      tool call) collapse into a single disk write.
 *   3. Atomic write-then-rename so readers never see partial JSON.
 *
 * The writer is enabled only when the caller says so (via `isEnabled`). The
 * target path is resolved lazily each write via `getTargetFile` so the
 * STATUS_FILE rename at port-resolution time still picks up correctly.
 *
 * Errors during write are logged exactly once via `writeToLog` so a
 * persistently-failing disk never floods the log.
 */

import * as fs from 'node:fs';
import type { AgentStatus, UUID } from '@remi/shared';

export type RemiSessionStatus = AgentStatus | 'starting';

/**
 * Auto-approve eval state surfaced in Claude's native status line (#560).
 *
 * Driven by a COUNT (inc on eval start, dec on every end path), not a boolean
 * spinner — a count cannot get "stuck" the way the old shared TerminalIndicator
 * did when concurrent evals (parallel subagents / multiple sessions) interleaved
 * its start/stop. `inFlight > 0` => a permission is being decided right now.
 * Times are epoch SECONDS so the statusline shell script can compute elapsed
 * with `date +%s` (macOS `date` has no millisecond format).
 */
export interface AutoApproveState {
  /** Evals in flight on this daemon. 0 = idle. */
  inFlight: number;
  /** Epoch seconds the current in-flight batch began (set on 0->1, cleared on
   *  1->0). The statusline shows `evaluating <now-sinceS>s`. */
  sinceS: number;
  /** Last settled verdict, for a post-eval cue. */
  lastVerdict: 'approved' | 'escalated' | 'none';
  /** Epoch seconds of the last verdict; the statusline fades 'approved' after a
   *  few seconds and keeps 'escalated' (needs-you) until the next eval. */
  lastVerdictAtS: number;
}

export const IDLE_AUTO_APPROVE: AutoApproveState = {
  inFlight: 0,
  sinceS: 0,
  lastVerdict: 'none',
  lastVerdictAtS: 0,
};

/** Seconds an 'escalated' verdict is considered fresh/actionable. A later
 *  'approved' from a concurrent eval must not hide a still-fresh escalate, and
 *  the statusline shows "needs you" only within this window (kept in sync with
 *  the render in statusline-installer.ts). */
export const ESCALATE_FRESH_S = 60;

export interface RemiStatus {
  pid: number;
  connections: number;
  sessionStatus: RemiSessionStatus;
  adapters: string[];
  wsPort: number;
  sessionId: UUID | null;
  repo: string;
  branch: string;
  autoApprove: AutoApproveState;
}

export interface StatusWriterDeps {
  /** Returns the path to write to. Called on every flush so caller can swap files at runtime. */
  readonly getTargetFile: () => string;
  /** Guard — return false to skip writes (e.g. not in wrapper/daemon mode). */
  readonly isEnabled: () => boolean;
  /** Logger for write errors; called at most once per consecutive failure streak. */
  readonly writeLog: (msg: string) => void;
  /** Debounce window in ms. Default 300. Tests override to 0. */
  readonly debounceMs?: number;
}

export class StatusWriter {
  private readonly status: RemiStatus;
  private readonly deps: Required<StatusWriterDeps>;
  private errorLogged = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(initial: RemiStatus, deps: StatusWriterDeps) {
    this.status = { ...initial };
    this.deps = {
      ...deps,
      debounceMs: deps.debounceMs ?? 300,
    };
  }

  /** Read-only snapshot of the current status. */
  get state(): Readonly<RemiStatus> {
    return this.status;
  }

  /** Apply a partial patch and schedule a debounced flush. */
  update(patch: Partial<RemiStatus>): void {
    Object.assign(this.status, patch);
    this.schedule();
  }

  /**
   * An auto-approve eval started (#560). Increments the in-flight count; stamps
   * the batch start on the 0->1 edge so the statusline can show elapsed time.
   * `nowMs` is Date.now() (floored to seconds for the shell script).
   */
  autoApproveStart(nowMs: number): void {
    const aa = this.status.autoApprove;
    if (aa.inFlight === 0) aa.sinceS = Math.floor(nowMs / 1000);
    aa.inFlight += 1;
    this.schedule();
  }

  /**
   * An auto-approve eval settled. Decrements the in-flight count (floored at 0 so
   * an unbalanced end can never make it negative) and records the verdict for the
   * post-eval cue. 'cancelled' just decrements (no actionable verdict). Because
   * every gate end-path calls this exactly once, the count returns to 0 and the
   * "evaluating" cue can never get stuck.
   */
  autoApproveEnd(verdict: 'approved' | 'escalated' | 'cancelled', nowMs: number): void {
    const aa = this.status.autoApprove;
    // Only record a verdict for an eval that actually ran (a matching start).
    // When auto-approve is OFF, the gate's normal escalate-to-user path still
    // fires onEscalate without a prior start; without this guard that would
    // stamp a spurious permanent 'needs you' (#560 review).
    const wasInFlight = aa.inFlight > 0;
    aa.inFlight = Math.max(0, aa.inFlight - 1);
    if (aa.inFlight === 0) aa.sinceS = 0;
    if (!wasInFlight) return;
    const nowS = Math.floor(nowMs / 1000);
    if (verdict === 'escalated') {
      aa.lastVerdict = 'escalated';
      aa.lastVerdictAtS = nowS;
    } else if (verdict === 'approved') {
      // A concurrent eval's silent approve must not hide a still-fresh escalate
      // the user still needs to act on (#560 review).
      const escalateFresh =
        aa.lastVerdict === 'escalated' && nowS - aa.lastVerdictAtS < ESCALATE_FRESH_S;
      if (!escalateFresh) {
        aa.lastVerdict = 'approved';
        aa.lastVerdictAtS = nowS;
      }
    }
    this.schedule();
  }

  /** Immediately write to disk (skips the debounce). Used on graceful shutdown. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
  }

  /** Remove the status file. Typical caller is the shutdown handler. */
  cleanup(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.unlinkSync(this.deps.getTargetFile());
    } catch {
      // File may not exist during cleanup
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, this.deps.debounceMs);
  }

  private write(): void {
    if (!this.deps.isEnabled()) return;
    const targetFile = this.deps.getTargetFile();
    const tmpFile = `${targetFile}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(this.status));
      fs.renameSync(tmpFile, targetFile);
      this.errorLogged = false;
    } catch (err) {
      if (!this.errorLogged) {
        this.deps.writeLog(`[error] Failed to write status file: ${err}`);
        this.errorLogged = true;
      }
    }
  }
}
