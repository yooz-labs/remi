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

export interface RemiStatus {
  pid: number;
  connections: number;
  sessionStatus: RemiSessionStatus;
  adapters: string[];
  wsPort: number;
  sessionId: UUID | null;
  repo: string;
  branch: string;
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
