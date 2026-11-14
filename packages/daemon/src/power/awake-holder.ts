import { type ChildProcess, spawn } from 'node:child_process';

/** Why a caffeinate holder could not be started. */
export type AwakeHolderFailure =
  | { readonly kind: 'unsupported'; readonly platform: NodeJS.Platform }
  | { readonly kind: 'missing'; readonly executable: string }
  | { readonly kind: 'not executable'; readonly executable: string }
  | { readonly kind: 'transient'; readonly detail: string }
  | { readonly kind: 'disposed' };

export type AwakeHolderResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: AwakeHolderFailure };

/**
 * Only a missing or non-executable caffeinate (ENOENT or EACCES on spawn), or a
 * platform without it, cannot be fixed by trying again; every other failure
 * is retried by the session (#1773 C5).
 */
export function isPermanentHolderFailure(failure: AwakeHolderFailure): boolean {
  return (
    failure.kind === 'unsupported' ||
    failure.kind === 'missing' ||
    failure.kind === 'not executable'
  );
}

export function describeHolderFailure(failure: AwakeHolderFailure): string {
  switch (failure.kind) {
    case 'unsupported':
      return `not available on ${failure.platform}`;
    case 'missing':
      return `not found at ${failure.executable} (ENOENT)`;
    case 'not executable':
      return `not executable at ${failure.executable} (EACCES)`;
    case 'transient':
      return failure.detail;
    case 'disposed':
      return 'holder disposed';
  }
}

export interface AwakeHolderOptions {
  readonly targetPid?: number;
  readonly ttlSeconds: number;
  readonly executable?: string;
  readonly platform?: NodeJS.Platform;
  /** How long a renewed-away holder keeps running beside its replacement. */
  readonly renewOverlapMs?: number;
  /** The current holder exited or errored without remi asking it to (any code or signal). */
  readonly onUnexpectedExit?: (detail: string) => void;
}

export interface AwakeHolderBoundary {
  readonly pid: number | null;
  start(): Promise<AwakeHolderResult>;
  renew(): Promise<AwakeHolderResult>;
  release(): void;
  dispose(): void;
}

type SpawnOutcome = { readonly child: ChildProcess } | { readonly failure: AwakeHolderFailure };

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/**
 * The spawn event comes before caffeinate has created its assertion, so the
 * previous holder is stopped only after this overlap; killing it at once could
 * leave the target briefly without an assertion.
 */
export const RENEW_OVERLAP_MS = 1_000;

function exitDetail(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `killed by ${signal}` : `exited with code ${code}`;
}

/**
 * Owns the short-lived caffeinate process for one session daemon.
 *
 * Process death is covered by `-w <pid>` (macOS releases the assertion when the
 * target exits) and by the synchronous `exit` listener below. There are no
 * SIGINT or SIGTERM listeners: wrapper mode forwards SIGINT to the PTY and keeps
 * running, and a SIGTERM listener would remove the default terminate action
 * before `cli.ts` installs its own (#1773 C2).
 */
export class AwakeHolder implements AwakeHolderBoundary {
  private current: ChildProcess | null = null;
  private disposed = false;
  private readonly targetPid: number;
  private readonly executable: string;
  private readonly platform: NodeJS.Platform;
  private readonly ttlSeconds: number;
  private readonly renewOverlapMs: number;
  /** Holders replaced by `renew`, kept for the overlap. */
  private readonly retiring = new Set<ChildProcess>();
  private readonly onUnexpectedExit: ((detail: string) => void) | undefined;
  /** Children that exited before `start` or `renew` adopted them. */
  private readonly exitedEarly = new WeakMap<ChildProcess, string>();
  private readonly onProcessExit = (): void => this.release();

