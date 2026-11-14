import { type ChildProcess, spawn } from 'node:child_process';

export interface AwakeHolderOptions {
  readonly targetPid?: number;
  readonly ttlSeconds: number;
  readonly executable?: string;
  readonly platform?: NodeJS.Platform;
  readonly onUnexpectedExit?: (exitCode?: number | null, signal?: NodeJS.Signals | null) => void;
  readonly onTermination?: () => void;
}

export interface AwakeHolderBoundary {
  readonly pid: number | null;
  start(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): void;
  dispose(): void;
}

/** Owns the short-lived caffeinate process for one session daemon. */
export class AwakeHolder implements AwakeHolderBoundary {
  private current: ChildProcess | null = null;
  private disposed = false;
  private readonly targetPid: number;
  private readonly executable: string;
  private readonly platform: NodeJS.Platform;
  private readonly ttlSeconds: number;
  private readonly onTermination: (() => void) | undefined;
  private readonly onUnexpectedExit:
    | ((exitCode?: number | null, signal?: NodeJS.Signals | null) => void)
    | undefined;
  private readonly onProcessExit = (): void => this.release();
  private readonly onProcessSignal = (): void => {
    this.onTermination?.();
    this.dispose();
  };

  constructor(options: AwakeHolderOptions) {
    this.targetPid = options.targetPid ?? process.pid;
    this.ttlSeconds = options.ttlSeconds;
    this.executable = options.executable ?? '/usr/bin/caffeinate';
    this.platform = options.platform ?? process.platform;
    this.onUnexpectedExit = options.onUnexpectedExit;
    this.onTermination = options.onTermination;
    process.on('exit', this.onProcessExit);
    process.on('SIGINT', this.onProcessSignal);
    process.on('SIGTERM', this.onProcessSignal);
  }

  get pid(): number | null {
    return this.current?.pid ?? null;
  }

  async start(): Promise<boolean> {
    if (this.disposed || this.platform !== 'darwin') return false;
    if (this.current) return true;
    const next = await this.spawnHolder();
    if (!next || this.disposed) {
      if (next) next.kill('SIGTERM');
      return false;
    }
    this.current = next;
    return true;
  }

  /** Start the replacement first so renewing the TTL never creates a gap. */
  async renew(): Promise<boolean> {
    if (this.disposed || this.platform !== 'darwin') return false;
    const next = await this.spawnHolder();
    if (!next || this.disposed) {
      if (next) next.kill('SIGTERM');
      return false;
    }
    const previous = this.current;
    this.current = next;
    previous?.kill('SIGTERM');
    return true;
  }

  release(): void {
    const current = this.current;
    this.current = null;
    current?.kill('SIGTERM');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    process.off('exit', this.onProcessExit);
    process.off('SIGINT', this.onProcessSignal);
    process.off('SIGTERM', this.onProcessSignal);
  }

  private spawnHolder(): Promise<ChildProcess | null> {
    return new Promise((resolve) => {
      let spawned = false;
      let settled = false;
      let child: ChildProcess;
      try {
        child = spawn(
          this.executable,
          ['-i', '-w', String(this.targetPid), '-t', String(this.ttlSeconds)],
          { shell: false, stdio: 'ignore' },
        );
      } catch {
        resolve(null);
        return;
      }

      child.on('error', () => {
        if (!settled) {
          settled = true;
          resolve(null);
        } else if (this.current === child) {
          this.current = null;
          this.onUnexpectedExit?.();
        }
      });
      child.once('spawn', () => {
        spawned = true;
        if (settled) return;
        settled = true;
        child.once('exit', (code, signal) => {
          if (this.current !== child) return;
          this.current = null;
          this.onUnexpectedExit?.(code, signal);
        });
        resolve(child);
      });
      child.once('close', () => {
        if (!spawned && !settled) {
          settled = true;
          resolve(null);
        }
      });
    });
  }
}
