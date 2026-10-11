// #1170 standalone proof: real held hooks, reserved copies and an owned /bin/cat PTY.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type QuestionOption, type UUID, generateId } from '@remi/shared';
import { AutoApproveGate } from '../../packages/daemon/src/auto-approve/auto-approve-gate.ts';
import {
  createInputHandlers,
  gateAnswerDeps,
} from '../../packages/daemon/src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../packages/daemon/src/cli/logger.ts';
import { createMessageApiForSession } from '../../packages/daemon/src/cli/session-phases/message-api-setup.ts';
import { HookServer } from '../../packages/daemon/src/hooks/hook-server.ts';
import { PTYSession } from '../../packages/daemon/src/pty/pty-session.ts';
import { SessionBindingStore } from '../../packages/daemon/src/session/session-binding-store.ts';
import { SessionRegistry } from '../../packages/daemon/src/session/session-registry.ts';
import { SessionStore } from '../../packages/daemon/src/session/session-store.ts';
import { Reservations } from './reservations';
import type { StorageLoadWorkerConfig } from './storage-approval-child';
import type { StorageApprovalClientConfig } from './storage-approval-client';
import {
  type LoadedNativeHelperEvidence,
  type PreparedNativeHelper,
  prepareNativeHelper,
} from './storage-approval-native';

const YES: QuestionOption = {
  label: 'Yes',
  value: '1',
  isYes: true,
  isNo: false,
  isRecommended: true,
};
const NO: QuestionOption = {
  label: 'No',
  value: '2',
  isYes: false,
  isNo: true,
  isRecommended: false,
};
const PROOF_COMMAND = 'echo REMI_TUNNEL_STORAGE_APPROVAL_PROOF';
const STORAGE_LOAD_GROUP = '10 MiB reserved private-copy load progresses around actual held No';
const BLOCK_GROUP = 'synchronous parent block makes held No exceed one second';
const PTY_GROUP = 'actual held No writes zero PTY bytes through reap';
const PTY_MUTATION_GROUP = 'deliberate PTY wrong-write invalidates zero-byte witness';
const INPUT_BYTES = 10 * 1024 * 1024;
const MAX_CLIENT_OUTPUT = 4096;
const MAX_WORKER_OUTPUT = 4096;
const MAX_WORKER_LIFETIME_MS = 5000;
const MAX_WORKER_INTERNAL_DEADLINE_MS = 4000;
const PTY_BARRIER_TIMEOUT_MS = 2000;
const PTY_BARRIER_QUIET_MS = 75;
const ANSWER_LIMIT_MS = 1000;
const PARENT_BLOCK_MS = 1400;

interface WorkerProgress {
  state: 'starting' | 'ready' | 'copying' | 'waiting' | 'stopped';
  completedCopies: number;
  copyStartedAtUnixMs: number | null;
  lastCopyStartedAtUnixMs: number | null;
  lastCopyCompletedAtUnixMs: number | null;
  lastAllocatedBytes: number | null;
  lastSha256: string | null;
  setupMeasurements: {
    initialProgressMs: number | null;
    nativeHelperLoadMs: number | null;
    directoryCaptureMs: number | null;
    sourceAdmissionMs: number | null;
    ledgerInitializationMs: number | null;
    readyAtWorkerMs: number | null;
  };
}

interface PtyBarrierObservation {
  output: string;
  markerCopies: number;
  inputBytes: number;
}

interface DenialScenario {
  scenario: 'storage-load' | 'synchronous-parent-block';
  latencyMs: number;
  sendStartedAtUnixMs: number;
  denyParsedAtUnixMs: number;
  progressBeforeSend: WorkerProgress;
  progressAtDenyParse: WorkerProgress;
  progressAfterDeny: WorkerProgress;
  blockControl: {
    startedAtUnixMs: number;
    sendStartedAtUnixMs: number;
    endedAtUnixMs: number;
    durationMs: number;
  } | null;
  clientPid: number;
  clientReaped: true;
  ptyOutputStart: number;
  ptyObservedMarker: string;
  ptyBarrier: PtyBarrierObservation;
}

interface PtyWitness {
  baselineOutputBytes: number;
  observedOutputBytes: number;
  markerCopies: number;
  baselineOutputSha256: string;
  observedOutputSha256: string;
  answerPathOutputBytes: 0;
  outputMatchedBaseline: true;
  quietWindowMs: number;
  observedThroughReap: true;
}

interface PtyMutationEvidence {
  mutationInput: string;
  baselineOutputBytes: number;
  mutatedOutputBytes: number;
  baselineOutputSha256: string;
  mutatedOutputSha256: string;
  observedMarkerCopies: number;
  outputAssertionRejectedMutation: true;
  childPid: number;
  reaped: true;
}

function childEnv(): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
  };
}

function executable(): string[] {
  return Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];
}

function cgroupDiagnostic(): string {
  return [
    'pids.current',
    'pids.max',
    'pids.events',
    'memory.current',
    'memory.max',
    'memory.events',
  ]
    .map((name) => {
      try {
        return `${name}=${readFileSync(`/sys/fs/cgroup/${name}`, 'utf-8').trim().replace(/\s+/g, ',')}`;
      } catch {
        return `${name}=unavailable`;
      }
    })
    .join('; ');
}

