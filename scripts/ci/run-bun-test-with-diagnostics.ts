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
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
};

type RunResult = {
  pid: number;
  cleanupVerified: boolean;
  exitCode: number;
  lastTestFile: string | null;
  testFiles: string[];
  ownerLines: string[];
};
type HeaderState = { last: string | null; files: string[]; ownerLines: string[] };
type StreamForwardState = {
  bytesRead: number;
  // Bytes whose destination write callback and any required drain both completed.
  bytesForwarded: number;
  pendingWriteBytes: number;
  pendingWriteStartedAt: number | null;
  callbackPending: boolean;
  callbackStartedAt: number | null;
  drainPending: boolean;
  drainStartedAt: number | null;
};
type StreamForwardSnapshot = {
  bytesRead: number;
  bytesForwarded: number;
  pendingWriteBytes: number;
  pendingWriteAgeMs: number | null;
  callbackPending: boolean;
  callbackWaitMs: number | null;
  drainPending: boolean;
  drainWaitMs: number | null;
};
type ForwardSnapshot = { stdout: StreamForwardSnapshot; stderr: StreamForwardSnapshot };

const TEST_HEADER =
  /^(?:::group::)?((?:[A-Za-z0-9_.-]+\/)*[^\s:]+(?:\.test|_test|\.spec|_spec)\.[cm]?[jt]sx?):$/;
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
    // Bun prefixes its actual test header with an Actions group marker in CI.
    // Normalize only the parsing view; forwarded output bytes stay unchanged.
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^::group::/, '');
    const match = TEST_HEADER.exec(plain);
    const path = match?.[1];
    if (path) {
      this.state.last = path;
      this.state.files.push(path);
    }
    if (plain.startsWith('[ci-target-module-owner] ')) this.state.ownerLines.push(plain);
  }
}

function createStreamForwardState(): StreamForwardState {
  return {
    bytesRead: 0,
    bytesForwarded: 0,
    pendingWriteBytes: 0,
    pendingWriteStartedAt: null,
    callbackPending: false,
    callbackStartedAt: null,
    drainPending: false,
    drainStartedAt: null,
  };
}

function elapsedSince(startedAt: number | null): number | null {
  return startedAt === null ? null : Math.max(0, Math.round(performance.now() - startedAt));
}

function snapshotStreamForward(state: StreamForwardState): StreamForwardSnapshot {
  return {
    bytesRead: state.bytesRead,
    bytesForwarded: state.bytesForwarded,
    pendingWriteBytes: state.pendingWriteBytes,
    pendingWriteAgeMs: elapsedSince(state.pendingWriteStartedAt),
    callbackPending: state.callbackPending,
    callbackWaitMs: elapsedSince(state.callbackStartedAt),
    drainPending: state.drainPending,
    drainWaitMs: elapsedSince(state.drainStartedAt),
  };
}

function snapshotForward(state: {
  stdout: StreamForwardState;
  stderr: StreamForwardState;
}): ForwardSnapshot {
  return {
    stdout: snapshotStreamForward(state.stdout),
    stderr: snapshotStreamForward(state.stderr),
  };
}

