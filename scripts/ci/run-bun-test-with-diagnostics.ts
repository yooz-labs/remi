import {
  constants,
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';

type WaitThreadSample = { tid: number; state: string | null; waitChannel: string | null };
type WaitChildSample = { pid: number; state: string; waitChannel: string | null };
type WaitTopology = {
  threads: WaitThreadSample[];
  threadsTruncated: boolean;
  children: WaitChildSample[] | null;
  childrenTruncated: boolean;
};
type LoggingStage =
  | 'module-body'
  | 'setup:entered'
  | 'setup:tempdir'
  | 'setup:reset'
  | 'first:entered'
  | 'first:opened'
  | 'first:read';
type LoggingStageSnapshot = { stages: { pid: number; stage: LoggingStage }[]; truncated: boolean };
type LoggingStageChannel = { directory: string; file: string };
type ProcSampleOptions = {
  captureWaitTopology?: boolean;
  expectedParentPid?: number;
  expectedProcessGroupId?: number;
};
type ProcSample =
  | {
      available: true;
      state: string;
      cpuTicks: number;
      threads: number;
      rssPages: number;
      waitChannel: string | null;
      waitTopology?: WaitTopology | null;
    }
  | {
      available: false;
      reason: 'unsupported' | 'unavailable' | 'malformed';
      waitTopology?: WaitTopology | null;
    };

type ProcSampler = (pid: number, options?: ProcSampleOptions) => Promise<ProcSample>;

type RunOptions = {
  stdout?: Writable;
  stderr?: Writable;
  diagnosticAfterMs?: number;
  diagnosticEveryMs?: number;
  procSampler?: ProcSampler;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Enabled by the suite owner only for the rest lane containing log-file.test.ts. */
  captureLoggingStages?: boolean;
  /** Test harness only: pause the real logging test before its module-body stderr checkpoint. */
  testOnlyLoggingStageHoldPath?: string;
  /** Test harness only: replace the owned stage file with a real FIFO before child spawn. */
  testOnlyReplaceLoggingStageFileWithFifo?: boolean;
};

type RunResult = {
  pid: number;
  cleanupVerified: boolean;
  exitCode: number;
  lastTestFile: string | null;
  testFiles: string[];
  ownerLines: string[];
  loggingStages: LoggingStageSnapshot | null;
  loggingStageCleanupVerified: boolean | null;
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
const MAX_PROC_TEXT_BYTES = 4_096;
const MAX_WAIT_CHANNEL_BYTES = 64;
const MAX_WAIT_THREADS = 32;
const MAX_WAIT_CHILDREN = 8;
const MAX_CHILDREN_TEXT_BYTES = 256;
const MAX_LOG_STAGE_FILE_BYTES = 4_096;
const MAX_LOG_STAGE_LINES = 64;
const LOG_STAGE_FILE_ENV = 'REMI_CI_LOG_STAGE_FILE';
const LOG_STAGE_PARENT_ENV = 'REMI_CI_LOG_STAGE_PARENT_PID';
const LOG_STAGE_HOLD_ENV = 'REMI_CI_LOG_STAGE_HOLD_PATH';
const LOG_STAGE_NAMES = new Set<LoggingStage>([
  'module-body',
  'setup:entered',
  'setup:tempdir',
  'setup:reset',
  'first:entered',
  'first:opened',
  'first:read',
]);

function pathWasRemoved(file: string): boolean {
  try {
    lstatSync(file);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function createLoggingStageChannel(stderr: Writable): LoggingStageChannel | null {
  if (typeof constants.O_NOFOLLOW !== 'number') return null;
  let directory: string | null = null;
  let descriptor: number | null = null;
  try {
    directory = mkdtempSync(path.join(tmpdir(), 'remi-ci-log-stages-'));
    chmodSync(directory, 0o700);
    const file = path.join(directory, 'stages');
    descriptor = openSync(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(descriptor);
    descriptor = null;
    return { directory, file };
  } catch {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Channel setup is best effort and never affects the child verdict.
      }
    }
    if (directory) {
      let cleanupVerified = false;
      try {
        rmSync(directory, { recursive: true, force: true });
        cleanupVerified = pathWasRemoved(directory);
      } catch {
        cleanupVerified = pathWasRemoved(directory);
      }
      if (!cleanupVerified) reportLoggingStageCleanupFailure(stderr);
    }
    return null;
  }
}

async function readLoggingStageSnapshot(
  channel: LoggingStageChannel,
  ownedChildPid: number,
): Promise<LoggingStageSnapshot | null> {
  if (typeof constants.O_NOFOLLOW !== 'number') return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      channel.file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) return null;
    const limit = Math.min(info.size, MAX_LOG_STAGE_FILE_BYTES);
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = limit === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, limit, 0);
    const text = buffer.toString('latin1', 0, bytesRead);
    let truncated =
      info.size > MAX_LOG_STAGE_FILE_BYTES || bytesRead < limit || bytesRead < info.size;
    const stages: LoggingStageSnapshot['stages'] = [];
    let lineStart = 0;
    let linesRead = 0;
    for (let index = 0; index < text.length && linesRead < MAX_LOG_STAGE_LINES; index += 1) {
      if (text[index] !== '\n') continue;
      const line = text.slice(lineStart, index);
      lineStart = index + 1;
      linesRead += 1;
      const match = /^(\d{1,10})\t([a-z:-]{1,32})$/.exec(line);
      if (!match?.[1] || !match[2]) continue;
      const pid = Number(match[1]);
      const stage = match[2] as LoggingStage;
      if (pid === ownedChildPid && LOG_STAGE_NAMES.has(stage)) stages.push({ pid, stage });
    }
    if (lineStart < text.length) truncated = true;
    return { stages, truncated };
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function cleanupLoggingStageChannel(channel: LoggingStageChannel | null): boolean | null {
  if (!channel) return null;
  try {
    rmSync(channel.directory, { recursive: true, force: true });
    return pathWasRemoved(channel.directory);
  } catch {
    return pathWasRemoved(channel.directory);
  }
}

function reportLoggingStageCleanupFailure(stderr: Writable): void {
  try {
    stderr.write('[ci-test-diagnostic-stage-cleanup] {"verified":false}\n');
  } catch {
    // Diagnostic reporting must not affect the child verdict.
  }
}

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

type ParsedProcStat = {
  state: string;
  parentPid: number;
  processGroupId: number;
  cpuTicks: number;
  threads: number;
  rssPages: number;
};
type ProcText = { text: string; truncated: boolean };

/** Read a fixed prefix only; procfs fields are small and diagnostic-only. */
async function readProcText(file: string, maxBytes: number): Promise<ProcText | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const length = Math.min(bytesRead, maxBytes);
    return { text: buffer.toString('utf8', 0, length), truncated: bytesRead > maxBytes };
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** Parse only the numeric/state fields needed from Linux /proc/PID/stat. */
function parseProcStat(stat: string): ParsedProcStat | null {
  // comm is parenthesized but may itself contain spaces and closing parentheses.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0]; // field 3; remaining array is zero based from field 3.
  const parentPid = Number(fields[1]); // field 4
  const processGroupId = Number(fields[2]); // field 5
  const userTicks = Number(fields[11]); // field 14
  const systemTicks = Number(fields[12]); // field 15
  const threads = Number(fields[17]); // field 20
  const rssPages = Number(fields[21]); // field 24
  if (
    typeof state !== 'string' ||
    !PROC_STATE.test(state) ||
    ![parentPid, processGroupId, userTicks, systemTicks, threads, rssPages].every(
      Number.isSafeInteger,
    ) ||
    parentPid < 0 ||
    processGroupId < 0 ||
    userTicks < 0 ||
    systemTicks < 0 ||
    threads < 0 ||
    rssPages < 0
  ) {
    return null;
  }
  return {
    state,
    parentPid,
    processGroupId,
    cpuTicks: userTicks + systemTicks,
    threads,
    rssPages,
  };
}

async function readProcStat(file: string): Promise<ParsedProcStat | null> {
  const result = await readProcText(file, MAX_PROC_TEXT_BYTES);
  if (!result || result.truncated) return null;
  return parseProcStat(result.text);
}

async function readWaitChannel(file: string): Promise<string | null> {
  const result = await readProcText(file, MAX_WAIT_CHANNEL_BYTES);
  if (!result || result.truncated) return null;
  const value = result.text.trim();
  return /^[A-Za-z0-9_.]{1,64}$/.test(value) ? value : null;
}

async function readNumericDirectory(
  directoryPath: string,
  limit: number,
): Promise<{ values: number[]; truncated: boolean } | null> {
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  const values: number[] = [];
  let truncated = false;
  try {
    directory = await opendir(directoryPath);
    for (;;) {
      const entry = await directory.read();
      if (!entry) break;
      if (!/^\d+$/.test(entry.name)) continue;
      const value = Number(entry.name);
      if (!Number.isSafeInteger(value) || value < 1) continue;
      if (values.length === limit) {
        truncated = true;
        break;
      }
      values.push(value);
    }
    return { values: values.sort((a, b) => a - b), truncated };
  } catch {
    return null;
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // Directory close is best-effort; Bun may complete it synchronously.
      }
    }
  }
}

