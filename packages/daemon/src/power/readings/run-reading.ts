import { type ChildProcess, spawn } from 'node:child_process';

/**
 * The one place a power reading spawns a process (#1773, ADR 0050).
 * `runReading` runs only the exact invocations `isReadOnlyInvocation` allows: `pmset -g
 * [assertions|batt|therm|ps]`, `ioreg -r -c <IOPMrootDomain|AppleSmartBattery> -d 1` and
 * `notifyutil -g com.apple.system.thermalpressurelevel`.
 * `spawnBounded` is NOT guarded: it runs whatever it is given, so every later entry point that
 * reaches it must go through `runReading` (or take its command from `level2-commands.ts`).
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

/** The IORegistry classes `ioreg -r -c` may read (AppleSmartBattery is for the battery slice). */
const IOREG_CLASSES: readonly string[] = ['IOPMrootDomain', 'AppleSmartBattery'];

const THERMAL_KEY = 'com.apple.system.thermalpressurelevel';

/** Deadline after which a reading is killed; the `[awake]` key `reading_deadline_ms` feeds it in G2. */
export const DEFAULT_TIMEOUT_MS = 2000;
/** Stdout cap; the `[awake]` key `reading_stdout_max_bytes` feeds it in G2. */
export const DEFAULT_MAX_STDOUT_BYTES = 262144;
/** Stderr cap, when stderr is kept; the `[awake]` key `reading_stderr_max_bytes` feeds it in G2. */
export const DEFAULT_MAX_STDERR_BYTES = 65536;
/** Wait after the kill before finishing without an exit; the `[awake]` key `reading_kill_grace_ms` feeds it in G2. */
export const DEFAULT_KILL_GRACE_MS = 500;

export interface SpawnBoundedOptions {
  /** Deadline after which the child is sent SIGKILL (default 2000). */
  readonly timeoutMs?: number;
  /** Stdout size past which the child is sent SIGKILL (default 262144). */
  readonly maxStdoutBytes?: number;
  /** Return stderr (capped at 65536 bytes) instead of discarding it. */
  readonly captureStderr?: boolean;
  /** Stderr size kept when `captureStderr` is set (default 65536). */
  readonly maxStderrBytes?: number;
  /** Wait after the kill before finishing even if the child's exit has not arrived (default 500). */
  readonly killGraceMs?: number;
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
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

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
    // The child leads its own process group, so the kill reaches a wrapper's children too.
    // A short grace timer finishes with the same reason if 'exit' never arrives.
    const kill = (reason: 'timeout' | 'oversize'): void => {
      if (killedFor || settled || !child) return;
      killedFor = reason;
      const target = child;
      const done = (): void => finish({ ok: false, reason });
      if (target.exitCode !== null || target.signalCode !== null) {
        done();
        return;
      }
      target.once('exit', done);
      setTimeout(done, killGraceMs).unref();
      try {
        if (target.pid === undefined) throw new Error('no pid');
        process.kill(-target.pid, 'SIGKILL');
      } catch {
        try {
          target.kill('SIGKILL');
        } catch {
          done();
        }
      }
    };

    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    spawnCount += 1;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        detached: true,
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
      if (!captureStderr || stderrBytes >= maxStderrBytes) return;
      const room = maxStderrBytes - stderrBytes;
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

/**
 * True only for the exact invocations a reading may run; every one of them is a read.
 * Pure (no spawn), so a test can assert the refusal of a power-changing command without
 * ever running it.
 */
export function isReadOnlyInvocation(executable: string, args: readonly string[]): boolean {
  switch (executable) {
    case '/usr/bin/pmset':
      return (
        args[0] === '-g' &&
        args.length <= 2 &&
        (args.length === 1 || PMSET_READ_KEYWORDS.includes(args[1] ?? ''))
      );
    case '/usr/sbin/ioreg':
      return (
        args.length === 5 &&
        args[0] === '-r' &&
        args[1] === '-c' &&
        IOREG_CLASSES.includes(args[2] ?? '') &&
        args[3] === '-d' &&
        args[4] === '1'
      );
    case '/usr/bin/notifyutil':
      return args.length === 2 && args[0] === '-g' && args[1] === THERMAL_KEY;
    default:
      return false;
  }
}

/**
 * `spawnBounded` behind `isReadOnlyInvocation`: any other executable or argument list returns
 * `refused` without spawning.
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
