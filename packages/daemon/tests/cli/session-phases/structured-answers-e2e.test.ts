/**
 * AskUserQuestion and ExitPlanMode answered through their held
 * PermissionRequest hooks, end to end (#1127).
 *
 * Real components: the `HookServer` on port 0, driven by `fetch` the way
 * Claude Code's http hook posts; `setupHookBridge` with its real
 * `AutoApproveGate`, `QuestionPresenceTracker` and `TranscriptBinder`; a real
 * `MessageAPI`; the real `SessionRegistry`; and the answer handler
 * (`createInputHandlers` with `gateAnswerDeps` + `trackerScreenDeps`, the
 * wiring `cli.ts` uses). The relay test adds the real `WebSocketServer` and
 * posts to its `/answer` endpoint. Transport doubles only: a PTY that
 * records every write (so the no-typing invariant is asserted on it), and
 * recording sinks for pushes, notices and dismissals. The MessageAPI's
 * `onQuestion` reproduces the one step these tests read, registering the
 * card with its `held` stamp, not the rest of `message-api-setup.ts`.
 *
 * The hook payloads are the shapes measured on Claude Code 2.1.287 (#1126
 * spike E3, E4, F3): PreToolUse then PermissionRequest with the same input;
 * a terminal answer's PostToolUse carries the PreToolUse's tool_use_id with
 * `{questions, answers}` (AskUserQuestion) or `{}` (ExitPlanMode) as its
 * input; a No or Esc in the terminal closes the held request.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, Question, UUID } from '@remi/shared';
import { PROMPT_WAITING_HELD_MESSAGE, generateId } from '@remi/shared';
import { hasLiveQuestionOnScreen } from '../../../src/api/live-questions.ts';
import { MessageAPI } from '../../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import {
  createInputHandlers,
  gateAnswerDeps,
  trackerScreenDeps,
} from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import type { HookBridgeHandle } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import { setupHookBridge } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import { HookServer } from '../../../src/hooks/hook-server.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { WebSocketServer } from '../../../src/server/websocket-server.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/index.ts';
import type { TranscriptWatcher } from '../../../src/transcript/transcript-watcher.ts';

const SID = generateId() as UUID;
const CLAUDE = 'claude-1127';
const CONN = 'conn-phone' as UUID;

/** The two-question input the #1126 spike (E3) answered live. */
const TWO_QUESTIONS = {
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      options: [
        { label: 'Red', description: 'The color red' },
        { label: 'Green', description: 'The color green' },
        { label: 'Blue', description: 'The color blue' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which fruits do you like?',
      header: 'Fruits',
      options: [
        { label: 'Apple', description: 'A red or green fruit' },
        { label: 'Banana', description: 'A yellow fruit' },
        { label: 'Cherry', description: 'A small red fruit' },
      ],
      multiSelect: true,
    },
  ],
};
const ONE_QUESTION = { questions: [TWO_QUESTIONS.questions[0]] };
/** An ExitPlanMode input as Claude sends it (E4). */
const PLAN = {
  plan: '# Create hello.txt\n\nWrite a file named `hello.txt` containing "hi".\n',
  planFilePath: '/Users/x/.claude/plans/i-want-a-file-sunny-blum.md',
};

