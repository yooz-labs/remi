import { readFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';

type ProcSample =
  | { available: true; state: string; cpuTicks: number; threads: number; rssPages: number }
  | { available: false; reason: 'unsupported' | 'unavailable' | 'malformed' };

type RunOptions = {
  stdout?: Writable;
  stderr?: Writable;
  diagnosticAfterMs?: number;
  diagnosticEveryMs?: number;
  procSampler?: (pid: number) => Promise<ProcSample>;
};

type RunResult = { exitCode: number; lastTestFile: string | null };
type HeaderState = { last: string | null };

const TEST_HEADER = /(?:^|\s)((?:packages|tests)\/[^\s:]+\.test\.[cm]?[jt]sx?):/;
const PROC_STATE = /^[RSDZTWtXxKWPPI]$/;

class HeaderTracker {
  #decoder = new TextDecoder();
  #line = '';

  constructor(private readonly state: HeaderState) {}

  add(chunk: Uint8Array): void {
    const text = this.#decoder.decode(chunk, { stream: true });
    for (const char of text) {
      if (char === '\n') {
        this.#capture(this.#line);
        this.#line = '';
      } else if (this.#line.length < 2048) {
        this.#line += char;
      }
    }
  }

  flush(): void {
    this.#line += this.#decoder.decode();
    this.#capture(this.#line);
    this.#line = '';
  }

  #capture(line: string): void {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    const match = TEST_HEADER.exec(plain);
    const path = match?.[1];
    if (path) this.state.last = path;
  }
}

async function writeChunk(stream: Writable, chunk: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let callReturned = false;
    let writeDone = false;
    let drainDone = true;
    let settled = false;

    const cleanup = () => {
      stream.off('error', onError);
      stream.off('drain', onDrain);
    };
    const finish = (error?: Error | null) => {
      if (settled) return;
      if (error) {
        settled = true;
        // Keep the error listener installed through the Writable's current
        // error turn; callback errors can be followed by an `error` event.
        setTimeout(() => {
          cleanup();
          reject(error);
        }, 0);
        return;
      }
      if (callReturned && writeDone && drainDone) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => finish(error);
    const onDrain = () => {
      drainDone = true;
      finish();
    };

    stream.on('error', onError);
    try {
      const accepted = stream.write(chunk, (error?: Error | null) => {
        if (error) {
          finish(error);
          return;
        }
        writeDone = true;
        finish();
      });
      if (!accepted) {
        drainDone = false;
        stream.once('drain', onDrain);
      }
      callReturned = true;
      finish();
    } catch (error) {
      finish(error as Error);
    }
  });
}

async function forward(
  source: ReadableStream<Uint8Array>,
  destination: Writable,
  tracker: HeaderTracker,
  onOutput: () => void,
): Promise<void> {
  const reader = source.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tracker.add(value);
      onOutput();
      await writeChunk(destination, value);
    }
    tracker.flush();
  } finally {
    reader.releaseLock();
  }
}

/** Parse only the numeric/state fields needed from Linux /proc/PID/stat. */
export async function sampleProc(pid: number): Promise<ProcSample> {
  if (process.platform !== 'linux') return { available: false, reason: 'unsupported' };
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return { available: false, reason: 'unavailable' };
  }

  // comm is parenthesized but may itself contain spaces and closing parentheses.
  const close = stat.lastIndexOf(')');
  if (close < 0) return { available: false, reason: 'malformed' };
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0]; // field 3; remaining array is zero based from field 3.
  const userTicks = Number(fields[11]); // field 14
  const systemTicks = Number(fields[12]); // field 15
  const threads = Number(fields[17]); // field 20
  const rssPages = Number(fields[21]); // field 24
  if (
    typeof state !== 'string' ||
    !PROC_STATE.test(state) ||
    ![userTicks, systemTicks, threads, rssPages].every(Number.isSafeInteger) ||
    userTicks < 0 ||
    systemTicks < 0 ||
    threads < 0 ||
    rssPages < 0
  ) {
    return { available: false, reason: 'malformed' };
  }
  return { available: true, state, cpuTicks: userTicks + systemTicks, threads, rssPages };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // detached:true makes this PID the leader of the process group we own.
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
}

function diagnosticLine(
  pid: number,
  elapsedMs: number,
  quietMs: number,
  header: string | null,
  sample: ProcSample,
  cpuDeltaTicks: number | null,
): string {
  const processData = sample.available
    ? { ...sample, cpuDeltaTicks }
    : { ...sample, cpuDeltaTicks: null };
  return `[ci-test-diagnostic] ${JSON.stringify({
    childPid: pid,
    elapsedMs,
    quietMs,
    lastTestFile: header,
    process: processData,
  })}\n`;
}