/**
 * Capture only the owned child's bounded task/direct-child wait topology.
 * Parent PID and process-group checks reject unrelated or stale entries.
 */
async function readWaitTopology(
  pid: number,
  expectedParentPid: number,
  expectedProcessGroupId: number,
): Promise<WaitTopology | null> {
  const owner = await readProcStat(`/proc/${pid}/stat`);
  if (
    !owner ||
    owner.parentPid !== expectedParentPid ||
    owner.processGroupId !== expectedProcessGroupId
  ) {
    return null;
  }
  const taskDirectory = await readNumericDirectory(`/proc/${pid}/task`, MAX_WAIT_THREADS);
  if (!taskDirectory) return null;

  const threads = await Promise.all(
    taskDirectory.values.map(async (tid): Promise<WaitThreadSample> => {
      const taskPath = `/proc/${pid}/task/${tid}`;
      const stat = await readProcStat(`${taskPath}/stat`);
      return {
        tid,
        state: stat?.state ?? null,
        waitChannel: await readWaitChannel(`${taskPath}/wchan`),
      };
    }),
  );

  const childPids = new Set<number>();
  let childrenTruncated = false;
  let childrenAvailable = true;
  for (const tid of taskDirectory.values) {
    const childList = await readProcText(
      `/proc/${pid}/task/${tid}/children`,
      MAX_CHILDREN_TEXT_BYTES,
    );
    if (!childList) {
      childrenAvailable = false;
      continue;
    }
    if (childList.truncated) childrenTruncated = true;
    const completeText = childList.truncated
      ? childList.text.slice(0, childList.text.lastIndexOf(' ') + 1)
      : childList.text;
    for (const token of completeText.trim().split(/\s+/).filter(Boolean)) {
      if (!/^\d+$/.test(token)) {
        childrenAvailable = false;
        continue;
      }
      const childPid = Number(token);
      if (!Number.isSafeInteger(childPid) || childPid < 1 || childPids.has(childPid)) continue;
      if (childPids.size === MAX_WAIT_CHILDREN) {
        childrenTruncated = true;
        break;
      }
      childPids.add(childPid);
    }
  }

  const children = await Promise.all(
    [...childPids].map(async (childPid): Promise<WaitChildSample | null> => {
      const stat = await readProcStat(`/proc/${childPid}/stat`);
      // The children list can race with exit and PID reuse. Keep only a current direct child.
      if (!stat || stat.parentPid !== pid) return null;
      return {
        pid: childPid,
        state: stat.state,
        waitChannel: await readWaitChannel(`/proc/${childPid}/wchan`),
      };
    }),
  );

  if (children.some((child) => child === null)) childrenAvailable = false;
  const ownerAfter = await readProcStat(`/proc/${pid}/stat`);
  if (
    !ownerAfter ||
    ownerAfter.parentPid !== expectedParentPid ||
    ownerAfter.processGroupId !== expectedProcessGroupId
  ) {
    return null;
  }
  return {
    threads,
    threadsTruncated: taskDirectory.truncated,
    children: childrenAvailable
      ? children.filter((child): child is WaitChildSample => child !== null)
      : null,
    childrenTruncated,
  };
}

