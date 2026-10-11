// #1170 source held-answer proof. It constructs no Claude process or real transport.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { ApprovalClientConfig } from './approval-client';
import inputs from './inputs.json';
import { DecoderProcess, DecoderProcessError } from './process.ts';

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
const PROOF_COMMAND = 'echo REMI_TUNNEL_APPROVAL_PROOF';
const PNG_GROUP = 'PNG held No under repeated actual decoder load';
const JPEG_GROUP = 'JPEG held No under repeated actual decoder load';
const BLOCK_GROUP = 'synchronous parent block makes held No exceed one second';
const MAX_CLIENT_OUTPUT = 4096;

interface ScenarioResult {
  scenario: 'png-under-load' | 'jpeg-under-load' | 'synchronous-parent-block';
  latencyMs: number;
  sendStartedAtUnixMs: number;
  denyParsedAtUnixMs: number;
  blockControl: {
    startedAtUnixMs: number;
    sendStartedAtUnixMs: number;
    endedAtUnixMs: number;
    durationMs: number;
  } | null;
  resourceSnapshot: string;
  childProcesses: {
    ptyPid: number;
    clientPid: number;
    repeatedDecoderPid: number;
    recoveryDecoderPid: number;
    reaped: { pty: boolean; client: boolean; repeatedDecoder: boolean; recoveryDecoder: boolean };
  };
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

async function waitForClientFile(
  path: string,
  client: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  stderr: Promise<string>,
): Promise<void> {
  const end = performance.now() + 15000;
  while (!existsSync(path) && performance.now() < end) {
    if (client.exitCode !== null || client.signalCode !== null) {
      const detail = await stderr;
      throw new Error(
        `compiled client exited before its marker (exit=${client.exitCode}, signal=${client.signalCode}): ${detail}; ${cgroupDiagnostic()}`,
      );
    }
    await Bun.sleep(5);
  }
  assert(existsSync(path), 'compiled client readiness timed out');
}

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_CLIENT_OUTPUT) throw new Error('approval client output exceeded its bound');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function noChild(pid: number | undefined, witness: string): void {
  assert(pid !== undefined, `${witness}: child PID recorded`);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${witness}: child reaped`);
}

function expectedPixels(index: number) {
  const image = inputs.images[index];
  assert(image, 'owned approval image metadata');
  return {
    width: image.width,
    height: image.height,
    pixelBytes: image.pixelBytes,
    pixelSha256: image.pixelSha256,
  };
}

function blockCpu(milliseconds: number): void {
  const end = performance.now() + milliseconds;
  let value = 0x13579bdf;
  let iterations = 0;
  while (performance.now() < end) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    iterations++;
  }
  assert(iterations > 0 && Number.isInteger(value), 'parent performed synchronous CPU work');
}

async function scenario(
  mediaType: 'image/png' | 'image/jpeg',
  bytes: Buffer,
  imageIndex: number,
  blockParent: boolean,
): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), 'remi-approval-proof-'));
  chmodSync(dir, 0o700);
  configureLogger({ writeLog: () => {} });
  const sessionId = generateId() as UUID;
  const registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
  let terminalOutput = '';
  const pty = new PTYSession(
    { command: '/bin/cat', args: [], cwd: dir },
    {
      onData: (data) => {
        terminalOutput += data;
      },
    },
  );
  let ptyPid: number | undefined;
  let result: ScenarioResult | undefined;
  let gate: AutoApproveGate | undefined;
  let hookServer: HookServer | undefined;
  let answerServer: ReturnType<typeof Bun.serve> | undefined;
  let client: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let decoder: DecoderProcess | undefined;
  let decoderAbort: AbortController | undefined;
  let decoderOutcome: Promise<{ error?: unknown }> | undefined;
  try {
    await pty.start();
    ptyPid = pty.childPid ?? undefined;
    assert(ptyPid !== undefined, 'owned /bin/cat PTY has a child PID');
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
    registry.registerSession(sessionId, dir, pty, messageApi);
    const bindingStore = new SessionBindingStore(new SessionStore(join(dir, 'sessions.json')));
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

    const pixels = expectedPixels(imageIndex);
    decoder = new DecoderProcess([...executable(), '--owned-decode-worker']);
    decoderAbort = new AbortController();
    let markReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const decoderReady = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      rejectReady = reject;
    });
    decoderOutcome = decoder
      .decodeRepeated(bytes, mediaType, {
        signal: decoderAbort.signal,
        milliseconds: 5000,
        onReady: (result) => {
          assert.equal(result.decodes, 2, 'child completed two real decodes before readiness');
          assert.deepEqual(
            {
              width: result.width,
              height: result.height,
              pixelBytes: result.pixelBytes,
              pixelSha256: result.pixelSha256,
            },
            pixels,
            'repeated child reported exact owned pixels before readiness',
          );
          markReady();
        },
      })
      .then(
        () => {
          const error = new Error('repeated decoder exited without cancellation');
          rejectReady(error);
          return { error };
        },
        (error: unknown) => {
          rejectReady(error);
          return { error };
        },
      );
    await decoderReady;
    const decoderPid = decoder.lastChildPID;
    assert(decoderPid !== undefined, 'actual repeated decoder child reached readiness');

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

    const readyPath = join(dir, 'client-ready');
    const triggerPath = join(dir, 'send-no');
    const sentPath = join(dir, 'client-sent-no');
    const config: ApprovalClientConfig = {
      hookUrl: String(hookServer.url),
      answerUrl: new URL('/answer', answerServer.url).toString(),
      sessionId,
      questionPath: join(dir, 'question-id'),
      proofCommand: PROOF_COMMAND,
      answerNoValue: NO.value,
      cwd: dir,
      readyPath,
      triggerPath,
      sentPath,
    };
    client = Bun.spawn([...executable(), '--approval-client', JSON.stringify(config)], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: childEnv(),
    });
    const activeClient = client;
    const clientPid = activeClient.pid;
    const clientOutput = readCapped(activeClient.stdout);
    const clientError = readCapped(activeClient.stderr).catch((error: unknown) =>
      error instanceof Error ? `stderr capture failed: ${error.message}` : 'stderr capture failed',
    );
    void clientOutput.catch(() => {});
    await waitForClientFile(readyPath, activeClient, clientError);
    const cardReady = () =>
      questionId !== undefined &&
      activeGate.hasOpenHookPrompt() &&
      registry.getQuestion(sessionId, questionId) !== null;
    const cardEnd = performance.now() + 15000;
    while (!cardReady() && performance.now() < cardEnd) await Bun.sleep(5);
    assert(cardReady(), 'real PermissionRequest registered its held question before answer');
    if (!questionId) throw new Error('held approval question id missing');
    const activeQuestionId = questionId;
    assert.equal(
      registry.getQuestion(sessionId, activeQuestionId)?.text,
      `Allow Bash: ${PROOF_COMMAND}`,
      'real question card contains the inert captured-style command',
    );
    const resourceSnapshot = cgroupDiagnostic();
    writeFileSync(config.questionPath, activeQuestionId, { mode: 0o600 });
    writeFileSync(triggerPath, 'answer', { mode: 0o600 });
    let blockControl: ScenarioResult['blockControl'] = null;
    let blockSendMarker: number | undefined;
    if (blockParent) {
      const blockStartedAtUnixMs = Date.now();
      const blockStartedAt = performance.now();
      blockCpu(1200);
      const blockDurationMs = performance.now() - blockStartedAt;
      const blockEndedAtUnixMs = Date.now();
      assert(existsSync(sentPath), 'independent client sent No during parent CPU block');
      const sentAt = Number(readFileSync(sentPath, 'utf-8'));
      assert(
        Number.isSafeInteger(sentAt) &&
          sentAt >= blockStartedAtUnixMs &&
          sentAt <= blockEndedAtUnixMs,
        'independent No send began inside the parent CPU block',
      );
      blockSendMarker = sentAt;
      assert(blockDurationMs >= 1200, 'parent completed at least 1200 ms of synchronous CPU work');
      blockControl = {
        startedAtUnixMs: blockStartedAtUnixMs,
        sendStartedAtUnixMs: sentAt,
        endedAtUnixMs: blockEndedAtUnixMs,
        durationMs: blockDurationMs,
      };
    }
    const timeout = setTimeout(() => activeClient.kill('SIGKILL'), 15000);
    let clientResult: {
      latencyMs: number;
      sendStartedAtUnixMs: number;
      denyParsedAtUnixMs: number;
      answerOutcome: string;
      proofCommand: string;
      hookResponse: { hookSpecificOutput?: { decision?: { behavior?: string } } };
    };
    try {
      const [exit, output, clientStderr] = await Promise.all([
        activeClient.exited,
        clientOutput,
        clientError,
      ]);
      assert.equal(exit, 0, `independent compiled answer client exit: ${clientStderr}`);
      clientResult = JSON.parse(output) as typeof clientResult;
    } finally {
      clearTimeout(timeout);
      if (activeClient.exitCode === null && activeClient.signalCode === null)
        activeClient.kill('SIGKILL');
      await activeClient.exited;
    }
    noChild(clientPid, 'independent compiled answer client');
    const clientReaped = true;
    assert(
      Number.isSafeInteger(clientResult.sendStartedAtUnixMs),
      'client recorded its send timestamp',
    );
    assert(
      Number.isSafeInteger(clientResult.denyParsedAtUnixMs) &&
        clientResult.denyParsedAtUnixMs >= clientResult.sendStartedAtUnixMs,
      'client recorded its deny parse timestamp after send',
    );
    if (blockParent)
      assert.equal(
        clientResult.sendStartedAtUnixMs,
        blockSendMarker,
        'timestamp file matches the independent client send timestamp',
      );
    assert.equal(actualOutcome, 'delivered', 'owned adapter called real relayAnswer');
    assert.equal(clientResult.answerOutcome, 'delivered', 'client parsed actual delivered outcome');
    assert.equal(
      clientResult.proofCommand,
      PROOF_COMMAND,
      'client held the inert captured-style command',
    );
    assert.equal(
      clientResult.hookResponse.hookSpecificOutput?.decision?.behavior,
      'deny',
      'client parsed the original held HTTP deny JSON',
    );
    assert.equal(activeGate.hasOpenHookPrompt(), false, 'held permission closed');
    assert.equal(registry.getQuestion(sessionId, activeQuestionId), null, 'question card removed');
    assert.equal(
      await handlers.relayAnswer(sessionId, activeQuestionId, NO.value),
      'delivered',
      'same-value duplicate reports the first successful answer',
    );
    assert.equal(
      await handlers.relayAnswer(sessionId, activeQuestionId, YES.value),
      'stale',
      'conflicting answer for the removed question is stale',
    );
    assert.equal(resolutionCount, 1, 'duplicate answers cause only one resolution effect');
    assert.equal(terminalOutput, '', 'No was not written to the /bin/cat PTY');
    if (blockParent) {
      assert(clientResult.latencyMs > 1000, 'client-measured deny crossed the one-second block');
    } else {
      assert(clientResult.latencyMs <= 1000, 'client-measured deny met the one-second limit');
    }

    decoderAbort.abort();
    const cancelled = await decoderOutcome;
    assert(
      cancelled.error instanceof DecoderProcessError,
      'repeated decoder ended by cancellation',
    );
    assert.equal(cancelled.error.code, 'cancelled');
    noChild(decoderPid, 'repeated decoder child cancellation');
    const repeatedDecoderReaped = true;
    assert.deepEqual(
      await decoder.decode(bytes, mediaType),
      pixels,
      'same controller decoded after cancel',
    );
    const recoveryDecoderPid = decoder.lastChildPID;
    assert(recoveryDecoderPid !== undefined, 'same controller recovery child PID recorded');
    noChild(recoveryDecoderPid, 'same controller recovery child');
    const recoveryDecoderReaped = true;
    result = {
      scenario: blockParent
        ? 'synchronous-parent-block'
        : mediaType === 'image/png'
          ? 'png-under-load'
          : 'jpeg-under-load',
      latencyMs: clientResult.latencyMs,
      sendStartedAtUnixMs: clientResult.sendStartedAtUnixMs,
      denyParsedAtUnixMs: clientResult.denyParsedAtUnixMs,
      blockControl,
      resourceSnapshot,
      childProcesses: {
        ptyPid,
        clientPid,
        repeatedDecoderPid: decoderPid,
        recoveryDecoderPid,
        reaped: {
          pty: false,
          client: clientReaped,
          repeatedDecoder: repeatedDecoderReaped,
          recoveryDecoder: recoveryDecoderReaped,
        },
      },
    };
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) client.kill('SIGKILL');
    if (client) await client.exited;
    decoderAbort?.abort();
    if (decoderOutcome) await decoderOutcome;
    gate?.forceRelease('approval proof cleanup');
    answerServer?.stop(true);
    hookServer?.stop();
    await pty.close(2000);
    if (ptyPid !== undefined) {
      noChild(ptyPid, 'owned /bin/cat PTY');
      if (result) result.childProcesses.reaped.pty = true;
    }
    await registry.shutdown();
    __resetLoggerForTests();
    rmSync(dir, { recursive: true, force: true });
  }
  assert(result, 'approval scenario completed with measured evidence');
  assert(
    Object.values(result.childProcesses.reaped).every(Boolean),
    'all owned child processes reaped',
  );
  return result;
}

export async function approvalProof(
  png: Buffer,
  jpg: Buffer,
): Promise<{ checks: string[]; scenarios: ScenarioResult[] }> {
  const scenarios = [
    await scenario('image/png', png, 0, false),
    await scenario('image/jpeg', jpg, 1, false),
    await scenario('image/png', png, 0, true),
  ];
  return { checks: [PNG_GROUP, JPEG_GROUP, BLOCK_GROUP], scenarios };
}
