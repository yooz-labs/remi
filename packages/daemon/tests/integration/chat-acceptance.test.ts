/**
 * Chat acceptance end to end (#1818): a `user_input` typed by the real input handler into a
 * real terminal (an owned `/bin/cat` PTY, no Claude process), and Claude's `UserPromptSubmit`
 * hook delivered over real HTTP to a real `HookServer` and the real hook bridge. Nothing here
 * stands in for the matching: the tracker, the handler and the bridge listener are the
 * production ones, wired as `cli.ts` wires them.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProtocolMessage, type UUID, generateId } from '@remi/shared';
import { MessageAPI } from '../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { ChatAcceptanceTracker } from '../../src/cli/handlers/chat-acceptance.ts';
import { createInputHandlers } from '../../src/cli/handlers/input-events.ts';
import type { PromptUp } from '../../src/cli/handlers/prompt-up.ts';
import { createTranscriptHandlers } from '../../src/cli/handlers/transcript-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  type HookBridgeHandle,
  setupHookBridge,
} from '../../src/cli/session-phases/hook-bridge-setup.ts';
import { HookServer } from '../../src/hooks/hook-server.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptIndex } from '../../src/session/transcript-index.ts';
import { TranscriptDiscovery } from '../../src/transcript/index.ts';

const CONN_A = generateId() as UUID;
const CONN_B = generateId() as UUID;

interface Sent {
  readonly connectionId: UUID;
  readonly message: ProtocolMessage;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe('chat acceptance through the hook bridge (#1818)', () => {
  let home: string;
  let registry: SessionRegistry;
  let pty: PTYSession;
  let ptyOutput: string;
  let server: HookServer;
  let handle: HookBridgeHandle;
  let sent: Sent[];
  let liveEntries: ProtocolMessage[];
  let clock: number;
  let sessionId: UUID;
  let claudeId: string;
  let promptUp: PromptUp | null;
  /** Runs between the typed text and its Enter: the window a late refusal happens in. */
  let afterTextBeforeEnter: () => void;
  let handlers: ReturnType<typeof createInputHandlers>;
  let history: ReturnType<typeof createTranscriptHandlers>;
  const watchers = new Map();
  const timers = new Map<UUID, ReturnType<typeof setInterval>>();

  beforeEach(async () => {
    configureLogger({ writeLog: () => {} });
    home = mkdtempSync(join(tmpdir(), 'remi-chat-acceptance-'));
    ptyOutput = '';
    sent = [];
    liveEntries = [];
    clock = 1_000_000;
    promptUp = null;
    afterTextBeforeEnter = () => {};
    claudeId = generateId();
    registry = new SessionRegistry({ orphanTimeoutMs: 60_000 });
    sessionId = registry.createSessionId();
    // A raw, silent terminal that reports every byte actually written to it.
    pty = new PTYSession(
      {
        command: '/bin/sh',
        args: ['-c', 'stty raw -echo; printf __ready__; exec /bin/cat'],
        cwd: home,
      },
      {
        onData: (data) => {
          ptyOutput += data;
        },
      },
      {
        submitDelay: async () => {
          afterTextBeforeEnter();
        },
      },
    );
    pty.start();
    await until(() => ptyOutput.includes('__ready__'), 'the terminal to start');

    const messageApi = new MessageAPI({ sessionId, initialBulletId: 1 }, {});
    registry.registerSession(sessionId, home, pty, messageApi);
    registry.attachConnection(sessionId, CONN_A);
    registry.attachConnection(sessionId, CONN_B);
    const bindingStore = new SessionBindingStore(new SessionStore(join(home, 'sessions.json')));
    const liveSessionsRegistry = new SessionRegistryFile(join(home, 'live-sessions'));

    history = createTranscriptHandlers({
      isHiddenOwner: () => false,
      transcriptDiscovery: new TranscriptDiscovery(),
      harness: { transcriptPath: () => null },
      transcriptWatchers: watchers,
      bindingStore,
      transcriptIndex: new TranscriptIndex(join(home, 'transcript-index.json')),
      currentOwnedSession: () => null,
      subagentViews: { resolvePath: () => null },
      send: (connectionId, message) => {
        sent.push({ connectionId, message });
        return true;
      },
    });

    const chatAcceptance = new ChatAcceptanceTracker({
      send: (connectionId, message) => {
        sent.push({ connectionId, message });
        return true;
      },
      now: () => clock,
    });
    handlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore,
      send: (connectionId, message) => {
        sent.push({ connectionId, message });
        return true;
      },
      promptUp: () => promptUp,
      chatAcceptance,
    });

    server = new HookServer({ port: 0 });
    handle = setupHookBridge(
      {
        withholdTranscriptPath: false,
        sessionRegistry: registry,
        bindingStore,
        liveSessionsRegistry,
        transcriptWatchers: watchers,
        transcriptFallbackTimers: timers,
        currentPort: () => 8765,
        transcriptDiscovery: new TranscriptDiscovery(),
        holdMs: 60_000,
        terminalPromptMs: 60_000,
        hookTimeoutMs: 600_000,
        chatAcceptance,
      },
      {
        hookServer: server,
        sessionId,
        workingDirectory: home,
        messageApi,
        sendAndRecord: (message) => {
          liveEntries.push(message);
        },
        tracker: new QuestionPresenceTracker((q) => messageApi.handleQuestion(q)),
        hasLocalTerminal: true,
      },
    );
    server.start();
    // The first admitted event locks the binder onto Claude's session id.
    expect(
      (
        await post({
          hook_event_name: 'Notification',
          notification_type: 'auth_success',
          message: '',
        })
      ).status,
    ).toBe(200);
  });

  afterEach(async () => {
    __resetLoggerForTests();
    handle.closeBinder();
    server.stop();
    for (const t of timers.values()) clearInterval(t);
    await registry.shutdown();
    rmSync(home, { recursive: true, force: true });
  });

  function post(event: Record<string, unknown>, session = claudeId): Promise<Response> {
    return fetch(`${server.url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: session,
        transcript_path: join(home, `${session}.jsonl`),
        cwd: home,
        ...event,
      }),
    });
  }

  const submitted = (prompt: string, extra: Record<string, unknown> = {}, session = claudeId) =>
    post({ hook_event_name: 'UserPromptSubmit', prompt, session_title: 't', ...extra }, session);

  const results = () =>
    sent.filter((s) => s.message.type === 'user_input_result') as Array<{
      connectionId: UUID;
      message: Extract<ProtocolMessage, { type: 'user_input_result' }>;
    }>;

  const send = async (connection: UUID, text: string): Promise<UUID> => {
    const messageId = generateId() as UUID;
    await handlers.onUserInput(connection, sessionId, text, false, undefined, messageId);
    return messageId;
  };

  function queued(prompt: string, time: number, uuid: string): string {
    return `${JSON.stringify({ type: 'attachment', uuid, sessionId: claudeId, timestamp: new Date(time).toISOString(), attachment: { type: 'queued_command', prompt, source_uuid: `source-${uuid}`, delivery_id: `delivery-${uuid}`, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: new Date(time).toISOString(), humanTurn: true } })}\n`;
  }

  async function startTail(contents = ''): Promise<string> {
    const file = join(home, `${claudeId}.jsonl`);
    writeFileSync(file, contents);
    await until(() => watchers.get(sessionId)?.isTailing === true, 'live transcript tail');
    return file;
  }

  test('replay never accepts and live attachments must follow the send time', async () => {
    const messageId = await send(CONN_A, 'continue');
    const file = await startTail(
      queued('continue', clock - 1000, 'old') + queued('continue', clock + 1000, 'future-replay'),
    );
    await until(
      () =>
        liveEntries.some(
          (entry) => entry.type === 'transcript_content' && entry.entryUuid === 'old',
        ),
      'old replay',
    );
    expect(results()).toEqual([]);
    expect(
      liveEntries.some(
        (entry) => entry.type === 'transcript_content' && entry.entryUuid === 'future-replay',
      ),
    ).toBe(true);
    appendFileSync(file, queued('continue', clock - 1, 'early-live'));
    appendFileSync(file, queued('different', clock + 1000, 'different'));
    await until(
      () =>
        liveEntries.some(
          (entry) => entry.type === 'transcript_content' && entry.entryUuid === 'different',
        ),
      'early live entries',
    );
    expect(results()).toEqual([]);
    appendFileSync(file, queued('continue', clock + 1000, 'new'));
    await until(() => results().length === 1, 'queued acceptance');
    expect(results()[0]).toMatchObject({
      connectionId: CONN_A,
      message: { sessionId, messageId, outcome: 'accepted' },
    });
    await until(
      () =>
        liveEntries.some(
          (entry) => entry.type === 'transcript_content' && entry.entryUuid === 'new',
        ),
      'live queued entry',
    );
    await submitted('continue');
    expect(results()).toHaveLength(1);
    appendFileSync(file, queued('continue', clock + 1000, 'new'));
    await watchers.get(sessionId)?.forceRead();
    expect(results()).toHaveLength(1);
  });

  test('attachment and admitted hook together leave a second identical message pending', async () => {
    const first = await send(CONN_A, 'again');
    await send(CONN_B, 'again');
    const file = await startTail();
    appendFileSync(file, queued('again', clock + 1000, 'once'));
    await until(() => results().length === 1, 'first queued acceptance');
    await submitted('again');
    expect(results().map((result) => result.message.messageId)).toEqual([first]);
  });

  test('two live attachments confirm two identical submissions in FIFO order', async () => {
    const first = await send(CONN_A, 'again');
    const second = await send(CONN_B, 'again');
    const file = await startTail();
    appendFileSync(
      file,
      queued('again', clock + 1000, 'first') + queued('again', clock + 1000, 'second'),
    );
    await until(() => results().length === 2, 'both queued acceptances');
    expect(results().map((result) => [result.connectionId, result.message.messageId])).toEqual([
      [CONN_A, first],
      [CONN_B, second],
    ]);
  });

  test('send time is captured before the PTY writes, not after its Enter', async () => {
    const beforeWrite = clock;
    afterTextBeforeEnter = () => {
      clock += 2000;
    };
    const messageId = await send(CONN_A, 'timing');
    const file = await startTail();
    appendFileSync(file, queued('timing', beforeWrite + 1000, 'timing'));
    await until(() => results().length === 1, 'queued acceptance after send time');
    expect(results()[0]?.message.messageId).toBe(messageId);
  });

  test('hook before attachment does not confirm the next identical message', async () => {
    const first = await send(CONN_A, 'again');
    await send(CONN_B, 'again');
    const file = await startTail();
    await submitted('again');
    appendFileSync(file, queued('again', clock + 1000, 'later'));
    await until(
      () =>
        liveEntries.some(
          (entry) => entry.type === 'transcript_content' && entry.entryUuid === 'later',
        ),
      'later queued entry',
    );
    expect(results().map((result) => result.message.messageId)).toEqual([first]);
  });

  test('sidechain attachments do not confirm main-agent chat', async () => {
    await send(CONN_A, 'continue');
    const line = JSON.parse(queued('continue', clock + 1000, 'sidechain'));
    line.isSidechain = true;
    const file = await startTail();
    appendFileSync(
      file,
      `${JSON.stringify(line)}\n${queued('sentinel', clock + 1000, 'sentinel')}`,
    );
    await until(
      () =>
        liveEntries.some(
          (entry) => entry.type === 'transcript_content' && entry.entryUuid === 'sentinel',
        ),
      'sentinel entry',
    );
    expect(
      liveEntries.some(
        (entry) => entry.type === 'transcript_content' && entry.entryUuid === 'sidechain',
      ),
    ).toBe(false);
    expect(results()).toEqual([]);
    history.onTranscriptLoadRequest(CONN_A, sessionId, generateId() as UUID);
    await until(
      () => sent.some((item) => item.message.type === 'transcript_load_complete'),
      'history load',
    );
    const entries = sent
      .map((item) => item.message)
      .filter((message) => message.type === 'transcript_content');
    expect(entries.map((entry) => entry.entryUuid)).toEqual(['sentinel']);
  });

  test('Claude reporting the typed text confirms that message to its sender only', async () => {
    const messageId = await send(CONN_A, 'please run the tests');
    await until(() => ptyOutput.includes('please run the tests'), 'the typed text');
    expect(results()).toEqual([]);

    expect((await submitted('please run the tests')).status).toBe(200);

    expect(results()).toHaveLength(1);
    expect(results()[0]?.connectionId).toBe(CONN_A);
    expect(results()[0]?.message).toMatchObject({ sessionId, messageId, outcome: 'accepted' });
    // Nothing reached the other attached connection.
    expect(sent.filter((s) => s.connectionId === CONN_B)).toEqual([]);
  });

  test('a prompt that differs in any way confirms nothing', async () => {
    await send(CONN_A, 'please run the tests');
    await submitted('please run the test');
    await submitted('Please run the tests');
    await submitted('please run the tests ');
    expect(results()).toEqual([]);
  });

  test('two identical messages are confirmed first in, first out, each to its sender', async () => {
    const first = await send(CONN_A, 'again');
    const second = await send(CONN_B, 'again');

    await submitted('again');
    expect(results().map((r) => [r.connectionId, r.message.messageId])).toEqual([[CONN_A, first]]);
    await submitted('again');
    expect(results().map((r) => [r.connectionId, r.message.messageId])).toEqual([
      [CONN_A, first],
      [CONN_B, second],
    ]);
    await submitted('again');
    expect(results()).toHaveLength(2);
  });

  test('a multi-line message is confirmed by its exact text', async () => {
    const messageId = await send(CONN_A, 'line one\nline two');
    await submitted('line one line two');
    expect(results()).toEqual([]);
    await submitted('line one\nline two');
    expect(results().map((r) => r.message.messageId)).toEqual([messageId]);
  });

  test('a message that waited past its deadline is never confirmed', async () => {
    // The tracker's clock is the only injected part: it is a time source, not logic.
    const { CHAT_ACCEPTANCE_TTL_MS } = await import('../../src/cli/handlers/chat-acceptance.ts');
    await send(CONN_A, 'too late');
    clock += CHAT_ACCEPTANCE_TTL_MS + 1;
    await submitted('too late');
    expect(results()).toEqual([]);
  });

  test("a subagent's prompt with the same text is ignored; the main agent's confirms", async () => {
    const messageId = await send(CONN_A, 'status please');
    await submitted('status please', { agent_id: 'agent-1', agent_type: 'Explore' });
    expect(results()).toEqual([]);
    await submitted('status please');
    expect(results().map((r) => r.message.messageId)).toEqual([messageId]);
  });

  test("another Claude session's prompt is not admitted and confirms nothing", async () => {
    await send(CONN_A, 'which session');
    await submitted('which session', {}, generateId());
    expect(results()).toEqual([]);
  });

  test('a prompt typed at the terminal with nothing pending does nothing', async () => {
    expect((await submitted('typed at the keyboard')).status).toBe(200);
    expect(sent).toEqual([]);
    // And it does not pre-confirm a message sent later with the same text.
    await send(CONN_A, 'typed at the keyboard');
    expect(results()).toEqual([]);
  });

  test('a message the handler refused is never recorded', async () => {
    promptUp = 'menu';
    await send(CONN_A, 'blocked by a menu');
    promptUp = null;
    await submitted('blocked by a menu');
    expect(results()).toEqual([]);
    expect(sent.some((s) => s.message.type === 'error')).toBe(true);
  });

  test('a message whose Enter the guard refused after the text was typed is never confirmed', async () => {
    // A prompt appears between the text and its Enter (#1488): the handler stops before the Enter,
    // tells the sender, and Claude never submits that text.
    afterTextBeforeEnter = () => {
      promptUp = 'terminal';
    };
    await send(CONN_A, 'half typed');
    afterTextBeforeEnter = () => {};
    promptUp = null;
    const refusal = sent.find((s) => s.message.type === 'error');
    expect(refusal?.message).toMatchObject({
      code: 'PROMPT_WAITING',
      details: { inputMayBePartial: true },
    });
    await until(() => ptyOutput.includes('half typed'), 'the typed text');
    expect(ptyOutput).not.toContain('half typed\r');
    // Whatever Claude later reports with that text, the refused message is not the one it took.
    await submitted('half typed');
    expect(results()).toEqual([]);
  });

  test('a message without an id and a raw keystroke are not tracked', async () => {
    await handlers.onUserInput(CONN_A, sessionId, 'no id', false);
    await handlers.onUserInput(
      CONN_A,
      sessionId,
      'raw text',
      true,
      undefined,
      generateId() as UUID,
    );
    await submitted('no id');
    await submitted('raw text');
    expect(results()).toEqual([]);
  });

  test('the text really reached the terminal before the confirmation could arrive', async () => {
    const messageId = await send(CONN_A, 'ordering');
    // The bytes are already written (text then Enter) when onUserInput resolves.
    await until(() => ptyOutput.includes('ordering\r'), 'the text and its Enter');
    await submitted('ordering');
    expect(results().map((r) => r.message.messageId)).toEqual([messageId]);
  });
});