/** Run a real child process and observe quiet periods without changing its execution. */
export async function runChild(command: string[], options: RunOptions = {}): Promise<RunResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const afterMs = options.diagnosticAfterMs ?? 120_000;
  const everyMs = options.diagnosticEveryMs ?? 60_000;
  if (!Number.isFinite(afterMs) || afterMs < 1 || !Number.isFinite(everyMs) || everyMs < 1) {
    throw new RangeError('diagnostic intervals must be positive finite milliseconds');
  }

  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', detached: true });
  const headerState: HeaderState = { last: null };
  const stdoutTracker = new HeaderTracker(headerState);
  const stderrTracker = new HeaderTracker(headerState);
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  let lastDiagnosticAt = 0;
  let previousCpuTicks: number | null = null;
  let interruptedBy: NodeJS.Signals | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let diagnosticWriteError: unknown = null;
  let diagnosticsStopped = false;
  let diagnosticTask: Promise<void> | null = null;
  const onOutput = () => {
    lastOutputAt = Date.now();
  };
  const forwardStdout = forward(child.stdout, stdout, stdoutTracker, onOutput);
  const forwardStderr = forward(child.stderr, stderr, stderrTracker, onOutput);
  let childWorkFinished = false;
  const workSettled = Promise.allSettled([child.exited, forwardStdout, forwardStderr]).then(() => {
    childWorkFinished = true;
    return true;
  });

  const startCleanup = (signal: NodeJS.Signals): Promise<void> => {
    if (childWorkFinished || child.exitCode !== null) return Promise.resolve();
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        signalGroup(child.pid, signal);
      } catch {
        /* best effort for an exiting or already-exited owned group */
      }
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), 2_000);
      });
      const settledWithinGrace = await Promise.race([workSettled, grace]);
      if (graceTimer) clearTimeout(graceTimer);
      if (!settledWithinGrace && child.exitCode === null) {
        try {
          signalGroup(child.pid, 'SIGKILL');
        } catch {
          /* best effort for an exiting or already-exited owned group */
        }
        await workSettled;
      }
    })();
    return cleanupPromise;
  };

  const stopSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const onSignal = (signal: NodeJS.Signals) => {
    if (interruptedBy) return;
    interruptedBy = signal;
    void startCleanup(signal);
  };
  for (const signal of stopSignals) process.on(signal, onSignal);

  const timer = setInterval(
    () => {
      if (diagnosticsStopped || diagnosticTask) return;
      const now = Date.now();
      const quietMs = now - lastOutputAt;
      if (quietMs < afterMs || now - lastDiagnosticAt < everyMs) return;
      lastDiagnosticAt = now;
      diagnosticTask = (async () => {
        try {
          const sampler = options.procSampler ?? sampleProc;
          let sample: ProcSample;
          try {
            sample = await sampler(child.pid);
          } catch {
            sample = { available: false, reason: 'unavailable' };
          }
          let cpuDeltaTicks: number | null = null;
          if (sample.available) {
            if (previousCpuTicks !== null && sample.cpuTicks >= previousCpuTicks) {
              cpuDeltaTicks = sample.cpuTicks - previousCpuTicks;
            }
            previousCpuTicks = sample.cpuTicks;
          } else {
            // The next valid sample starts a new baseline after proc was unavailable.
            previousCpuTicks = null;
          }
          const line = diagnosticLine(
            child.pid,
            Date.now() - startedAt,
            Date.now() - lastOutputAt,
            headerState.last,
            sample,
            cpuDeltaTicks,
          );
          await writeChunk(stderr, new TextEncoder().encode(line));
        } catch (error) {
          diagnosticWriteError = error;
          await startCleanup('SIGTERM');
        } finally {
          diagnosticTask = null;
        }
      })();
    },
    Math.min(everyMs, 1_000),
  );
  timer.unref();

  const stopDiagnostics = async () => {
    diagnosticsStopped = true;
    clearInterval(timer);
    const activeTask = diagnosticTask;
    if (activeTask) await activeTask;
  };

  try {
    const [exitCode] = await Promise.all([child.exited, forwardStdout, forwardStderr]);
    await stopDiagnostics();
    if (cleanupPromise) await cleanupPromise;
    if (diagnosticWriteError) throw diagnosticWriteError;
    return {
      exitCode: interruptedBy ? 128 + (interruptedBy === 'SIGINT' ? 2 : 15) : (exitCode ?? 1),
      lastTestFile: headerState.last,
    };
  } catch (error) {
    await startCleanup('SIGTERM');
    await stopDiagnostics();
    throw error;
  } finally {
    await stopDiagnostics();
    for (const signal of stopSignals) process.off(signal, onSignal);
  }
}

if (import.meta.main) {
  const result = await runChild([process.execPath, 'test', ...process.argv.slice(2)]);
  process.exitCode = result.exitCode;
}