async function writeChunk(
  stream: Writable,
  chunk: Uint8Array,
  forwardState?: StreamForwardState,
): Promise<void> {
  const startedAt = performance.now();
  if (forwardState) {
    forwardState.pendingWriteBytes = chunk.byteLength;
    forwardState.pendingWriteStartedAt = startedAt;
    forwardState.callbackPending = true;
    forwardState.callbackStartedAt = startedAt;
    forwardState.drainPending = false;
    forwardState.drainStartedAt = null;
  }

  await new Promise<void>((resolve, reject) => {
    let callReturned = false;
    let writeDone = false;
    let drainDone = true;
    let settled = false;
    const clearForwardState = () => {
      if (!forwardState) return;
      forwardState.pendingWriteBytes = 0;
      forwardState.pendingWriteStartedAt = null;
      forwardState.callbackPending = false;
      forwardState.callbackStartedAt = null;
      forwardState.drainPending = false;
      forwardState.drainStartedAt = null;
    };

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
          clearForwardState();
          reject(error);
        }, 0);
        return;
      }
      if (callReturned && writeDone && drainDone) {
        settled = true;
        cleanup();
        clearForwardState();
        resolve();
      }
    };
    const onError = (error: Error) => finish(error);
    const onDrain = () => {
      drainDone = true;
      if (forwardState) {
        forwardState.drainPending = false;
        forwardState.drainStartedAt = null;
      }
      finish();
    };

    stream.on('error', onError);
    try {
      const accepted = stream.write(chunk, (error?: Error | null) => {
        if (error) {
          if (forwardState) {
            forwardState.callbackPending = false;
            forwardState.callbackStartedAt = null;
          }
          finish(error);
          return;
        }
        writeDone = true;
        if (forwardState) {
          forwardState.callbackPending = false;
          forwardState.callbackStartedAt = null;
        }
        finish();
      });
      if (!accepted) {
        drainDone = false;
        if (forwardState) {
          forwardState.drainPending = true;
          forwardState.drainStartedAt = performance.now();
        }
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
  forwardState: StreamForwardState,
  onOutput: () => void,
): Promise<void> {
  const reader = source.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tracker.add(value);
      forwardState.bytesRead += value.byteLength;
      onOutput();
      await writeChunk(destination, value, forwardState);
      forwardState.bytesForwarded += value.byteLength;
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

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
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
  wrapperSample: ProcSample,
  wrapperCpuDeltaTicks: number | null,
  streams: ForwardSnapshot,
): string {
  const processData = sample.available
    ? { ...sample, cpuDeltaTicks }
    : { ...sample, cpuDeltaTicks: null };
  const wrapperProcessData = wrapperSample.available
    ? { ...wrapperSample, cpuDeltaTicks: wrapperCpuDeltaTicks }
    : { ...wrapperSample, cpuDeltaTicks: null };
  return `[ci-test-diagnostic] ${JSON.stringify({
    childPid: pid,
    wrapperPid: process.pid,
    elapsedMs,
    quietMs,
    lastTestFile: header,
    process: processData,
    wrapperProcess: wrapperProcessData,
    streams,
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

  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    throw new RangeError('child timeout must be positive finite milliseconds');
  }
  const child = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const headerState: HeaderState = { last: null, files: [], ownerLines: [] };
  const stdoutTracker = new HeaderTracker(headerState);
  const stderrTracker = new HeaderTracker(headerState);
  const streamForwardState = {
    stdout: createStreamForwardState(),
    stderr: createStreamForwardState(),
  };
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  let lastDiagnosticAt = 0;
  let previousCpuTicks: number | null = null;
  let previousWrapperCpuTicks: number | null = null;
  let interruptedBy: NodeJS.Signals | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let diagnosticWriteError: unknown = null;
  let diagnosticsStopped = false;
  let diagnosticTask: Promise<void> | null = null;
  const onOutput = () => {
    lastOutputAt = Date.now();
  };
  const forwardStdout = forward(
    child.stdout,
    stdout,
    stdoutTracker,
    streamForwardState.stdout,
    onOutput,
  );
  const forwardStderr = forward(
    child.stderr,
    stderr,
    stderrTracker,
    streamForwardState.stderr,
    onOutput,
  );
  let childWorkFinished = false;
  const workSettled = Promise.allSettled([child.exited, forwardStdout, forwardStderr]).then(() => {
    childWorkFinished = true;
    return true;
  });

  const startCleanup = (signal: NodeJS.Signals): Promise<void> => {
    if (childWorkFinished && options.timeoutMs === undefined) return Promise.resolve();
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      signalGroup(child.pid, signal);
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), 2_000);
      });
      const settledWithinGrace = await Promise.race([workSettled, grace]);
      if (graceTimer) clearTimeout(graceTimer);
      if (!settledWithinGrace || (options.timeoutMs !== undefined && groupAlive(child.pid))) {
        signalGroup(child.pid, 'SIGKILL');
        let reapTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            workSettled,
            new Promise<never>((_, reject) => {
              reapTimer = setTimeout(
                () => reject(new Error('Owned child/pipe cleanup exceeded 2 seconds')),
                2_000,
              );
            }),
          ]);
        } finally {
          if (reapTimer) clearTimeout(reapTimer);
        }
      }
      if (options.timeoutMs !== undefined) {
        const end = Date.now() + 2_000;
        while (groupAlive(child.pid) && Date.now() < end) await Bun.sleep(10);
        if (groupAlive(child.pid))
          throw new Error('Owned process group still exists after cleanup');
      }
    })();
    return cleanupPromise;
  };

  let deadlineExpired = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    if (options.timeoutMs !== undefined) {
      deadlineTimer = setTimeout(() => {
        deadlineExpired = true;
        void startCleanup('SIGTERM').then(
          () => reject(new Error('CI child deadline exceeded')),
          (error: unknown) => reject(error),
        );
      }, options.timeoutMs);
    }
  });

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
      const streams = snapshotForward(streamForwardState);
      diagnosticTask = (async () => {
        try {
          const sampler = options.procSampler ?? sampleProc;
          const safeSample = async (pid: number): Promise<ProcSample> => {
            try {
              return await sampler(pid);
            } catch {
              return { available: false, reason: 'unavailable' };
            }
          };
          const [sample, wrapperSample] = await Promise.all([
            safeSample(child.pid),
            safeSample(process.pid),
          ]);
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
          let wrapperCpuDeltaTicks: number | null = null;
          if (wrapperSample.available) {
            if (
              previousWrapperCpuTicks !== null &&
              wrapperSample.cpuTicks >= previousWrapperCpuTicks
            ) {
              wrapperCpuDeltaTicks = wrapperSample.cpuTicks - previousWrapperCpuTicks;
            }
            previousWrapperCpuTicks = wrapperSample.cpuTicks;
          } else {
            previousWrapperCpuTicks = null;
          }
          const line = diagnosticLine(
            child.pid,
            Date.now() - startedAt,
            Date.now() - lastOutputAt,
            headerState.last,
            sample,
            cpuDeltaTicks,
            wrapperSample,
            wrapperCpuDeltaTicks,
            streams,
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
    if (diagnosticsStopped) return;
    diagnosticsStopped = true;
    clearInterval(timer);
    const activeTask = diagnosticTask;
    if (activeTask) {
      if (options.timeoutMs === undefined) await activeTask;
      else {
        let joinTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            activeTask,
            new Promise<never>((_, reject) => {
              joinTimer = setTimeout(
                () => reject(new Error('Diagnostic forwarding did not join')),
                2_000,
              );
            }),
          ]);
        } finally {
          if (joinTimer) clearTimeout(joinTimer);
        }
      }
    }
  };

  try {
    const [exitCode] = await Promise.race([
      Promise.all([child.exited, forwardStdout, forwardStderr]),
      deadline,
    ]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (deadlineExpired) {
      await startCleanup('SIGTERM');
      throw new Error('CI child deadline exceeded');
    }
    await stopDiagnostics();
    if (cleanupPromise) await cleanupPromise;
    if (diagnosticWriteError) throw diagnosticWriteError;
    if (options.timeoutMs !== undefined && groupAlive(child.pid)) {
      await startCleanup('SIGTERM');
      throw new Error('Child left an owned descendant after exit');
    }
    return {
      pid: child.pid,
      cleanupVerified: options.timeoutMs !== undefined && !groupAlive(child.pid),
      exitCode: interruptedBy ? 128 + (interruptedBy === 'SIGINT' ? 2 : 15) : (exitCode ?? 1),
      lastTestFile: headerState.last,
      testFiles: headerState.files,
      ownerLines: headerState.ownerLines,
    };
  } catch (error) {
    await startCleanup('SIGTERM');
    await stopDiagnostics();
    throw error;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    await stopDiagnostics();
    for (const signal of stopSignals) process.off(signal, onSignal);
  }
}

if (import.meta.main) {
  const result = await runChild([process.execPath, 'test', ...process.argv.slice(2)]);
  process.exitCode = result.exitCode;
}