async function readCapped(stream: ReadableStream<Uint8Array>, maximum: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error(`owned child output exceeded ${maximum} bytes`);
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function noChild(pid: number | undefined, witness: string): void {
  assert(pid !== undefined, `${witness}: child PID recorded`);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${witness}: child reaped`);
}

function occurrences(value: string, marker: string): number {
  let count = 0;
  let index = 0;
  while (index !== -1) {
    index = value.indexOf(marker, index);
    if (index === -1) break;
    count++;
    index += marker.length;
  }
  return count;
}

function normalizeBarrier(value: string, marker: string): string {
  return value.split(marker).join('<PTY_BARRIER>');
}

function sha256Text(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function assertNoAnswerPathPtyBytes(
  observed: string,
  baseline: string,
  observedMarker: string,
  baselineMarker: string,
): void {
  assert.equal(
    normalizeBarrier(observed, observedMarker),
    normalizeBarrier(baseline, baselineMarker),
    'zero-PTY witness: actual held No produced zero PTY bytes before the /bin/cat drain barrier',
  );
}

async function writeAndObservePtyBarrier(
  pty: PTYSession,
  readOutput: () => string,
  marker: string,
  outputStart: number,
): Promise<PtyBarrierObservation> {
  const barrierInput = `\n${marker}\n`;
  await pty.write(barrierInput);
  const deadline = performance.now() + PTY_BARRIER_TIMEOUT_MS;
  let lastLength = -1;
  let quietSince = performance.now();
  while (performance.now() < deadline) {
    const completeOutput = readOutput();
    if (completeOutput.length !== lastLength) {
      lastLength = completeOutput.length;
      quietSince = performance.now();
    }
    const output = completeOutput.slice(outputStart);
    const markerCopies = occurrences(output, marker);
    if (markerCopies >= 2 && performance.now() - quietSince >= PTY_BARRIER_QUIET_MS)
      return { output, markerCopies, inputBytes: Buffer.byteLength(barrierInput) };
    await Bun.sleep(5);
  }
  throw new Error('owned /bin/cat did not return the real PTY barrier and terminal echo');
}

function ptyBarrierMarkers(index: number): { baseline: string; observed: string } {
  const nonce = generateId().replaceAll('-', '').slice(0, 8).toUpperCase();
  return {
    baseline: `REMI_STORAGE_BARRIER_A_${nonce}`,
    observed: `REMI_STORAGE_BARRIER_B${index}_${nonce}`,
  };
}

function blockCpu(milliseconds: number): void {
  const end = performance.now() + milliseconds;
  let value = 0x2468ace0;
  let iterations = 0;
  while (performance.now() < end) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    iterations++;
  }
  assert(iterations > 0 && Number.isInteger(value), 'parent performed synchronous CPU work');
}

function generateOwnedInput(filename: string): string {
  const fd = openSync(filename, 'wx', 0o600);
  const digest = createHash('sha256');
  try {
    let offset = 0;
    while (offset < INPUT_BYTES) {
      const bytes = randomBytes(Math.min(64 * 1024, INPUT_BYTES - offset));
      let written = 0;
      while (written < bytes.length) {
        const amount = writeSync(fd, bytes, written, bytes.length - written, offset + written);
        assert(amount > 0, 'generated owned input write made progress');
        written += amount;
      }
      digest.update(bytes);
      offset += bytes.length;
    }
    return digest.digest('hex');
  } finally {
    fsyncClose(fd);
  }
}

function createStorageFixture(): { directory: string; inputSha256: string } {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'remi-storage-approval-')));
  try {
    chmodSync(directory, 0o700);
    mkdirSync(join(directory, 'project'), { mode: 0o700 });
    mkdirSync(join(directory, 'private'), { mode: 0o700 });
    const inputSha256 = generateOwnedInput(join(directory, 'project', 'payload.bin'));
    return { directory, inputSha256 };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function fsyncClose(fd: number): void {
  try {
    // The generated input is complete before any child opens its descriptor.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function readProgress(path: string): Promise<WorkerProgress | null> {
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as WorkerProgress;
    if (!Number.isSafeInteger(value.completedCopies)) return null;
    return value;
  } catch {
    return null;
  }
}

async function waitForProgress(
  path: string,
  predicate: (progress: WorkerProgress) => boolean,
  worker: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  workerStderr: Promise<string>,
  timeoutMs: number,
  witness: string,
): Promise<WorkerProgress> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      const detail = await workerStderr;
      throw new Error(
        `${witness}: storage worker exited early (exit=${worker.exitCode}, signal=${worker.signalCode}): ${detail}; ${cgroupDiagnostic()}`,
      );
    }
    const progress = await readProgress(path);
    if (progress && predicate(progress)) return progress;
    await Bun.sleep(2);
  }
  throw new Error(`${witness}: storage worker progress timed out; ${cgroupDiagnostic()}`);
}

async function waitForClientFile(
  path: string,
  client: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  clientStderr: Promise<string>,
): Promise<void> {
  const deadline = performance.now() + 15000;
  while (!existsSync(path) && performance.now() < deadline) {
    if (client.exitCode !== null || client.signalCode !== null) {
      const detail = await clientStderr;
      throw new Error(
        `independent compiled client exited before readiness (exit=${client.exitCode}, signal=${client.signalCode}): ${detail}; ${cgroupDiagnostic()}`,
      );
    }
    await Bun.sleep(5);
  }
  assert(existsSync(path), 'independent compiled answer client became ready');
}

async function waitForCopyAfterDeny(
  progressPath: string,
  worker: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  workerStderr: Promise<string>,
  previous: WorkerProgress,
  denyParsedAtUnixMs: number,
): Promise<WorkerProgress> {
  return waitForProgress(
    progressPath,
    (value) =>
      value.completedCopies > previous.completedCopies &&
      value.lastCopyCompletedAtUnixMs !== null &&
      value.lastCopyCompletedAtUnixMs > denyParsedAtUnixMs,
    worker,
    workerStderr,
    1800,
    'actual storage progress after deny parse',
  );
}

async function oneDenial(
  index: number,
  scenario: DenialScenario['scenario'],
  blockParent: boolean,
  args: {
    directory: string;
    sessionId: UUID;
    hookServer: HookServer;
    answerServer: ReturnType<typeof Bun.serve>;
    gate: AutoApproveGate;
    registry: SessionRegistry;
    handlers: ReturnType<typeof createInputHandlers>;
    getQuestionId: () => UUID | undefined;
    progressPath: string;
    worker: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
    workerStderr: Promise<string>;
    pty: PTYSession;
    readPtyOutput: () => string;
  },
): Promise<DenialScenario> {
  const readyPath = join(args.directory, `client-${index}-ready`);
  const triggerPath = join(args.directory, `client-${index}-trigger`);
  const sentPath = join(args.directory, `client-${index}-sent`);
  const questionPath = join(args.directory, `client-${index}-question`);
  const config: StorageApprovalClientConfig = {
    hookUrl: String(args.hookServer.url),
    answerUrl: new URL('/answer', args.answerServer.url).toString(),
    sessionId: args.sessionId,
    questionPath,
    proofCommand: PROOF_COMMAND,
    answerNoValue: NO.value,
    cwd: args.directory,
    readyPath,
    triggerPath,
    sentPath,
    sendDelayMs: blockParent ? 60 : 0,
  };
  const client = Bun.spawn([...executable(), '--storage-approval-client', JSON.stringify(config)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnv(),
  });
  const clientPid = client.pid;
  const clientWatchdog = setTimeout(() => {
    if (client.exitCode === null && client.signalCode === null) client.kill('SIGKILL');
  }, 5000);
  const clientOutput = readCapped(client.stdout, MAX_CLIENT_OUTPUT);
  const clientStderr = readCapped(client.stderr, MAX_CLIENT_OUTPUT).catch((error: unknown) =>
    error instanceof Error
      ? `client stderr capture failed: ${error.message}`
      : 'client stderr capture failed',
  );
  void clientOutput.catch(() => {});
  let clientResult!: {
    latencyMs: number;
    sendStartedAtUnixMs: number;
    denyParsedAtUnixMs: number;
    answerOutcome: string;
    proofCommand: string;
    hookResponse: { hookSpecificOutput?: { decision?: { behavior?: string } } };
  };
  let clientExit = -1;
  let questionId: UUID | undefined;
  let progressBeforeSend: WorkerProgress | undefined;
  let blockControl: DenialScenario['blockControl'] = null;
  let ptyOutputStart = 0;
  try {
    await waitForClientFile(readyPath, client, clientStderr);
    const cardReady = () => args.gate.hasOpenHookPrompt() && args.getQuestionId() !== undefined;
    const cardDeadline = performance.now() + 4000;
    while (!cardReady() && performance.now() < cardDeadline) await Bun.sleep(5);
    assert(cardReady(), 'real PermissionRequest registered its held question before answer');
    questionId = args.getQuestionId();
    assert(questionId, 'real held question id was observed');
    assert.equal(
      args.registry.getQuestion(args.sessionId, questionId)?.text,
      `Allow Bash: ${PROOF_COMMAND}`,
      'real question card contains the inert captured-style command',
    );
    writeFileSync(questionPath, questionId, { mode: 0o600 });

    progressBeforeSend = await waitForProgress(
      args.progressPath,
      (progress) => progress.completedCopies > 0 && progress.state === 'copying',
      args.worker,
      args.workerStderr,
      2000,
      'actual storage copy is progressing before held No',
    );
    assert(
      progressBeforeSend.lastCopyCompletedAtUnixMs !== null &&
        progressBeforeSend.lastCopyStartedAtUnixMs !== null &&
        progressBeforeSend.lastCopyStartedAtUnixMs <= Date.now(),
      'actual completed 10 MiB copies precede held No while the next real copy is in progress',
    );
    ptyOutputStart = args.readPtyOutput().length;
    if (blockParent) {
      const startedAtUnixMs = Date.now();
      const started = performance.now();
      writeFileSync(triggerPath, 'answer', { mode: 0o600 });
      blockCpu(PARENT_BLOCK_MS);
      const durationMs = performance.now() - started;
      const endedAtUnixMs = Date.now();
      assert(existsSync(sentPath), 'independent client sent No during parent CPU block');
      const sendStartedAtUnixMs = Number(readFileSync(sentPath, 'utf-8'));
      assert(
        Number.isSafeInteger(sendStartedAtUnixMs) &&
          sendStartedAtUnixMs >= startedAtUnixMs &&
          sendStartedAtUnixMs <= endedAtUnixMs,
        'independent No send began inside the synchronous parent block',
      );
      assert(
        durationMs >= PARENT_BLOCK_MS,
        'parent completed more than 1000 ms synchronous CPU work',
      );
      blockControl = { startedAtUnixMs, sendStartedAtUnixMs, endedAtUnixMs, durationMs };
    } else {
      writeFileSync(triggerPath, 'answer', { mode: 0o600 });
    }

    const [exit, output, stderr] = await Promise.all([client.exited, clientOutput, clientStderr]);
    clientExit = exit;
    assert.equal(exit, 0, `independent compiled answer client exit: ${stderr}`);
    clientResult = JSON.parse(output) as typeof clientResult;
  } finally {
    clearTimeout(clientWatchdog);
    if (client.exitCode === null && client.signalCode === null) client.kill('SIGKILL');
    await client.exited;
    noChild(clientPid, 'independent compiled answer client');
  }
  assert(Number.isInteger(clientExit), 'independent client process exit was captured');
  assert(questionId && progressBeforeSend, 'held client and actual storage progress were captured');
  assert(
    Number.isSafeInteger(clientResult.sendStartedAtUnixMs) &&
      Number.isSafeInteger(clientResult.denyParsedAtUnixMs) &&
      clientResult.denyParsedAtUnixMs >= clientResult.sendStartedAtUnixMs,
    'independent client recorded send and parsed-deny timestamps in order',
  );
  if (blockControl)
    assert.equal(
      clientResult.sendStartedAtUnixMs,
      blockControl.sendStartedAtUnixMs,
      'independent client output matches its send marker during parent block',
    );
  assert.equal(clientResult.answerOutcome, 'delivered', 'client parsed real relayAnswer outcome');
  assert.equal(clientResult.proofCommand, PROOF_COMMAND, 'client held the inert proof command');
  assert.equal(
    clientResult.hookResponse.hookSpecificOutput?.decision?.behavior,
    'deny',
    'actual-denial witness: client parsed the original held PermissionRequest HTTP deny',
  );
  assert.equal(args.gate.hasOpenHookPrompt(), false, 'actual denied held permission closed');
  assert.equal(args.registry.getQuestion(args.sessionId, questionId), null, 'denied card removed');
  assert.equal(
    await args.handlers.relayAnswer(args.sessionId, questionId, NO.value),
    'delivered',
    'same-value duplicate reports the first successful answer',
  );
  assert.equal(
    await args.handlers.relayAnswer(args.sessionId, questionId, YES.value),
    'stale',
    'conflicting answer for the removed question is stale',
  );

  if (blockParent)
    assert(
      clientResult.latencyMs > ANSWER_LIMIT_MS,
      'causal block control makes independent client-measured held No exceed one second',
    );
  else
    assert(
      clientResult.latencyMs <= ANSWER_LIMIT_MS,
      'independent client-measured held No meets the one-second bound under actual storage load',
    );
  const progressAtDenyParse = await readProgress(args.progressPath);
  assert(progressAtDenyParse, 'atomic storage progress receipt is readable at deny parse');
  assert(
    progressAtDenyParse.completedCopies >= progressBeforeSend.completedCopies,
    'actual-copy witness: load progress never moves backward during held No',
  );
  const progressAfterDeny = await waitForCopyAfterDeny(
    args.progressPath,
    args.worker,
    args.workerStderr,
    progressAtDenyParse,
    clientResult.denyParsedAtUnixMs,
  );
  const markers = ptyBarrierMarkers(index);
  const ptyBarrier = await writeAndObservePtyBarrier(
    args.pty,
    args.readPtyOutput,
    markers.observed,
    ptyOutputStart,
  );
  const scenarioResult: DenialScenario = {
    scenario,
    latencyMs: clientResult.latencyMs,
    sendStartedAtUnixMs: clientResult.sendStartedAtUnixMs,
    denyParsedAtUnixMs: clientResult.denyParsedAtUnixMs,
    progressBeforeSend,
    progressAtDenyParse,
    progressAfterDeny,
    blockControl,
    clientPid,
    clientReaped: true,
    ptyOutputStart,
    ptyObservedMarker: markers.observed,
    ptyBarrier,
  };
  assert(scenarioResult.clientPid > 0, 'independent client PID is positive');
  return scenarioResult;
}

function workerConfig(
  directory: string,
  inputSha256: string,
  nativeHelper: PreparedNativeHelper,
): StorageLoadWorkerConfig {
  return {
    fixtureRoot: directory,
    nativeHelper,
    inputPath: join(directory, 'project', 'payload.bin'),
    projectPath: join(directory, 'project'),
    privatePath: join(directory, 'private'),
    ledgerPath: join(directory, 'ledger.json'),
    progressPath: join(directory, 'load-progress.json'),
    stopPath: join(directory, 'load-stop'),
    expectedBytes: INPUT_BYTES,
    expectedSha256: inputSha256,
  };
}

async function runStorageLoadProof(): Promise<{
  checks: string[];
  scenarios: DenialScenario[];
  worker: {
    pid: number;
    exitCode: number;
    reaped: true;
    copies: number;
    lifetimeMs: number;
    workerReportedLifetimeMs: number;
    maxLifetimeMs: number;
    maxWorkers: 1;
    queuedCopies: 0;
    exactSha256: string;
    nativeHelper: LoadedNativeHelperEvidence;
    setupMeasurements: WorkerProgress['setupMeasurements'];
    finalPrivateDirectoryEmpty: true;
    finalLedgerEmpty: true;
  };
  pty: PtyWitness[];
  fixtureRootRemoved: true;
}> {
  const { directory, inputSha256 } = createStorageFixture();
  let nativeHelper: PreparedNativeHelper;
  try {
    // Compile and attest the exact snapshotted helper before creating the held hook.
    nativeHelper = await prepareNativeHelper(directory);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const config = workerConfig(directory, inputSha256, nativeHelper);
  configureLogger({ writeLog: () => {} });
  const sessionId = generateId() as UUID;
  const registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
  let terminalOutput = '';
  const pty = new PTYSession(
    { command: '/bin/cat', args: [], cwd: directory },
    {
      onData: (data) => {
        terminalOutput += data;
      },
    },
  );
  let ptyPid: number | undefined;
  let worker: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let workerStartedAt: number | undefined;
  let workerWatchdog: ReturnType<typeof setTimeout> | undefined;
  let workerOutput: Promise<string> | undefined;
  let workerStderr: Promise<string> | undefined;
  let gate: AutoApproveGate | undefined;
  let hookServer: HookServer | undefined;
  let answerServer: ReturnType<typeof Bun.serve> | undefined;
  let scenarios: DenialScenario[] = [];
  let ptyWitnesses: PtyWitness[] = [];
  let workerResult:
    | {
        pid: number;
        exitCode: number;
        reaped: true;
        copies: number;
        lifetimeMs: number;
        workerReportedLifetimeMs: number;
        nativeHelper: LoadedNativeHelperEvidence;
        setupMeasurements: WorkerProgress['setupMeasurements'];
      }
    | undefined;
  let removed = false;
  try {
    await pty.start();
    ptyPid = pty.childPid ?? undefined;
    assert(ptyPid !== undefined, 'owned /bin/cat PTY has a child PID');
    assert.equal(terminalOutput, '', 'owned /bin/cat is silent before barrier calibration');
    const baselineMarkers = ptyBarrierMarkers(0);
    const baseline = await writeAndObservePtyBarrier(
      pty,
      () => terminalOutput,
      baselineMarkers.baseline,
      0,
    );
    assert(baseline.markerCopies >= 2, 'baseline saw terminal echo and /bin/cat output markers');
    const baselineOutput = baseline.output;

    const { messageApi } = createMessageApiForSession(
      {
        sessionRegistry: registry,
        transcriptWatchers: new Map(),
        deviceTokens: new Map(),
        pushConfig: () => ({ signalingUrl: 'https://owned.invalid' }),
        updateRemiStatus: () => {},
        maxBulletLength: 500,
        sendMessage: () => {},
      },
      sessionId,
    );
    registry.registerSession(sessionId, directory, pty, messageApi);
    const bindingStore = new SessionBindingStore(
      new SessionStore(join(directory, 'sessions.json')),
    );
    let questionId: UUID | undefined;
    gate = new AutoApproveGate(
      {
        sessionRegistry: registry,
        isInSubagentContext: () => false,
        holdMs: 60000,
        hasLocalTerminal: true,
        escalate: () => {
          questionId = generateId() as UUID;
          messageApi.handleQuestion(
            {
              id: questionId,
              text: `Allow Bash: ${PROOF_COMMAND}`,
              options: [YES, NO],
              allowsFreeText: false,
              isAnswered: false,
            },
            { held: true },
          );
          return questionId;
        },
      },
      sessionId,
    );
    const activeGate = gate;
    hookServer = new HookServer({ port: 0 });
    hookServer.setPermissionResolver((input, signal) =>
      activeGate.resolvePermission(input, signal),
    );
    hookServer.start();
    let resolutionCount = 0;
    const handlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore,
      send: () => true,
      onQuestionResolved: () => {
        resolutionCount++;
      },
      ...gateAnswerDeps(() => activeGate),
    });
    let actualOutcome: string | undefined;
    answerServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/answer')
          return new Response(null, { status: 404 });
        const body = (await request.json()) as Record<string, unknown>;
        if (
          body['sessionId'] !== sessionId ||
          body['questionId'] !== questionId ||
          body['answer'] !== NO.value ||
          !questionId
        )
          return new Response(null, { status: 400 });
        actualOutcome = await handlers.relayAnswer(sessionId, questionId, NO.value);
        return Response.json({ outcome: actualOutcome });
      },
    });

    const workerSpawnStartedAt = performance.now();
    workerStartedAt = workerSpawnStartedAt;
    worker = Bun.spawn([...executable(), '--storage-load-worker', JSON.stringify(config)], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: childEnv(),
    });
    workerWatchdog = setTimeout(
      () => {
        if (worker?.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      },
      Math.max(0, MAX_WORKER_LIFETIME_MS - (performance.now() - workerSpawnStartedAt)),
    );
    const workerPid = worker.pid;
    workerOutput = readCapped(worker.stdout, MAX_WORKER_OUTPUT);
    workerStderr = readCapped(worker.stderr, MAX_WORKER_OUTPUT).catch((error: unknown) =>
      error instanceof Error
        ? `worker stderr capture failed: ${error.message}`
        : 'worker stderr capture failed',
    );
    void workerOutput.catch(() => {});
    await waitForProgress(
      config.progressPath,
      (progress) => progress.setupMeasurements.readyAtWorkerMs !== null,
      worker,
      workerStderr,
      MAX_WORKER_LIFETIME_MS,
      'owned storage load worker reached monotonic setup readiness',
    );

    scenarios = [
      await oneDenial(1, 'storage-load', false, {
        directory,
        sessionId,
        hookServer,
        answerServer,
        gate,
        registry,
        handlers,
        getQuestionId: () => questionId,
        progressPath: config.progressPath,
        worker,
        workerStderr,
        pty,
        readPtyOutput: () => terminalOutput,
      }),
      await oneDenial(2, 'synchronous-parent-block', true, {
        directory,
        sessionId,
        hookServer,
        answerServer,
        gate,
        registry,
        handlers,
        getQuestionId: () => questionId,
        progressPath: config.progressPath,
        worker,
        workerStderr,
        pty,
        readPtyOutput: () => terminalOutput,
      }),
    ];
    assert.equal(actualOutcome, 'delivered', 'owned answer adapter called the real input handler');
    assert.equal(resolutionCount, 2, 'both actual held No answers resolved exactly once');

    writeFileSync(config.stopPath, 'stop', { mode: 0o600 });
    let workerExit = -1;
    let workerJson!: {
      completedCopies: number;
      workerLifetimeMs: number;
      workerDeadlineMs: number;
      maxWorkerLifetimeMs: number;
      maxWorkers: number;
      queuedCopies: number;
      lastSha256: string | null;
      nativeHelper: LoadedNativeHelperEvidence;
      setupMeasurements: WorkerProgress['setupMeasurements'];
    };
    try {
      const [exit, output, stderr] = await Promise.all([worker.exited, workerOutput, workerStderr]);
      workerExit = exit;
      assert.equal(exit, 0, `owned storage worker exited cleanly: ${stderr}`);
      workerJson = JSON.parse(output) as typeof workerJson;
    } finally {
      clearTimeout(workerWatchdog);
      workerWatchdog = undefined;
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      await worker.exited;
      noChild(worker.pid, 'owned storage worker cleanup');
    }
    noChild(workerPid, 'owned repeated storage load worker');
    assert.equal(workerJson.maxWorkers, 1, 'one actual storage worker was used');
    assert.equal(workerJson.queuedCopies, 0, 'storage worker used no queued copies');
    assert(workerJson.completedCopies > 0, 'worker completed repeated actual private copies');
    assert(workerJson.workerLifetimeMs <= MAX_WORKER_LIFETIME_MS, 'worker lifetime stayed bounded');
    assert.equal(
      workerJson.workerDeadlineMs,
      MAX_WORKER_INTERNAL_DEADLINE_MS,
      'worker retained its internal four-second safety deadline',
    );
    assert.equal(workerJson.maxWorkerLifetimeMs, MAX_WORKER_LIFETIME_MS);
    assert(
      workerJson.setupMeasurements.readyAtWorkerMs !== null &&
        workerJson.setupMeasurements.readyAtWorkerMs < MAX_WORKER_INTERNAL_DEADLINE_MS,
      'worker records setup time inside its internal deadline while the parent enforces five seconds from spawn',
    );
    assert.equal(workerJson.lastSha256, inputSha256, 'worker verified the generated input digest');
    assert.deepEqual(
      workerJson.nativeHelper,
      {
        sourceSha256: nativeHelper.sourceSha256,
        opsSourceSha256: nativeHelper.opsSourceSha256,
        librarySha256: nativeHelper.librarySha256,
        sourceIdentity: nativeHelper.sourceIdentity,
        opsSourceIdentity: nativeHelper.opsSourceIdentity,
        libraryIdentity: nativeHelper.libraryIdentity,
        compilerPath: nativeHelper.compilerPath,
        compilerVersion: nativeHelper.compilerVersion,
        compilerSha256: nativeHelper.compilerSha256,
        compilerTargetTriple: nativeHelper.compilerTargetTriple,
        compilerResolutionMethod: nativeHelper.compilerResolutionMethod,
        compilerLauncherPath: nativeHelper.compilerLauncherPath,
        compilerLauncherVersion: nativeHelper.compilerLauncherVersion,
        compilerLauncherSha256: nativeHelper.compilerLauncherSha256,
        compilerSdkPath: nativeHelper.compilerSdkPath,
        compilerSdkVersion: nativeHelper.compilerSdkVersion,
        compilerImageIndexReference: nativeHelper.compilerImageIndexReference,
        compilerImageIndexDigest: nativeHelper.compilerImageIndexDigest,
        compilerContainerImageDotImageId: nativeHelper.compilerContainerImageDotImageId,
        compilerImagePlatformDigest: nativeHelper.compilerImagePlatformDigest,
        compilerImagePlatform: nativeHelper.compilerImagePlatform,
        compilerOsRelease: nativeHelper.compilerOsRelease,
        compilerLibcVersion: nativeHelper.compilerLibcVersion,
        compilerPreparationDurationMs: nativeHelper.compilerPreparationDurationMs,
        compilerPreparationContainerDurationMs: nativeHelper.compilerPreparationContainerDurationMs,
        supportManifestSha256: nativeHelper.supportManifestSha256,
        libraryElfMachine: nativeHelper.libraryElfMachine,
        libraryNeeded: nativeHelper.libraryNeeded,
        libraryRequiredGlibcVersions: nativeHelper.libraryRequiredGlibcVersions,
        compileCommand: nativeHelper.compileCommand,
        setupDurationMs: nativeHelper.setupDurationMs,
        platform: nativeHelper.platform,
        arch: nativeHelper.arch,
      },
      'worker loaded only the parent-prepared helper whose source, compiler and library hashes were recorded',
    );
    assert.deepEqual(
      fsNames(config.privatePath),
      [],
      'worker ended after confirmed private deletion',
    );
    assert.equal(
      new Reservations(config.ledgerPath).inspect().length,
      0,
      'worker ended after the real reservation API confirmed an empty ledger',
    );
    assert(workerStartedAt !== undefined, 'worker launch timestamp was captured');
    workerResult = {
      pid: workerPid,
      exitCode: workerExit,
      reaped: true,
      copies: workerJson.completedCopies,
      lifetimeMs: performance.now() - workerStartedAt,
      workerReportedLifetimeMs: workerJson.workerLifetimeMs,
      nativeHelper: workerJson.nativeHelper,
      setupMeasurements: workerJson.setupMeasurements,
    };
    assert(
      workerResult.lifetimeMs <= MAX_WORKER_LIFETIME_MS,
      'owned worker process exited and was reaped within the five-second lifetime bound',
    );

    const ptyChild = pty.childPid;
    await pty.close(2000);
    if (ptyPid !== undefined) noChild(ptyPid, 'owned /bin/cat held-answer PTY');
    const finalPtyOutput = terminalOutput;
    const first = scenarios[0];
    const second = scenarios[1];
    assert(first && second, 'both denial scenarios completed');
    const segments = [
      { scenario: first, end: second.ptyOutputStart },
      { scenario: second, end: finalPtyOutput.length },
    ];
    ptyWitnesses = segments.map(({ scenario: item, end }) => {
      const observed = finalPtyOutput.slice(item.ptyOutputStart, end);
      const marker = item.ptyObservedMarker;
      assert(
        finalPtyOutput.slice(
          item.ptyOutputStart,
          item.ptyOutputStart + item.ptyBarrier.output.length,
        ) === item.ptyBarrier.output,
        'zero-PTY witness: observed bytes were retained unchanged through PTY reap',
      );
      const markerCopies = occurrences(observed, marker);
      assert(
        markerCopies >= 2 && markerCopies >= item.ptyBarrier.markerCopies,
        'zero-PTY witness: two real marker copies remained visible through PTY reap',
      );
      assertNoAnswerPathPtyBytes(observed, baselineOutput, marker, baselineMarkers.baseline);
      const baselineHash = sha256Text(normalizeBarrier(baselineOutput, baselineMarkers.baseline));
      const observedHash = sha256Text(normalizeBarrier(observed, marker));
      assert.equal(observedHash, baselineHash, 'zero-PTY witness output digest matches baseline');
      return {
        baselineOutputBytes: baselineOutput.length,
        observedOutputBytes: observed.length,
        markerCopies,
        baselineOutputSha256: baselineHash,
        observedOutputSha256: observedHash,
        answerPathOutputBytes: 0 as const,
        outputMatchedBaseline: true as const,
        quietWindowMs: PTY_BARRIER_QUIET_MS,
        observedThroughReap: true as const,
      };
    });
    assert.equal(ptyChild, ptyPid, 'PTY close reaped the original owned child');
    await registry.shutdown();
    __resetLoggerForTests();
  } finally {
    clearTimeout(workerWatchdog);
    if (worker) {
      if (worker.exitCode === null && worker.signalCode === null) {
        writeFileSync(config.stopPath, 'stop', { mode: 0o600 });
        const end = performance.now() + 1000;
        while (worker.exitCode === null && worker.signalCode === null && performance.now() < end)
          await Bun.sleep(5);
        if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      }
      await worker.exited;
      noChild(worker.pid, 'owned storage worker cleanup');
    }
    gate?.forceRelease('storage approval proof cleanup');
    answerServer?.stop(true);
    hookServer?.stop();
    await pty.close(2000);
    if (ptyPid !== undefined) noChild(ptyPid, 'owned /bin/cat held-answer PTY cleanup');
    await registry.shutdown();
    __resetLoggerForTests();
    rmSync(directory, { recursive: true, force: true });
    removed = !existsSync(directory);
  }
  assert(worker && workerStartedAt !== undefined && workerResult);
  assert(scenarios.length === 2 && ptyWitnesses.length === 2);
  assert(removed, 'test cleanup removed only the owned fixture root');
  return {
    checks: [STORAGE_LOAD_GROUP, BLOCK_GROUP, PTY_GROUP, PTY_MUTATION_GROUP],
    scenarios,
    worker: {
      ...workerResult,
      maxLifetimeMs: MAX_WORKER_LIFETIME_MS,
      maxWorkers: 1,
      queuedCopies: 0,
      exactSha256: inputSha256,
      finalPrivateDirectoryEmpty: true,
      finalLedgerEmpty: true,
    },
    pty: ptyWitnesses,
    fixtureRootRemoved: removed,
  };
}

function fsNames(path: string): string[] {
  return readdirSync(path);
}

async function ptyWrongWriteControl(): Promise<PtyMutationEvidence> {
  const directory = mkdtempSync(join(tmpdir(), 'remi-storage-pty-mutation-'));
  chmodSync(directory, 0o700);
  let output = '';
  const pty = new PTYSession(
    { command: '/bin/cat', args: [], cwd: directory },
    {
      onData: (data) => {
        output += data;
      },
    },
  );
  let pid: number | undefined;
  let baselineOutput: string | undefined;
  let baselineMarker: string | undefined;
  let observedMarker: string | undefined;
  let barrierCopies = 0;
  try {
    await pty.start();
    pid = pty.childPid ?? undefined;
    assert(pid !== undefined, 'wrong-write control /bin/cat PTY has a child PID');
    const markers = ptyBarrierMarkers(3);
    const baseline = await writeAndObservePtyBarrier(pty, () => output, markers.baseline, 0);
    assert(baseline.markerCopies >= 2, 'wrong-write control calibrated two baseline copies');
    baselineOutput = baseline.output;
    baselineMarker = markers.baseline;
    observedMarker = markers.observed;
    output = '';
    await pty.write(NO.value);
    const mutated = await writeAndObservePtyBarrier(pty, () => output, markers.observed, 0);
    barrierCopies = mutated.markerCopies;
  } finally {
    await pty.close(2000);
    if (pid !== undefined) noChild(pid, 'wrong-write control /bin/cat PTY');
    rmSync(directory, { recursive: true, force: true });
  }
  assert(pid !== undefined && baselineOutput && baselineMarker && observedMarker);
  const markerCopiesAfterReap = occurrences(output, observedMarker);
  assert(
    markerCopiesAfterReap >= 2 && markerCopiesAfterReap >= barrierCopies,
    'wrong-write marker copies remain observable through child reap',
  );
  let rejected = false;
  try {
    assertNoAnswerPathPtyBytes(output, baselineOutput, observedMarker, baselineMarker);
  } catch (error) {
    assert(error instanceof Error, 'zero-PTY witness rejected the wrong-write mutation');
    assert.match(error.message, /zero-PTY witness/);
    rejected = true;
  }
  assert(rejected, 'deliberate actual PTY write invalidates the zero-byte witness');
  const baselineSha256 = sha256Text(normalizeBarrier(baselineOutput, baselineMarker));
  const mutatedSha256 = sha256Text(normalizeBarrier(output, observedMarker));
  assert.notEqual(
    mutatedSha256,
    baselineSha256,
    'wrong write changes normalized PTY output digest',
  );
  return {
    mutationInput: NO.value,
    baselineOutputBytes: baselineOutput.length,
    mutatedOutputBytes: output.length,
    baselineOutputSha256: baselineSha256,
    mutatedOutputSha256: mutatedSha256,
    observedMarkerCopies: markerCopiesAfterReap,
    outputAssertionRejectedMutation: true,
    childPid: pid,
    reaped: true,
  };
}

export async function storageApprovalProof(): Promise<{
  checks: string[];
  scenarios: DenialScenario[];
  worker: Awaited<ReturnType<typeof runStorageLoadProof>>['worker'];
  pty: PtyWitness[];
  ptyMutationControl: PtyMutationEvidence;
  fixtureRootRemoved: true;
}> {
  const load = await runStorageLoadProof();
  const ptyMutationControl = await ptyWrongWriteControl();
  assert(load.scenarios.every((scenario) => scenario.clientReaped));
  assert(load.pty.every((witness) => witness.observedThroughReap));
  assert(load.worker.reaped && load.fixtureRootRemoved);
  assert(ptyMutationControl.reaped && ptyMutationControl.outputAssertionRejectedMutation);
  return {
    checks: load.checks,
    scenarios: load.scenarios,
    worker: load.worker,
    pty: load.pty,
    ptyMutationControl,
    fixtureRootRemoved: load.fixtureRootRemoved,
  };
}