  constructor(options: AwakeHolderOptions) {
    this.targetPid = options.targetPid ?? process.pid;
    this.ttlSeconds = options.ttlSeconds;
    this.executable = options.executable ?? '/usr/bin/caffeinate';
    this.platform = options.platform ?? process.platform;
    this.renewOverlapMs = options.renewOverlapMs ?? RENEW_OVERLAP_MS;
    this.onUnexpectedExit = options.onUnexpectedExit;
    process.on('exit', this.onProcessExit);
  }

  get pid(): number | null {
    return this.current?.pid ?? null;
  }

  async start(): Promise<AwakeHolderResult> {
    const refused = this.refusal();
    if (refused) return refused;
    if (this.current) return { ok: true };
    const outcome = await this.spawnHolder();
    const adopted = this.adopt(outcome);
    if (!adopted.ok) return adopted;
    this.current = adopted.child;
    return { ok: true };
  }

  /** Start the replacement first so renewing the TTL never creates a gap. */
  async renew(): Promise<AwakeHolderResult> {
    const refused = this.refusal();
    if (refused) return refused;
    const outcome = await this.spawnHolder();
    const adopted = this.adopt(outcome);
    if (!adopted.ok) return adopted;
    const previous = this.current;
    this.current = adopted.child;
    if (previous) this.retire(previous);
    return { ok: true };
  }

  release(): void {
    const current = this.current;
    this.current = null;
    current?.kill('SIGTERM');
    for (const child of this.retiring) child.kill('SIGTERM');
    this.retiring.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    process.off('exit', this.onProcessExit);
  }

  private retire(child: ChildProcess): void {
    this.retiring.add(child);
    const timer = setTimeout(() => {
      if (!this.retiring.delete(child)) return;
      child.kill('SIGTERM');
    }, this.renewOverlapMs);
    timer.unref?.();
  }

  private refusal(): AwakeHolderResult | null {
    if (this.disposed) return { ok: false, failure: { kind: 'disposed' } };
    if (this.platform !== 'darwin') {
      return { ok: false, failure: { kind: 'unsupported', platform: this.platform } };
    }
    return null;
  }

  private adopt(
    outcome: SpawnOutcome,
  ):
    | { readonly ok: true; readonly child: ChildProcess }
    | Extract<AwakeHolderResult, { ok: false }> {
    if ('failure' in outcome) return { ok: false, failure: outcome.failure };
    const { child } = outcome;
    if (this.disposed) {
      child.kill('SIGTERM');
      return { ok: false, failure: { kind: 'disposed' } };
    }
    const early = this.exitedEarly.get(child);
    if (early !== undefined) return { ok: false, failure: { kind: 'transient', detail: early } };
    return { ok: true, child };
  }

  private failureFor(error: unknown): AwakeHolderFailure {
    const code = errorCode(error);
    if (code === 'ENOENT') return { kind: 'missing', executable: this.executable };
    if (code === 'EACCES') return { kind: 'not executable', executable: this.executable };
    return { kind: 'transient', detail: `failed to start (${code})` };
  }

  private spawnHolder(): Promise<SpawnOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: SpawnOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      let child: ChildProcess;
      try {
        child = spawn(
          this.executable,
          ['-i', '-w', String(this.targetPid), '-t', String(this.ttlSeconds)],
          { shell: false, stdio: 'ignore' },
        );
      } catch (error) {
        settle({ failure: this.failureFor(error) });
        return;
      }

      child.on('error', (error) => {
        if (!settled) {
          settle({ failure: this.failureFor(error) });
        } else if (this.current === child) {
          this.current = null;
          this.onUnexpectedExit?.(`failed (${errorCode(error)})`);
        }
      });
      child.once('spawn', () => {
        child.once('exit', (code, signal) => {
          const detail = exitDetail(code, signal);
          if (this.current === child) {
            this.current = null;
            this.onUnexpectedExit?.(detail);
          } else {
            this.exitedEarly.set(child, detail);
          }
        });
        settle({ child });
      });
      child.once('close', () => {
        settle({ failure: { kind: 'transient', detail: 'closed before it started' } });
      });
    });
  }
}