describe('AskUserQuestion and ExitPlanMode through held hooks, end to end (#1127)', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let bindingStore: SessionBindingStore;
  let hookServer: HookServer;
  let handle: HookBridgeHandle | null;
  let ptyWrites: string[];
  let sent: ProtocolMessage[];
  let pushes: Array<{ question: Question; held: boolean }>;
  let notices: Array<{ questionId: UUID; reason: string }>;
  let dismissed: UUID[];
  let pending: Array<Promise<unknown>>;
  let transcriptWatchers: Map<UUID, TranscriptWatcher>;
  let transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;

  beforeEach(() => {
    configureLogger({ writeLog: () => {} });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-1127-'));
    registry = new SessionRegistry({ orphanTimeoutMs: 60_000 });
    bindingStore = new SessionBindingStore(new SessionStore(path.join(tmpDir, 'sessions.json')));
    hookServer = new HookServer({ port: 0, hostname: '127.0.0.1' });
    hookServer.start();
    handle = null;
    ptyWrites = [];
    sent = [];
    pushes = [];
    notices = [];
    dismissed = [];
    pending = [];
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
  });

  afterEach(async () => {
    // Every hold is released (empty response) before the server goes.
    handle?.gate.forceRelease('test teardown');
    handle?.closeBinder();
    await Promise.allSettled(pending);
    hookServer.stop();
    for (const t of transcriptFallbackTimers.values()) clearInterval(t);
    __resetLoggerForTests();
    await registry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build the session as cli.ts wires it, in wrapper mode by default. */
  function build(opts: { holdMs?: number; hasLocalTerminal?: boolean } = {}) {
    const messageApi = new MessageAPI(
      { sessionId: SID, initialBulletId: 1 },
      {
        onQuestion: (question, pushOpts) => {
          const stamped = pushOpts?.held === true ? { ...question, held: true } : question;
          registry.addQuestion(SID, stamped, stamped.source ?? 'unknown');
        },
      },
    );
    const ref: { handle?: HookBridgeHandle } = {};
    const tracker = new QuestionPresenceTracker(
      (q, pushOpts) => {
        pushes.push({ question: q, held: pushOpts?.held === true });
        return messageApi.handleQuestion(q, pushOpts);
      },
      {
        hasLiveQuestions: () =>
          hasLiveQuestionOnScreen(
            registry.getSession(SID)?.currentQuestions.values() ?? [],
            (qid) => ref.handle?.gate.isHeld(qid as UUID) ?? false,
          ),
      },
    );
    registry.registerSession(
      SID,
      tmpDir,
      {
        id: generateId(),
        isRunning: true,
        write: async (d: string) => {
          ptyWrites.push(`write:${d}`);
        },
        submitInput: async (d: string) => {
          ptyWrites.push(d);
        },
        close: async () => {},
      } as unknown as PTYSession,
      messageApi,
    );
    const hasLocalTerminal = opts.hasLocalTerminal ?? true;
    handle = setupHookBridge(
      {
        sessionRegistry: registry,
        bindingStore,
        liveSessionsRegistry: new SessionRegistryFile(path.join(tmpDir, 'live-sessions')),
        transcriptWatchers,
        transcriptFallbackTimers,
        currentPort: () => 0,
        transcriptDiscovery: new TranscriptDiscovery(),
        holdMs: opts.holdMs ?? 60_000,
        hookTimeoutMs: hasLocalTerminal ? 600_000 : 3_600_000,
        pushTerminalNotice: (_sid, question, reason) =>
          notices.push({ questionId: question.id, reason }),
        broadcastQuestionResolved: (_sid, questionId) => {
          dismissed.push(questionId);
        },
      },
      {
        hookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi,
        sendAndRecord: () => {},
        tracker,
        hasLocalTerminal,
      },
    );
    ref.handle = handle;
    const gate = handle.gate;
    const handlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore,
      send: (_c, m) => {
        sent.push(m);
        return true;
      },
      onQuestionResolved: (_sid, questionId) => {
        dismissed.push(questionId);
      },
      ...gateAnswerDeps(() => gate),
      ...trackerScreenDeps(() => tracker),
    });
    registry.attachConnection(SID, CONN);
    return { handlers, gate, tracker };
  }

  /** POST one hook event as Claude does. */
  function post(
    event: string,
    fields: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const res = fetch(hookServer.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: CLAUDE,
        transcript_path: path.join(tmpDir, `${CLAUDE}.jsonl`),
        cwd: tmpDir,
        permission_mode: 'default',
        hook_event_name: event,
        ...fields,
      }),
      ...(signal ? { signal } : {}),
    });
    pending.push(res.catch(() => undefined));
    return res;
  }

  /** Bind the session (the binder admits only its own Claude session). */
  async function lock(): Promise<void> {
    await post('Notification', { notification_type: 'auth_success', message: '' });
  }

  function cards(): Question[] {
    return [...(registry.getSession(SID)?.currentQuestions.values() ?? [])];
  }

  async function waitFor<T>(fn: () => T | undefined | null | false, label: string): Promise<T> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await Bun.sleep(5);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  /**
   * Claude's sequence for one call: PreToolUse, then the PermissionRequest
   * about 10 ms later with the same input, held until answered. Resolves
   * once its card is registered.
   */
  async function ask(
    tool: 'AskUserQuestion' | 'ExitPlanMode',
    toolInput: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<{ card: Question; response: Promise<Response>; toolUseId: string }> {
    const toolUseId = `toolu_${generateId().slice(0, 8)}`;
    const before = new Set(cards().map((q) => q.id));
    await post('PreToolUse', {
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id: toolUseId,
      ...extra,
    });
    const response = post(
      'PermissionRequest',
      { tool_name: tool, tool_input: toolInput, ...extra },
      signal,
    );
    const card = await waitFor(() => cards().find((q) => !before.has(q.id)), `${tool} card`);
    return { card, response, toolUseId };
  }

  async function decisionOf(response: Promise<Response>): Promise<unknown> {
    const body = (await (await response).json()) as {
      hookSpecificOutput?: { decision?: unknown };
    };
    return body.hookSpecificOutput?.decision ?? body;
  }

  function errors(): Array<{ code?: string; message?: string }> {
    return sent.filter((m) => m.type === 'error') as Array<{ code?: string; message?: string }>;
  }

  describe('AskUserQuestion', () => {
    test('two questions, single and multi-select: the card carries both; the answer echoes the questions with answers', async () => {
      const { handlers } = build();
      await lock();
      const { card, response } = await ask('AskUserQuestion', TWO_QUESTIONS);
      expect(card.held).toBe(true);
      expect(card.kind).toBe('multi_question');
      expect(card.questions?.map((s) => [s.header, s.text, s.multiSelect])).toEqual([
        ['Color', 'Which color do you prefer?', false],
        ['Fruits', 'Which fruits do you like?', true],
      ]);
      expect(card.questions?.[1]?.options.map((o) => [o.label, o.description])).toEqual([
        ['Apple', 'A red or green fruit'],
        ['Banana', 'A yellow fruit'],
        ['Cherry', 'A small red fruit'],
      ]);

      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [
          { questionIndex: 0, optionIndices: [1] },
          { questionIndex: 1, optionIndices: [0, 2] },
        ],
      });

      // The exact response verified live (E3).
      expect(await decisionOf(response)).toEqual({
        behavior: 'allow',
        updatedInput: {
          questions: TWO_QUESTIONS.questions,
          answers: {
            'Which color do you prefer?': 'Green',
            'Which fruits do you like?': 'Apple, Cherry',
          },
        },
      });
      expect(cards()).toHaveLength(0);
      expect(dismissed).toEqual([card.id]);
      expect(errors()).toEqual([]);
      expect(ptyWrites).toEqual([]);
    });

    test('one question: a single pick answers it', async () => {
      const { handlers } = build();
      await lock();
      const { card, response } = await ask('AskUserQuestion', ONE_QUESTION);
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [{ questionIndex: 0, optionIndices: [2] }],
      });
      expect(await decisionOf(response)).toEqual({
        behavior: 'allow',
        updatedInput: { ...ONE_QUESTION, answers: { 'Which color do you prefer?': 'Blue' } },
      });
      expect(ptyWrites).toEqual([]);
    });

    test('free text answers a single-select question', async () => {
      const { handlers } = build();
      await lock();
      const { card, response } = await ask('AskUserQuestion', TWO_QUESTIONS);
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [
          { questionIndex: 0, optionIndices: [], text: 'Teal' },
          { questionIndex: 1, optionIndices: [1] },
        ],
      });
      expect(await decisionOf(response)).toEqual({
        behavior: 'allow',
        updatedInput: {
          ...TWO_QUESTIONS,
          answers: {
            'Which color do you prefer?': 'Teal',
            'Which fruits do you like?': 'Banana',
          },
        },
      });
      expect(ptyWrites).toEqual([]);
    });

    test('an incomplete answer is refused: the hold and the card stay, then a complete one goes through', async () => {
      const { handlers, gate } = build();
      await lock();
      const { card, response } = await ask('AskUserQuestion', TWO_QUESTIONS);
      let settled = false;
      void response.then(() => {
        settled = true;
      });

      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [{ questionIndex: 0, optionIndices: [0] }],
      });
      await Bun.sleep(20);
      expect(settled).toBe(false);
      expect(gate.isHeld(card.id)).toBe(true);
      expect(cards().map((q) => q.id)).toEqual([card.id]);
      const refusal = errors()[0];
      expect(refusal?.code).toBe('STALE_ANSWER');
      expect(refusal?.message).toContain('Answer every question');
      // The refusal names no card, so a client keeps it.
      expect(
        (refusal as { details?: { questionId?: string } })?.details?.questionId,
      ).toBeUndefined();

      // The claim on the card is released when the refused answer settles:
      // the identical answer again is refused again, not reported delivered
      // as a duplicate of something that applied.
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [{ questionIndex: 0, optionIndices: [0] }],
      });
      expect(errors().map((e) => e.code)).toEqual(['STALE_ANSWER', 'STALE_ANSWER']);

      // A multi-select with nothing picked is refused the same way.
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [
          { questionIndex: 0, optionIndices: [0] },
          { questionIndex: 1, optionIndices: [] },
        ],
      });
      expect(gate.isHeld(card.id)).toBe(true);

      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [
          { questionIndex: 0, optionIndices: [0] },
          { questionIndex: 1, optionIndices: [2] },
        ],
      });
      expect(await decisionOf(response)).toMatchObject({
        behavior: 'allow',
        updatedInput: {
          answers: {
            'Which color do you prefer?': 'Red',
            'Which fruits do you like?': 'Cherry',
          },
        },
      });
      expect(ptyWrites).toEqual([]);
    });

    test('a duplicate delivery of an applied answer reports delivered, not stale (#752)', async () => {
      const { handlers } = build();
      await lock();
      const { card, response } = await ask('AskUserQuestion', TWO_QUESTIONS);
      const selections = [
        { questionIndex: 0, optionIndices: [2] },
        { questionIndex: 1, optionIndices: [1] },
      ];
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, { selections });
      expect(await decisionOf(response)).toMatchObject({ behavior: 'allow' });
      // The losing channel re-delivers the same selections: no error frame.
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, { selections });
      expect(errors()).toEqual([]);
      // A different answer for the answered card is still refused.
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [
          { questionIndex: 0, optionIndices: [0] },
          { questionIndex: 1, optionIndices: [1] },
        ],
      });
      expect(errors().map((e) => e.code)).toEqual(['STALE_ANSWER']);
      expect(ptyWrites).toEqual([]);
    });

    test('Cancel from the phone denies with the dismissal message; no Esc is typed', async () => {
      const { handlers } = build();
      await lock();
      const { card, response } = await ask('AskUserQuestion', TWO_QUESTIONS);
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, { cancel: true });
      expect(await decisionOf(response)).toEqual({
        behavior: 'deny',
        message: 'The user dismissed the question.',
      });
      expect(cards()).toHaveLength(0);
      expect(ptyWrites).toEqual([]);
    });

    test('answered in the terminal: the paired PostToolUse (input now has answers) releases the hold and dismisses the card', async () => {
      build();
      await lock();
      const { card, response, toolUseId } = await ask('AskUserQuestion', TWO_QUESTIONS);
      await post('PostToolUse', {
        tool_name: 'AskUserQuestion',
        tool_input: { ...TWO_QUESTIONS, answers: { 'Which color do you prefer?': 'Red' } },
        tool_use_id: toolUseId,
        tool_response: {},
      });
      // The empty response Claude ignores once its dialog is answered.
      expect(await (await response).text()).toBe('{}');
      expect(cards()).toHaveLength(0);
      expect(dismissed).toEqual([card.id]);
      // Closed, not handed back: no "answer at the terminal" notice.
      expect(notices).toEqual([]);
      expect(ptyWrites).toEqual([]);
    });

    test('answered in the terminal with no PreToolUse seen: the finished call releases the one open hold (review S4)', async () => {
      build();
      await lock();
      // The request arrives without its PreToolUse, so it cannot pair.
      const response = post('PermissionRequest', {
        tool_name: 'AskUserQuestion',
        tool_input: TWO_QUESTIONS,
      });
      const card = await waitFor(() => cards()[0], 'unpaired card');
      await post('PostToolUse', {
        tool_name: 'AskUserQuestion',
        tool_input: { ...TWO_QUESTIONS, answers: { 'Which color do you prefer?': 'Red' } },
        tool_use_id: 'toolu_unseen',
        tool_response: {},
      });
      expect(await (await response).text()).toBe('{}');
      expect(cards()).toHaveLength(0);
      // Released to the terminal, not closed: the phone is told.
      expect(notices).toEqual([{ questionId: card.id, reason: 'released' }]);
      expect(ptyWrites).toEqual([]);
    });

    test('Esc in the terminal: Claude closes the held request and the card is dismissed', async () => {
      const { handlers, gate } = build();
      await lock();
      const client = new AbortController();
      const { card, response } = await ask('AskUserQuestion', TWO_QUESTIONS, {}, client.signal);
      client.abort();
      await response.catch(() => undefined);
      await waitFor(() => dismissed.includes(card.id), 'dismissal');
      expect(cards()).toHaveLength(0);
      expect(gate.isHeld(card.id)).toBe(false);
      // A phone answer arriving after the close is refused, never typed.
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [
          { questionIndex: 0, optionIndices: [0] },
          { questionIndex: 1, optionIndices: [0] },
        ],
      });
      expect(errors()[0]?.code).toBe('STALE_ANSWER');
      expect(ptyWrites).toEqual([]);
    });

    test('the deadline releases the hold empty and tells the phone to answer at the terminal', async () => {
      const { handlers } = build({ holdMs: 60 });
      await lock();
      const { card, response } = await ask('AskUserQuestion', TWO_QUESTIONS);
      expect(await (await response).text()).toBe('{}');
      expect(notices).toEqual([{ questionId: card.id, reason: 'hold_deadline' }]);
      expect(cards()).toHaveLength(0);
      // A late answer is refused as closed.
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, { cancel: true });
      expect(ptyWrites).toEqual([]);
    });

    test('chat text is refused while it is held', async () => {
      const { handlers } = build();
      await lock();
      const { card } = await ask('AskUserQuestion', TWO_QUESTIONS);
      await handlers.onUserInput(CONN, SID, 'Green and Apple please', false);
      expect(errors()[0]).toMatchObject({
        code: 'PROMPT_WAITING',
        message: PROMPT_WAITING_HELD_MESSAGE,
      });
      expect(cards().map((q) => q.id)).toEqual([card.id]);
      expect(ptyWrites).toEqual([]);
    });
  });

  describe('ExitPlanMode', () => {
    test('the card carries the plan and options by meaning; it is held', async () => {
      const { gate } = build();
      await lock();
      const { card } = await ask('ExitPlanMode', PLAN, { permission_mode: 'plan' });
      expect(card.held).toBe(true);
      expect(gate.isHeld(card.id)).toBe(true);
      expect(card.kind).toBe('plan_approval');
      expect(card.text).toBe('Plan ready for review');
      expect(card.detail).toBe(PLAN.plan);
      expect(card.options.map((o) => o.label)).toEqual([
        'Approve, auto-accept edits',
        'Approve, approve edits manually',
        'Keep planning',
      ]);
    });

    test.each([
      ['Approve, auto-accept edits', 'acceptEdits'],
      ['Approve, approve edits manually', 'default'],
    ])('"%s" echoes the plan exactly and sets %s for the session', async (label, mode) => {
      const { handlers } = build();
      await lock();
      const { card, response } = await ask('ExitPlanMode', PLAN, { permission_mode: 'plan' });
      await handlers.onAnswer(CONN, SID, card.id, label);
      const raw = await (await response).text();
      expect(JSON.parse(raw)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: PLAN,
            updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
          },
        },
      });
      // Byte for byte: the plan and its path, keys in Claude's order.
      expect(raw).toContain(JSON.stringify({ plan: PLAN.plan, planFilePath: PLAN.planFilePath }));
      expect(ptyWrites).toEqual([]);
    });

    test('"Keep planning" with a message denies with that message; without one, "Keep planning."', async () => {
      const { handlers } = build();
      await lock();
      const a = await ask('ExitPlanMode', PLAN, { permission_mode: 'plan' });
      await handlers.onAnswer(CONN, SID, a.card.id, 'Keep planning', undefined, {
        message: 'Add a step that runs the tests.',
      });
      expect(await decisionOf(a.response)).toEqual({
        behavior: 'deny',
        message: 'Add a step that runs the tests.',
      });
      const b = await ask('ExitPlanMode', PLAN, { permission_mode: 'plan' });
      await handlers.onAnswer(CONN, SID, b.card.id, '3');
      expect(await decisionOf(b.response)).toEqual({ behavior: 'deny', message: 'Keep planning.' });
      expect(ptyWrites).toEqual([]);
    });

    test('answered in the terminal: the paired PostToolUse (input {}) releases the hold', async () => {
      build();
      await lock();
      const { card, response, toolUseId } = await ask('ExitPlanMode', PLAN, {
        permission_mode: 'plan',
      });
      await post('PostToolUse', {
        tool_name: 'ExitPlanMode',
        tool_input: {},
        tool_use_id: toolUseId,
        tool_response: { plan: PLAN.plan, isAgent: false, filePath: PLAN.planFilePath },
        permission_mode: 'acceptEdits',
      });
      expect(await (await response).text()).toBe('{}');
      expect(dismissed).toEqual([card.id]);
      expect(notices).toEqual([]);
      expect(ptyWrites).toEqual([]);
    });

    test('chat text is refused while it is held', async () => {
      const { handlers } = build();
      await lock();
      await ask('ExitPlanMode', PLAN, { permission_mode: 'plan' });
      await handlers.onUserInput(CONN, SID, 'looks good', false);
      expect(errors()[0]?.code).toBe('PROMPT_WAITING');
      expect(ptyWrites).toEqual([]);
    });
  });

  describe('subagent routing follows the terminal (#1126)', () => {
    const SUBAGENT = { agent_id: 'agent-plan-1', agent_type: 'Plan' };

    test('wrapper mode: passed to the terminal at once, no answerable card', async () => {
      const { gate } = build();
      await lock();
      await post('PreToolUse', {
        tool_name: 'ExitPlanMode',
        tool_input: PLAN,
        tool_use_id: 'toolu_sub',
        ...SUBAGENT,
      });
      const res = await post('PermissionRequest', {
        tool_name: 'ExitPlanMode',
        tool_input: PLAN,
        ...SUBAGENT,
      });
      expect(await res.text()).toBe('{}');
      expect(cards()).toHaveLength(0);
      expect(pushes).toEqual([]);
      expect(gate.hasMainHold()).toBe(false);
      expect(ptyWrites).toEqual([]);
    });

    test("daemon mode: a subagent's plan is approved without changing the session's mode (review S5)", async () => {
      const { handlers } = build({ hasLocalTerminal: false });
      await lock();
      const { card, response } = await ask('ExitPlanMode', PLAN, {
        permission_mode: 'plan',
        ...SUBAGENT,
      });
      expect(card.options.map((o) => o.label)).toEqual(['Approve', 'Keep planning']);
      // The main agent's mode-setting label is not this card's: refused.
      await handlers.onAnswer(CONN, SID, card.id, 'Approve, auto-accept edits');
      expect(errors()[0]?.code).toBe('STALE_ANSWER');
      await handlers.onAnswer(CONN, SID, card.id, 'Approve');
      expect(await decisionOf(response)).toEqual({ behavior: 'allow', updatedInput: PLAN });
      expect(ptyWrites).toEqual([]);
    });

    test('daemon mode: held with an answerable card, answered from the phone', async () => {
      const { handlers, gate } = build({ hasLocalTerminal: false });
      await lock();
      const { card, response } = await ask('AskUserQuestion', ONE_QUESTION, SUBAGENT);
      expect(card.agentId).toBe(SUBAGENT.agent_id);
      expect(gate.isHeld(card.id)).toBe(true);
      // Its dialog does not render while held, so chat is not refused for it.
      expect(gate.hasMainHold()).toBe(false);
      await handlers.onAnswer(CONN, SID, card.id, '', undefined, {
        selections: [{ questionIndex: 0, optionIndices: [0] }],
      });
      expect(await decisionOf(response)).toEqual({
        behavior: 'allow',
        updatedInput: { ...ONE_QUESTION, answers: { 'Which color do you prefer?': 'Red' } },
      });
      expect(ptyWrites).toEqual([]);
    });
  });

  describe('the lock screen and Watch relay (POST /answer)', () => {
    let wsServer: WebSocketServer | null = null;

    afterEach(async () => {
      if (wsServer?.running) await wsServer.stop();
      wsServer = null;
    });

    async function startRelay(
      relayAnswer: ReturnType<typeof build>['handlers']['relayAnswer'],
    ): Promise<number> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const port = 42_000 + Math.floor(Math.random() * 8_000);
        const s = new WebSocketServer(
          { port, host: '127.0.0.1' },
          { onAnswerRelay: (sid, qid, answer, csid) => relayAnswer(sid, qid, answer, csid) },
        );
        try {
          await s.start();
          wsServer = s;
          return port;
        } catch {
          // Port taken; try another.
        }
      }
      throw new Error('no free port for the relay server');
    }

    test("a one-question AskUserQuestion is answered by the tapped option's label, structurally, with nothing on screen", async () => {
      const { handlers, tracker } = build();
      await lock();
      const { card, response } = await ask('AskUserQuestion', ONE_QUESTION);
      // No prompt observed on screen: a typed answer would be refused here,
      // a structured one does not depend on the screen.
      expect(tracker.observedPromptOptions()).toBeNull();
      const port = await startRelay(handlers.relayAnswer);
      const res = await fetch(`http://127.0.0.1:${port}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SID, questionId: card.id, answer: 'Green' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { result: string }).result).toBe('delivered');
      expect(await decisionOf(response)).toEqual({
        behavior: 'allow',
        updatedInput: { ...ONE_QUESTION, answers: { 'Which color do you prefer?': 'Green' } },
      });
      expect(ptyWrites).toEqual([]);
    });

    test('a tap that cannot answer every question is refused and the hold stays', async () => {
      const { handlers, gate } = build();
      await lock();
      const { card } = await ask('AskUserQuestion', TWO_QUESTIONS);
      const port = await startRelay(handlers.relayAnswer);
      const res = await fetch(`http://127.0.0.1:${port}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SID, questionId: card.id, answer: 'Green' }),
      });
      expect(res.status).toBe(409);
      expect(gate.isHeld(card.id)).toBe(true);
      expect(cards().map((q) => q.id)).toEqual([card.id]);
      expect(ptyWrites).toEqual([]);
    });

    describe('numeric labels (#1127 review S1)', () => {
      // The card's picks: value "1" is labeled "4", "2" is "2", "3" is "1".
      const NUMBERS = {
        questions: [{ question: 'Pick a number', options: ['4', '2', '1'] }],
      };

      async function relay(port: number, questionId: string, answer: string) {
        return fetch(`http://127.0.0.1:${port}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: SID, questionId, answer }),
        });
      }

      test('a lock-screen tap on "1" (another option\'s value) is refused, never answered as "4"', async () => {
        const { handlers, gate } = build();
        await lock();
        const { card, response } = await ask('AskUserQuestion', NUMBERS);
        expect(card.options.map((o) => [o.value, o.label])).toEqual([
          ['1', '4'],
          ['2', '2'],
          ['3', '1'],
        ]);
        const port = await startRelay(handlers.relayAnswer);
        const res = await relay(port, card.id, '1');
        expect(res.status).toBe(409);
        expect(gate.isHeld(card.id)).toBe(true);
        expect(cards().map((q) => q.id)).toEqual([card.id]);
        // The label "4" names one option only: it answers.
        expect((await relay(port, card.id, '4')).status).toBe(200);
        expect(await decisionOf(response)).toEqual({
          behavior: 'allow',
          updatedInput: { ...NUMBERS, answers: { 'Pick a number': '4' } },
        });
        expect(ptyWrites).toEqual([]);
      });

      test('a Telegram tap sending value "1" (another option\'s label) is refused; value "2" answers "2"', async () => {
        const { handlers, gate } = build();
        await lock();
        const { card, response } = await ask('AskUserQuestion', NUMBERS);
        await handlers.onAnswer(CONN, SID, card.id, '1');
        const refusal = errors()[0];
        expect(refusal?.code).toBe('STALE_ANSWER');
        expect(refusal?.message).toContain('by its number and another by its label');
        expect(gate.isHeld(card.id)).toBe(true);
        expect(cards().map((q) => q.id)).toEqual([card.id]);
        await handlers.onAnswer(CONN, SID, card.id, '2');
        expect(await decisionOf(response)).toEqual({
          behavior: 'allow',
          updatedInput: { ...NUMBERS, answers: { 'Pick a number': '2' } },
        });
        expect(ptyWrites).toEqual([]);
      });
    });

    test('a plan is answered by label through the relay too, and never by a position', async () => {
      const { handlers } = build();
      await lock();
      const { card, response } = await ask('ExitPlanMode', PLAN, { permission_mode: 'plan' });
      const port = await startRelay(handlers.relayAnswer);
      const res = await fetch(`http://127.0.0.1:${port}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: SID,
          questionId: card.id,
          answer: 'Approve, approve edits manually',
        }),
      });
      expect(res.status).toBe(200);
      expect(await decisionOf(response)).toMatchObject({
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
      });
      expect(ptyWrites).toEqual([]);
    });
  });
});