/** Parse bounded Linux /proc metadata; optional topology is emitted only for the owned child. */
export async function sampleProc(
  pid: number,
  options: ProcSampleOptions = {},
): Promise<ProcSample> {
  const topologyUnavailable = options.captureWaitTopology ? { waitTopology: null } : {};
  if (process.platform !== 'linux')
    return { available: false, reason: 'unsupported', ...topologyUnavailable };
  const statText = await readProcText(`/proc/${pid}/stat`, MAX_PROC_TEXT_BYTES);
  if (!statText) return { available: false, reason: 'unavailable', ...topologyUnavailable };
  if (statText.truncated) return { available: false, reason: 'malformed', ...topologyUnavailable };
  const stat = parseProcStat(statText.text);
  if (!stat) return { available: false, reason: 'malformed', ...topologyUnavailable };
  if (
    (options.expectedParentPid !== undefined && stat.parentPid !== options.expectedParentPid) ||
    (options.expectedProcessGroupId !== undefined &&
      stat.processGroupId !== options.expectedProcessGroupId)
  ) {
    return { available: false, reason: 'unavailable', ...topologyUnavailable };
  }

  // #1206: state S and a leader wait channel do not distinguish a runtime wait from a worker or child.
  // The one-time topology is capped and contains only TIDs/PIDs, states, and sanitized kernel symbols.
  const waitTopology =
    options.captureWaitTopology &&
    options.expectedParentPid !== undefined &&
    options.expectedProcessGroupId === pid
      ? await readWaitTopology(
          pid,
          options.expectedParentPid,
          options.expectedProcessGroupId,
        ).catch(() => null)
      : undefined;
  return {
    available: true,
    state: stat.state,
    cpuTicks: stat.cpuTicks,
    threads: stat.threads,
    rssPages: stat.rssPages,
    waitChannel: await readWaitChannel(`/proc/${pid}/wchan`),
    ...(options.captureWaitTopology ? { waitTopology: waitTopology ?? null } : {}),
  };
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
  loggingStages?: LoggingStageSnapshot | null,
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
    ...(loggingStages !== undefined ? { loggingStages } : {}),
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
  const loggingStageChannel = options.captureLoggingStages
    ? createLoggingStageChannel(stderr)
    : null;
  if (options.testOnlyReplaceLoggingStageFileWithFifo) {
    try {
      if (!loggingStageChannel) throw new Error('No stage channel');
      unlinkSync(loggingStageChannel.file);
      const result = Bun.spawnSync(['mkfifo', loggingStageChannel.file], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      if (result.exitCode !== 0) throw new Error('mkfifo failed');
    } catch {
      const cleanupVerified = cleanupLoggingStageChannel(loggingStageChannel);
      if (cleanupVerified === false) reportLoggingStageCleanupFailure(stderr);
      throw new Error('Test-only stage FIFO setup failed');
    }
  }
  const childEnv = { ...(options.env ?? process.env) };
  delete childEnv[LOG_STAGE_FILE_ENV];
  delete childEnv[LOG_STAGE_PARENT_ENV];
  delete childEnv[LOG_STAGE_HOLD_ENV];
  if (loggingStageChannel) {
    childEnv[LOG_STAGE_FILE_ENV] = loggingStageChannel.file;
    childEnv[LOG_STAGE_PARENT_ENV] = String(process.pid);
  }
  if (options.testOnlyLoggingStageHoldPath)
    childEnv[LOG_STAGE_HOLD_ENV] = options.testOnlyLoggingStageHoldPath;
  const child = (() => {
    try {
      return Bun.spawn(command, {
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: childEnv,
      });
    } catch (error) {
      const cleanupVerified = cleanupLoggingStageChannel(loggingStageChannel);
      if (cleanupVerified === false) reportLoggingStageCleanupFailure(stderr);
      throw error;
    }
  })();
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
  let firstQuietDiagnostic = true;
  let loggingStages: LoggingStageSnapshot | null = null;
  let loggingStageCleanupVerified: boolean | null = null;
  let loggingStageChannelFinalized = false;
  const finishLoggingStageChannel = async () => {
    if (loggingStageChannelFinalized) return;
    if (loggingStageChannel) {
      loggingStages = await readLoggingStageSnapshot(loggingStageChannel, child.pid);
      loggingStageCleanupVerified = cleanupLoggingStageChannel(loggingStageChannel);
      if (loggingStageCleanupVerified === false) reportLoggingStageCleanupFailure(stderr);
    }
    loggingStageChannelFinalized = true;
  };
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
      const captureWaitTopology = firstQuietDiagnostic;
      firstQuietDiagnostic = false;
      diagnosticTask = (async () => {
        try {
          const sampler = options.procSampler ?? sampleProc;
          const safeSample = async (
            pid: number,
            sampleOptions?: ProcSampleOptions,
          ): Promise<ProcSample> => {
            try {
              return await sampler(pid, sampleOptions);
            } catch {
              return {
                available: false,
                reason: 'unavailable',
                ...(sampleOptions?.captureWaitTopology ? { waitTopology: null } : {}),
              };
            }
          };
          const [sample, wrapperSample] = await Promise.all([
            safeSample(child.pid, {
              captureWaitTopology,
              expectedParentPid: process.pid,
              expectedProcessGroupId: child.pid,
            }),
            safeSample(process.pid),
          ]);
          const sampledLoggingStages =
            loggingStageChannel &&
            options.captureLoggingStages &&
            (sample.available || child.exitCode === null)
              ? await readLoggingStageSnapshot(loggingStageChannel, child.pid)
              : options.captureLoggingStages
                ? null
                : undefined;
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
            sampledLoggingStages,
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
    await finishLoggingStageChannel();
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
      loggingStages,
      loggingStageCleanupVerified,
    };
  } catch (error) {
    await startCleanup('SIGTERM');
    await stopDiagnostics();
    await finishLoggingStageChannel();
    throw error;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    await stopDiagnostics();
    await finishLoggingStageChannel();
    for (const signal of stopSignals) process.off(signal, onSignal);
  }
}

if (import.meta.main) {
  const result = await runChild([process.execPath, 'test', ...process.argv.slice(2)]);
  process.exitCode = result.exitCode;
}
