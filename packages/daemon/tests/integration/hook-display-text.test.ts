/**
 * The Claude display boundary through real HTTP hooks, a held gate, the bridge,
 * question builders, WebSocket transport, and an owned `/bin/cat` PTY control.
 * No Claude process or external push endpoint is involved; the push function
 * records the payload at the transport boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ProtocolMessage,
  type Question,
  type QuestionMessage,
  type UUID,
  createHello,
  createQuestion,
  deserialize,
  escapeUnsafeText,
  generateId,
  serialize,
} from '@remi/shared';
import { formatQuestionCard } from '../../src/adapters/telegram-ui.ts';
import { MessageAPI } from '../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { AutoApproveGate } from '../../src/auto-approve/auto-approve-gate.ts';
import { createInputHandlers } from '../../src/cli/handlers/input-events.ts';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { HookEventBridge } from '../../src/hooks/hook-event-bridge.ts';
import { HookServer } from '../../src/hooks/hook-server.ts';
import {
  NotificationDispatcher,
  type PushFn,
  buildPushText,
  buildSecurePushText,
} from '../../src/notifications/notification-dispatcher.ts';
import type { PushTriggerOptions } from '../../src/notifications/push-client.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { WebSocketServer } from '../../src/server/websocket-server.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

const SESSION_ID = generateId() as UUID;
const CLAUDE_SESSION_ID = 'claude-display-text-session';

interface CapturedPush {
  readonly token: string;
  readonly options: PushTriggerOptions;
}

const UNSAFE_DISPLAY_CHARS = ['\x1b', '\x07', '\u202e', '\u2066', '\u200b', '\u200f'];
const PTY_BARRIER_TIMEOUT_MS = 2_000;
const PTY_BARRIER_QUIET_MS = 75;

interface PtyBarrierMarkers {
  readonly baseline: string;
  readonly observed: string;
}

interface PtyBarrierObservation {
  readonly output: string;
  readonly markerCopies: number;
}

function markerOccurrences(value: string, marker: string): number {
  let count = 0;
  let index = 0;
  while (index !== -1) {
    index = value.indexOf(marker, index);
    if (index === -1) break;
    count += 1;
    index += marker.length;
  }
  return count;
}

function normalizeBarrier(value: string, marker: string): string {
  return value.split(marker).join('<PTY_BARRIER>');
}

function ptyBarrierMarkers(): PtyBarrierMarkers {
  const nonce = generateId().replaceAll('-', '').slice(0, 8).toUpperCase();
  return {
    baseline: `REMI_HOOK_PTY_A_${nonce}`,
    observed: `REMI_HOOK_PTY_B_${nonce}`,
  };
}

function assertNoAnswerPathPtyBytes(
  observed: string,
  baseline: string,
  observedMarker: string,
  baselineMarker: string,
): void {
  if (normalizeBarrier(observed, observedMarker) !== normalizeBarrier(baseline, baselineMarker)) {
    throw new Error('answer path produced bytes before the /bin/cat drain barrier');
  }
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
    const markerCopies = markerOccurrences(output, marker);
    if (markerCopies >= 2 && performance.now() - quietSince >= PTY_BARRIER_QUIET_MS) {
      return { output, markerCopies };
    }
    await Bun.sleep(5);
  }
  throw new Error('owned /bin/cat did not return the PTY barrier and terminal echo');
}

function expectSafeDisplay(text: string): void {
  for (const unsafe of UNSAFE_DISPLAY_CHARS) expect(text).not.toContain(unsafe);
}

describe('Claude hook display escaping (#1189, #1211)', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let pty: PTYSession;
  let ptyOutput: string;
  let ptyBaselineOutput: string;
  let ptyBaselineMarker: string;
  let ptyObservedMarker: string;
  let ptyOutputAtLastBarrier: string | undefined;
  let markerCopiesBeforeClose: number;
  let gate: AutoApproveGate;
  let inputHandlers: ReturnType<typeof createInputHandlers>;
  let answerMessages: ProtocolMessage[];
  let bridge: HookEventBridge;
  let tracker: QuestionPresenceTracker;
  let messageApi: MessageAPI;
  let hooks: HookServer;
  let transport: WebSocketServer;
  let socket: WebSocket;
  let received: ProtocolMessage[];
  let capturedQuestions: Question[];
  let builtPushes: Array<{
    legacy: { title: string; body: string };
    secure: { title: string; body: string };
    telegram: { text: string };
  }>;
  let pushCalls: CapturedPush[];
  let pendingPushes: Promise<unknown>[];
  let hookResponses: Promise<Response>[];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(join(tmpdir(), 'hook-display-'));
    ptyOutput = '';
    ptyBaselineOutput = '';
    const markers = ptyBarrierMarkers();
    ptyBaselineMarker = markers.baseline;
    ptyObservedMarker = markers.observed;
    ptyOutputAtLastBarrier = undefined;
    markerCopiesBeforeClose = 0;
    answerMessages = [];
    received = [];
    capturedQuestions = [];
    builtPushes = [];
    pushCalls = [];
    pendingPushes = [];
    hookResponses = [];
    registry = new SessionRegistry({ orphanTimeoutMs: 60_000 });

    pty = new PTYSession(
      { command: '/bin/cat', cwd: tmpDir },
      {
        onData: (data) => {
          ptyOutput += data;
        },
      },
    );
    await pty.start();

    const calibration = await writeAndObservePtyBarrier(pty, () => ptyOutput, ptyBaselineMarker, 0);
    expect(calibration.markerCopies).toBeGreaterThanOrEqual(2);
    ptyBaselineOutput = calibration.output;
    ptyOutputAtLastBarrier = ptyOutput;

    const controlStart = ptyOutput.length;
    const optionValue = '2';
    await pty.write(optionValue);
    const control = await writeAndObservePtyBarrier(
      pty,
      () => ptyOutput,
      ptyObservedMarker,
      controlStart,
    );
    expect(control.markerCopies).toBeGreaterThanOrEqual(2);
    expect(() =>
      assertNoAnswerPathPtyBytes(
        control.output,
        ptyBaselineOutput,
        ptyObservedMarker,
        ptyBaselineMarker,
      ),
    ).toThrow('answer path produced bytes before the /bin/cat drain barrier');
    ptyOutputAtLastBarrier = ptyOutput;
    markerCopiesBeforeClose = markerOccurrences(ptyOutput, ptyObservedMarker);

    const port = await reserveRange(1, 50, '127.0.0.1');
    transport = new WebSocketServer({ port, host: '127.0.0.1' });
    await transport.start();

    const questionPush = new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens: new Map<string, DeviceTokenEntry>([
          [
            'display-test-token',
            {
              token: 'display-test-token',
              platform: 'ios',
              registeredAt: 1,
              connectionId: SESSION_ID,
            },
          ],
        ]),
        pushConfig: () => ({
          signalingUrl: 'https://signal.example',
          legacyEnabled: true,
          pushSecret: 'owned-test-secret',
        }),
        getPrimarySessionId: () => SESSION_ID,
        pushFn: (async (_url, token, options) => {
          pushCalls.push({ token, options });
        }) as PushFn,
      },
      SESSION_ID,
    );

    messageApi = new MessageAPI(
      { sessionId: SESSION_ID },
      {
        onQuestion: (question, options) => {
          const answerPath = question.terminalOnly === true ? 'none' : options?.answerPath;
          const stamped: Question = {
            ...question,
            ...(options?.held === true && { held: true }),
            ...(answerPath !== undefined && { answerPath }),
          };
          capturedQuestions.push(stamped);
          registry.addQuestion(SESSION_ID, stamped, stamped.source ?? 'unknown');
          const message = createQuestion(stamped, SESSION_ID, {
            harness: 'claude',
            harnessSessionId: CLAUDE_SESSION_ID,
          });
          transport.broadcast(message);
          builtPushes.push({
            legacy: buildPushText('hook-display', stamped),
            secure: buildSecurePushText('hook-display', stamped),
            telegram: formatQuestionCard(stamped),
          });
          pendingPushes.push(
            questionPush.maybePush(
              SESSION_ID,
              stamped,
              options?.held === true ? { held: true } : {},
            ),
          );
        },
      },
    );
    registry.registerSession(SESSION_ID, tmpDir, pty, messageApi);

    const trackerEvents = new QuestionPresenceTracker((question, options) =>
      messageApi.handleQuestion(question, options),
    );
    tracker = trackerEvents;
    bridge = new HookEventBridge(SESSION_ID, {
      onQuestion: (question) => {
        tracker.recordPendingHook(question);
        return undefined;
      },
      onStatusChange: () => {},
    });
    gate = new AutoApproveGate(
      {
        sessionRegistry: registry,
        isInSubagentContext: () => bridge.isInSubagentContext(),
        hasLocalTerminal: true,
        holdMs: 60_000,
        escalate: (input) => bridge.handlePermissionRequest(input),
        onHeldEscalate: (questionId, answerPath) => {
          tracker.pushHeldHook(questionId, answerPath);
        },
      },
      SESSION_ID,
    );
    registry.setQuestionEvictionGuard(SESSION_ID, (questionId) => gate.isHeld(questionId));
    inputHandlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore: new SessionBindingStore(new SessionStore(join(tmpDir, 'sessions.json'))),
      send: (_connectionId, message) => {
        answerMessages.push(message);
        return true;
      },
      answerHeld: (_sessionId, questionId, answer, commit) =>
        gate.answerHeld(questionId, answer, commit),
    });

    hooks = new HookServer({ port: 0, hostname: '127.0.0.1' });
    hooks.setPermissionResolver((input, signal) => gate.resolvePermission(input, signal));
    hooks.start();

    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => socket.send(serialize(createHello('display-proof', '1.0.0')));
      socket.onmessage = (event) => {
        const message = deserialize(event.data.toString());
        if (message) received.push(message);
        if (message?.type === 'hello_ack') resolve();
      };
      socket.onerror = () => reject(new Error('WebSocket failed to connect'));
      setTimeout(() => reject(new Error('WebSocket hello_ack timed out')), 5000);
    });
  });

  afterEach(async () => {
    gate?.forceRelease('display proof teardown');
    await Promise.allSettled(hookResponses);
    hooks?.stop();
    socket?.close();
    if (transport?.running) await transport.stop();
    const childPid = pty?.childPid;
    await pty?.close(1500);
    if (childPid !== null && childPid !== undefined) {
      let alive = false;
      try {
        process.kill(childPid, 0);
        alive = true;
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
      }
      expect(alive).toBe(false);
      expect(pty.sessionState).toBe('exited');
    }
    if (ptyOutputAtLastBarrier !== undefined) {
      expect(ptyOutput).toBe(ptyOutputAtLastBarrier);
      expect(markerOccurrences(ptyOutput, ptyObservedMarker)).toBeGreaterThanOrEqual(
        markerCopiesBeforeClose,
      );
    }
    tracker?.clearPending();
    await registry?.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function waitFor<T>(select: () => T | null, description: string): Promise<T> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = select();
      if (result !== null) return result;
      await Bun.sleep(5);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  async function expectNoPtyAnswerBytesSince(outputStart: number): Promise<void> {
    const observation = await writeAndObservePtyBarrier(
      pty,
      () => ptyOutput,
      ptyObservedMarker,
      outputStart,
    );
    expect(observation.markerCopies).toBeGreaterThanOrEqual(2);
    assertNoAnswerPathPtyBytes(
      observation.output,
      ptyBaselineOutput,
      ptyObservedMarker,
      ptyBaselineMarker,
    );
    ptyOutputAtLastBarrier = ptyOutput;
    markerCopiesBeforeClose = markerOccurrences(ptyOutput, ptyObservedMarker);
  }

  async function postPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<{ response: Promise<Response>; message: QuestionMessage }> {
    const priorCount = received.filter((message) => message.type === 'question').length;
    const response = fetch(hooks.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: CLAUDE_SESSION_ID,
        transcript_path: join(tmpDir, 'transcript.jsonl'),
        cwd: tmpDir,
        permission_mode: 'default',
        hook_event_name: 'PermissionRequest',
        tool_name: toolName,
        tool_input: toolInput,
        ...extra,
      }),
    });
    hookResponses.push(response);
    const message = await waitFor(
      () =>
        received.filter((entry): entry is QuestionMessage => entry.type === 'question').length >
        priorCount
          ? (received
              .filter((entry): entry is QuestionMessage => entry.type === 'question')
              .at(-1) ?? null)
          : null,
      `the ${toolName} Question on the WebSocket`,
    );
    await Promise.all(pendingPushes.splice(0));
    return { response, message };
  }

  async function verifyLabelCollision(
    labels: readonly [string, string],
    answerMode: 'value' | 'selection',
  ): Promise<void> {
    expect(labels[0]).not.toBe(labels[1]);
    const rawQuestion = `Which raw label wins: ${labels[0]}?`;
    const toolInput = {
      questions: [
        {
          question: rawQuestion,
          options: labels.map((label) => ({ label })),
          multiSelect: false,
        },
      ],
    };
    const { response, message } = await postPermission('AskUserQuestion', toolInput);
    const question = message.question;
    const [option1, option2] = question.options;
    if (!option1 || !option2) throw new Error('two AskUserQuestion options missing');
    expect(option1.value).toBe('1');
    expect(option2.value).toBe('2');
    expect(option1.label).toBe(option2.label);
    expect(question.questions?.[0]?.options.map((option) => option.label)).toEqual([
      option1.label,
      option2.label,
    ]);
    expect(gate.isHeld(question.id)).toBe(true);

    const beforeAmbiguousLabel = ptyOutput.length;
    const refused = await inputHandlers.onAnswer(
      SESSION_ID,
      SESSION_ID,
      question.id,
      option1.label,
    );
    expect(refused).toBe('stale');
    expect(gate.isHeld(question.id)).toBe(true);
    expect(registry.getQuestion(SESSION_ID, question.id)).not.toBeNull();
    const refusal = answerMessages.at(-1);
    if (refusal?.type !== 'error') throw new Error('ambiguous answer did not return an error');
    expect(refusal.code).toBe('STALE_ANSWER');
    expect(refusal.message).toContain('more than one option');
    await expectNoPtyAnswerBytesSince(beforeAmbiguousLabel);

    const beforeUniqueAnswer = ptyOutput.length;
    const uniqueOutcome = await inputHandlers.onAnswer(
      SESSION_ID,
      SESSION_ID,
      question.id,
      answerMode === 'value' ? option2.value : 'not-a-displayed-label',
      undefined,
      answerMode === 'selection'
        ? { selections: [{ questionIndex: 0, optionIndices: [1] }] }
        : undefined,
    );
    expect(uniqueOutcome).toBe('delivered');
    expect(gate.isHeld(question.id)).toBe(false);
    expect(registry.getQuestion(SESSION_ID, question.id)).toBeNull();
    const hookBody = (await (await response).json()) as {
      hookSpecificOutput: {
        decision: { behavior: string; updatedInput: Record<string, unknown> };
      };
    };
    expect(hookBody.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...toolInput,
        answers: { [rawQuestion]: labels[1] },
      },
    });
    await expectNoPtyAnswerBytesSince(beforeUniqueAnswer);
  }

  test('held AskUserQuestion and ExitPlanMode keep escaped displays and raw structured echoes', async () => {
    const hostile = '\x1b\x07\u202e\u2066\u200b\u200f';
    const askInput = {
      questions: [
        {
          question: `Raw question ${hostile}`,
          header: `Raw header ${hostile}`,
          options: [{ label: `Raw label ${hostile}`, description: `Raw description ${hostile}` }],
          multiSelect: false,
        },
      ],
    };
    const askStep = askInput.questions[0];
    if (!askStep) throw new Error('AskUserQuestion step missing');
    const askOption = askStep.options[0];
    if (!askOption) throw new Error('AskUserQuestion option missing');
    const { response: askResponse, message: askMessage } = await postPermission(
      'AskUserQuestion',
      askInput,
      { agent_type: `reviewer${hostile}` },
    );
    const askQuestion = askMessage.question;
    expect(gate.isHeld(askQuestion.id)).toBe(true);
    expect(askQuestion.text).toContain(escapeUnsafeText(`reviewer${hostile}`));
    expect(askQuestion.text).toContain(escapeUnsafeText(askStep.question));
    expect(askQuestion.questions?.[0]?.header).toBe(escapeUnsafeText(askStep.header));
    expect(askQuestion.questions?.[0]?.options[0]).toMatchObject({
      label: escapeUnsafeText(askOption.label),
      description: escapeUnsafeText(askOption.description),
      value: '1',
    });
    expect(askMessage.harness).toBe('claude');
    const capturedAsk = capturedQuestions[0];
    const askBuilders = builtPushes[0];
    if (!capturedAsk || !askBuilders) throw new Error('AskUserQuestion push path missing');
    expect(askMessage.question).toEqual(capturedAsk);
    expect(askBuilders.legacy.body).toContain(escapeUnsafeText(askOption.label));
    expect(askBuilders.secure.body).toContain(escapeUnsafeText(askStep.question));
    expect(askBuilders.telegram.text).toContain(escapeUnsafeText(askStep.question));
    for (const field of [
      askQuestion.text,
      askQuestion.questions?.[0]?.text ?? '',
      askQuestion.questions?.[0]?.header ?? '',
      askQuestion.questions?.[0]?.options[0]?.label ?? '',
      askQuestion.questions?.[0]?.options[0]?.description ?? '',
      askBuilders.legacy.body,
      askBuilders.secure.body,
      askBuilders.telegram.text,
    ]) {
      expectSafeDisplay(field);
    }
    const askPush = pushCalls.at(-1)?.options;
    expect(askPush?.body).toBe(askBuilders.legacy.body);
    expectSafeDisplay(askPush?.title ?? '');
    expectSafeDisplay(askPush?.body ?? '');

    const noAnswerStart = ptyOutput.length;
    expect(
      gate.answerHeld(askQuestion.id, {
        kind: 'selections',
        selections: [{ questionIndex: 0, optionIndices: [0] }],
      }),
    ).toBe('resolved');
    const askResponseBody = (await askResponse).json() as Promise<{
      hookSpecificOutput: { decision: { behavior: string; updatedInput: Record<string, unknown> } };
    }>;
    expect((await askResponseBody).hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...askInput,
        answers: { [askStep.question]: askOption.label },
      },
    });

    const planInput = {
      plan: `Raw plan ${hostile}`,
      planFilePath: `/tmp/${hostile}.md`,
    };
    const { response: planResponse, message: planMessage } = await postPermission(
      'ExitPlanMode',
      planInput,
    );
    const planQuestion = planMessage.question;
    expect(gate.isHeld(planQuestion.id)).toBe(true);
    expect(planQuestion.detail).toBe(escapeUnsafeText(planInput.plan));
    const capturedPlan = capturedQuestions[1];
    const planBuilders = builtPushes[1];
    if (!capturedPlan || !planBuilders) throw new Error('ExitPlanMode push path missing');
    expect(planMessage.question).toEqual(capturedPlan);
    expect(planBuilders.legacy.body).toContain(escapeUnsafeText(planInput.plan));
    expect(planBuilders.secure.body).toContain(escapeUnsafeText(planInput.plan));
    expect(planBuilders.telegram.text).toContain(escapeUnsafeText(planInput.plan));
    expectSafeDisplay(planQuestion.detail ?? '');
    expectSafeDisplay(planBuilders.legacy.body);
    expectSafeDisplay(planBuilders.secure.body);
    expectSafeDisplay(planBuilders.telegram.text);
    const approval = planQuestion.options.find(
      (option) => option.label === 'Approve, approve edits manually',
    );
    if (!approval) throw new Error('manual approval option missing');
    expect(gate.answerHeld(planQuestion.id, { kind: 'option', option: approval })).toBe('resolved');
    const planResponseBody = (await (await planResponse).json()) as {
      hookSpecificOutput: { decision: Record<string, unknown> };
    };
    expect(planResponseBody.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: planInput,
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    });

    await expectNoPtyAnswerBytesSince(noAnswerStart);
    expect(pty.isRunning).toBe(true);
  }, 15000);

  test('fails closed when an unsafe label and literal escape collide; option value preserves raw option 2', async () => {
    await verifyLabelCollision(['A\u202e', 'A\\u202E'], 'value');
  });

  test('fails closed when whitespace cleanup collides; structured selection preserves raw option 2', async () => {
    await verifyLabelCollision(['A\tB', 'A B'], 'selection');
  });
});
