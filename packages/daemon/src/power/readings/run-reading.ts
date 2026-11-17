import { type ChildProcess, spawn } from 'node:child_process';

/**
 * The one place a power reading spawns a process (#1773, ADR 0050).
 * `runReading` is what keeps a reading from ever changing power state: it spawns only the
 * three read-only tools below, and `pmset` only as `-g` with a read keyword.
 * `spawnBounded` is the unguarded runner under it, for tests and for later slices that
 * take their command from `level2-commands.ts`.
 */

/** The tools a reading may run. */
export const READING_EXECUTABLES = [
  '/usr/bin/pmset',
  '/usr/sbin/ioreg',
  '/usr/bin/notifyutil',
] as const;

/**
 * The only second arguments `pmset -g` may carry.
 * `pmset -g` with none of them lists the current settings, which is also a read.
 */
const PMSET_READ_KEYWORDS: readonly string[] = ['assertions', 'batt', 'therm', 'ps'];

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_STDOUT_BYTES = 262144;
const MAX_STDERR_BYTES = 65536;

export interface SpawnBoundedOptions {
  /** Deadline after which the child is sent SIGKILL (default 2000). */
  readonly timeoutMs?: number;
  /** Stdout size past which the child is sent SIGKILL (default 262144). */
  readonly maxStdoutBytes?: number;
  /** Return stderr (capped at 65536 bytes) instead of discarding it. */
  readonly captureStderr?: boolean;
}

/**
 * `exit N` is a nonzero exit code, `signal NAME` a death by signal, `spawn CODE` any other
 * spawn error.
 * A reason never holds output text.
 */
export type ReadingFailure =
  | 'missing'
  | 'not executable'
  | 'timeout'
  | 'oversize'
  | 'refused'
  | `exit ${number}`
  | `signal ${string}`
  | `spawn ${string}`;

export type SpawnBoundedResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly reason: ReadingFailure };

let spawnCount = 0;

/** How many processes `spawnBounded` has started; a test reads it to prove a refusal spawned none. */
export function readingSpawnCount(): number {
  return spawnCount;
}

function failureForSpawnError(error: unknown): ReadingFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'missing';
  if (code === 'EACCES') return 'not executable';
  return `spawn ${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN'}`;
}

function failureForSignal(signal: string): ReadingFailure {
  return `signal ${/^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : 'UNKNOWN'}`;
}

/**
 * Run `executable` with `args`, no shell, no stdin, a fixed environment, a deadline and a
 * stdout cap.
 * Never throws; a failure is `{ ok: false, reason }`.
 */
export function spawnBounded(
  executable: string,
  args: readonly string[],
  options: SpawnBoundedOptions = {},
): Promise<SpawnBoundedResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const captureStderr = options.captureStderr === true;

  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let killedFor: 'timeout' | 'oversize' | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = (result: SpawnBoundedResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve(result);
    };

    // After a kill the pipes may stay open through a grandchild, so wait for the child's exit
    // (not the pipes' close) and report the reason that caused the kill.
    const kill = (reason: 'timeout' | 'oversize'): void => {
      if (killedFor || settled || !child) return;
      killedFor = reason;
      const target = child;
      if (target.exitCode !== null || target.signalCode !== null) {
        finish({ ok: false, reason });
        return;
      }
      target.once('exit', () => finish({ ok: false, reason }));
      try {
        target.kill('SIGKILL');
      } catch {
        finish({ ok: false, reason });
      }
    };

    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    spawnCount += 1;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
    } catch (error) {
      finish({ ok: false, reason: failureForSpawnError(error) });
      return;
    }

    child.on('error', (error) => {
      if (killedFor) return;
      finish({ ok: false, reason: failureForSpawnError(error) });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (killedFor || settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        kill('oversize');
        return;
      }
      stdoutChunks.push(chunk);
    });
    // stderr is always drained so a chatty tool cannot block on a full pipe.
    child.stderr?.on('data', (chunk: Buffer) => {
      if (!captureStderr || stderrBytes >= MAX_STDERR_BYTES) return;
      const room = MAX_STDERR_BYTES - stderrBytes;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderrBytes += kept.length;
      stderrChunks.push(kept);
    });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.on('close', (code, signal) => {
      if (killedFor) return;
      if (signal) {
        finish({ ok: false, reason: failureForSignal(signal) });
      } else if (code !== 0) {
        finish({ ok: false, reason: `exit ${code ?? -1}` });
      } else {
        finish({
          ok: true,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: captureStderr ? Buffer.concat(stderrChunks).toString('utf8') : '',
        });
      }
    });
  });
}

function isReadOnlyInvocation(executable: string, args: readonly string[]): boolean {
  if (!(READING_EXECUTABLES as readonly string[]).includes(executable)) return false;
  if (executable !== '/usr/bin/pmset') return true;
  if (args[0] !== '-g' || args.length > 2) return false;
  return args.length === 1 || PMSET_READ_KEYWORDS.includes(args[1] ?? '');
}

/**
 * `spawnBounded` behind the read-only guard: anything but the three reading tools, or
 * `pmset` other than `-g [assertions|batt|therm|ps]`, returns `refused` without spawning.
 */
export function runReading(
  executable: string,
  args: readonly string[],
  options: SpawnBoundedOptions = {},
): Promise<SpawnBoundedResult> {
  if (!isReadOnlyInvocation(executable, args)) {
    return Promise.resolve({ ok: false, reason: 'refused' });
  }
  return spawnBounded(executable, args, options);
}
