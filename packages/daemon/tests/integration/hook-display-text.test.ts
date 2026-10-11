/**
 * The Claude display boundary through real HTTP hooks, a held gate, the bridge,
 * question builders, WebSocket transport, and an owned `/bin/cat` PTY control.
 * No Claude process or external push endpoint is involved; the push function
 * records the payload at the transport boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
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
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

const SESSION_ID = generateId() as UUID;
const CLAUDE_SESSION_ID = 'claude-display-text-session';
const S1_TMP = '/Volumes/S1/yooz/remi/tmp';

interface CapturedPush {
  readonly token: string;
  readonly options: PushTriggerOptions;
}

const UNSAFE_DISPLAY_CHARS = ['\x1b', '\x07', '\u202e', '\u2066', '\u200b', '\u200f'];

function expectSafeDisplay(text: string): void {
  for (const unsafe of UNSAFE_DISPLAY_CHARS) expect(text).not.toContain(unsafe);
}

describe('Claude hook display escaping (#1189, #1211)', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let pty: PTYSession;
  let ptyOutput: string;
  let gate: AutoApproveGate;
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
    tmpDir = fs.mkdtempSync(join(S1_TMP, 'hook-display-'));
    ptyOutput = '';
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

    await Bun.sleep(20);
    expect(ptyOutput).toBe('');
    expect(pty.isRunning).toBe(true);
  }, 15000);
});
