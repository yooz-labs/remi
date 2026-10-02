/**
 * #1140: free-form text typed from the phone while a numbered prompt menu is
 * on screen.
 *
 * `onUserInput` types the text followed by Enter. Claude's selection menu
 * ignores the letters and the Enter confirms the highlighted option, usually
 * "1. Yes", so a chat message or a Telegram text reply sent while a prompt
 * waits approved the pending action. These tests drive the REAL handlers
 * (`createInputHandlers` with `trackerScreenDeps`, the wiring `cli.ts` uses)
 * against a REAL `QuestionPresenceTracker` that observed a REAL Claude dialog
 * through the REAL parser. Nothing about the screen is faked: the menu is the
 * 2.1.287 permission dialog captured live for #1134.
 *
 * The Telegram test also constructs the real `TelegramAdapter` on the sending
 * side (ADR 0014); only the grammY bot's `api.sendMessage` is a recording
 * transport double.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PROMPT_WAITING_ERROR_CODE,
  PROMPT_WAITING_MESSAGE,
  type ProtocolMessage,
  type UUID,
  generateId,
} from '@remi/shared';
import { TelegramAdapter } from '../../../src/adapters/telegram-adapter.ts';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { createInputHandlers, trackerScreenDeps } from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { parseQuestion } from '../../../src/parser/question-parser.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import {
  CID,
  type PtyCapture,
  claudeMenu,
  errorsOf,
  fakeMessageAPI,
  fakePTY,
} from './menu-test-helpers.ts';

describe('chat text while a prompt menu is on screen (#1140)', () => {
  let sessionRegistry: SessionRegistry;
  let bindingStore: SessionBindingStore;
  let tmpDir: string;
  let sent: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let send: (connectionId: UUID, message: ProtocolMessage) => boolean;
  let pty: PtyCapture;
  let sessionId: UUID;
  let tracker: QuestionPresenceTracker;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-chat-into-menu-'));
    bindingStore = new SessionBindingStore(new SessionStore(path.join(tmpDir, 'sessions.json')));
    sent = [];
    send = (connectionId, message) => {
      sent.push({ connectionId, message });
      return true;
    };
    configureLogger({ writeLog: () => {} });
    pty = { writes: [], submits: [] };
    sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(pty), fakeMessageAPI());
    sessionRegistry.attachConnection(sessionId, CID);
    // The tracker pushes its card into the registry, as cli.ts's does.
    tracker = new QuestionPresenceTracker((q) => {
      sessionRegistry.addQuestion(sessionId, q);
      return undefined;
    });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The handlers exactly as cli.ts wires them: the tracker's screen deps. */
  function handlers() {
    return createInputHandlers({
      sessionRegistry,
      bindingStore,
      send,
      ...trackerScreenDeps((sid) => (sid === sessionId ? tracker : undefined)),
    });
  }

  test('chat text is refused while a numbered menu is on screen: nothing typed, PROMPT_WAITING sent', async () => {
    tracker.onPTYPromptVisible(claudeMenu());
    // The premise: the tracker observes the menu the parser read.
    expect(tracker.observedPromptOptions()?.map((o) => o.value)).toEqual(['1', '2', '3']);
    const messageId = generateId();

    await handlers().onUserInput(CID, sessionId, 'please use rm -i', false, undefined, messageId);

    expect(pty.submits).toEqual([]);
    expect(pty.writes).toEqual([]);
    const errors = errorsOf(sent);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe(PROMPT_WAITING_ERROR_CODE);
    expect(errors[0]?.code).toBe('PROMPT_WAITING');
    expect(errors[0]?.message).toBe(
      'Claude is waiting on a prompt. Answer it from its card or in the terminal (Esc dismisses it).',
    );
    expect(errors[0]?.message).toBe(PROMPT_WAITING_MESSAGE);
    // The refused bubble can be named, so the client can flip it to failed.
    expect(errors[0]?.details).toEqual({ sessionId, messageId });
    expect(sent[0]?.connectionId).toBe(CID);
  });

  test('chat text is typed when no menu is on screen', async () => {
    await handlers().onUserInput(CID, sessionId, 'hello world', false);

    expect(pty.submits).toEqual(['hello world']);
    expect(errorsOf(sent)).toHaveLength(0);
  });

  test('a menu cleared by a non-waiting status stops refusing: the next chat text is typed', async () => {
    tracker.onPTYPromptVisible(claudeMenu());
    await handlers().onUserInput(CID, sessionId, 'while the menu is up', false);
    expect(pty.submits).toEqual([]);
    expect(errorsOf(sent)).toHaveLength(1);

    // The user answered in the terminal and Claude went back to work.
    tracker.onStatusChange('thinking');
    expect(tracker.observedPromptOptions()).toBeNull();
    await handlers().onUserInput(CID, sessionId, 'after the menu', false);

    expect(pty.submits).toEqual(['after the menu']);
    expect(errorsOf(sent)).toHaveLength(1);
  });

  test('a free-text prompt on screen (no menu) still takes chat text', async () => {
    const waiting = parseQuestion('Please enter your response:');
    if (!waiting.question) throw new Error('the free-text prompt did not parse');
    expect(waiting.question.options).toHaveLength(0);
    tracker.onPTYPromptVisible(waiting.question);
    expect(tracker.observedPromptOptions()).toEqual([]);

    await handlers().onUserInput(CID, sessionId, 'my-widget', false);

    expect(pty.submits).toEqual(['my-widget']);
    expect(errorsOf(sent)).toHaveLength(0);
  });

  test('no tracker for the session: the text is typed as before (the chat works without a hook server)', async () => {
    const noTracker = createInputHandlers({
      sessionRegistry,
      bindingStore,
      send,
      ...trackerScreenDeps(() => undefined),
    });

    await noTracker.onUserInput(CID, sessionId, 'no tracker here', false);

    expect(pty.submits).toEqual(['no tracker here']);
    expect(errorsOf(sent)).toHaveLength(0);
  });

  test('screen deps not wired at all: the text is typed as before', async () => {
    const bare = createInputHandlers({ sessionRegistry, bindingStore, send });

    await bare.onUserInput(CID, sessionId, 'bare handlers', false);

    expect(pty.submits).toEqual(['bare handlers']);
    expect(errorsOf(sent)).toHaveLength(0);
  });

  test('raw terminal input is never refused: it is how a menu gets answered', async () => {
    tracker.onPTYPromptVisible(claudeMenu());

    // A digit or arrow from an attach client, and the web client's persistent
    // Escape (a raw `\x1b`), both reach the terminal while the menu is up.
    await handlers().onUserInput(CID, sessionId, '3', true);
    await handlers().onUserInput(CID, sessionId, '\x1b[B', true);
    await handlers().onUserInput(CID, sessionId, '\x1b', true);

    expect(pty.writes).toEqual(['3', '\x1b[B', '\x1b']);
    expect(pty.submits).toEqual([]);
    expect(errorsOf(sent)).toHaveLength(0);
  });

  test('the refusal covers the tracker-pushed hook-less card too (it is the same screen)', async () => {
    tracker.onPTYPromptVisible(claudeMenu());
    // The card the phone shows for this prompt is registered.
    expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(1);

    await handlers().onUserInput(CID, sessionId, 'yes please', false);

    expect(pty.submits).toEqual([]);
    // Refusing chat does not consume the card: it is still answerable.
    expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(1);
  });

  describe('Telegram custom text', () => {
    const CHAT_ID = 100;
    const TOPIC_ID = 200;

    /** The real adapter bound to the registry's session, over a recording
     *  `bot.api.sendMessage`. Its `onUserInput` event is the real handler and
     *  its `error` rendering is what the handler's `send` reaches (cli.ts's
     *  `sendToConnection` is `registry.sendRaw`, which lands on `sendRaw`). */
    function telegramOverRealHandlers(options: { attached?: boolean } = {}) {
      const chatMessages: Array<{ chatId: number; text: string }> = [];
      /** What the bot said back through the command context (`ctx.reply`). */
      const replies: string[] = [];
      // The daemon's reply path for this connection (cli.ts's `sendToConnection`
      // is `registry.sendRaw`, which lands on the adapter's `sendRaw`). Set
      // before the handlers are built, because they capture `send` there.
      const reply: { adapter?: TelegramAdapter } = {};
      send = (connectionId, message) => reply.adapter?.sendRaw(connectionId, message) ?? false;
      const input = handlers();
      const adapter = new TelegramAdapter(
        { token: 'fake-token-not-used', enabled: true, defaultDirectory: '/tmp' },
        { onUserInput: input.onUserInput },
      );
      reply.adapter = adapter;
      const internal = adapter as unknown as {
        bot: { api: { sendMessage: (chatId: number, text: string) => Promise<unknown> } };
        sessions: Map<string, Record<string, unknown>>;
        connectionToSession: Map<UUID, string>;
        handleTextMessage: (ctx: unknown) => Promise<void>;
        handleInterrupt: (ctx: unknown) => Promise<void>;
      };
      internal.bot = {
        api: {
          sendMessage: async (chatId, text) => {
            chatMessages.push({ chatId, text });
            return { message_id: 1 };
          },
        },
      };
      const telegramConn = generateId();
      // An unattached connection is one the daemon cannot route input for
      // (SESSION_NOT_FOUND), the refusal path that does not depend on a menu.
      if (options.attached !== false) sessionRegistry.attachConnection(sessionId, telegramConn);
      const key = `${CHAT_ID}:${TOPIC_ID}`;
      internal.sessions.set(key, {
        connectionId: telegramConn,
        sessionId,
        chatId: CHAT_ID,
        topicId: TOPIC_ID,
        workingDirectory: '/tmp',
        machineName: 'test-machine',
        topicName: 'test-topic',
        sessionNumber: 1,
        startedAt: new Date().toISOString(),
        currentMessageId: undefined,
        streamBuffer: '',
        lastSentContent: '',
        paused: false,
      });
      internal.connectionToSession.set(telegramConn, key);
      const text = (body: string) =>
        internal.handleTextMessage({
          chat: { id: CHAT_ID },
          message: { text: body, message_thread_id: TOPIC_ID },
          reply: async (body: string) => {
            replies.push(body);
          },
        });
      const interrupt = () =>
        internal.handleInterrupt({
          chat: { id: CHAT_ID },
          message: { message_thread_id: TOPIC_ID },
          reply: async (body: string) => {
            replies.push(body);
          },
        });
      return { chatMessages, replies, text, interrupt };
    }

    test('custom text sent while a menu is up is refused back into the Telegram chat, nothing typed', async () => {
      tracker.onPTYPromptVisible(claudeMenu());
      const { chatMessages, text } = telegramOverRealHandlers();

      await text('use rm -i instead');

      expect(pty.submits).toEqual([]);
      expect(chatMessages).toEqual([
        {
          chatId: CHAT_ID,
          text: 'Error: Claude is waiting on a prompt. Answer it from its card or in the terminal (Esc dismisses it).',
        },
      ]);
    });

    // /interrupt sends its Escape RAW, as the web client's Escape button does:
    // exactly `\x1b` reaches the terminal (structured input would append an
    // Enter, which lands on whatever Claude draws next), and the daemon's
    // chat-into-menu guard never sees it.
    test('/interrupt with a menu up writes exactly the raw Escape and replies success', async () => {
      tracker.onPTYPromptVisible(claudeMenu());
      const { chatMessages, replies, interrupt } = telegramOverRealHandlers();

      await interrupt();

      expect(pty.writes).toEqual(['\x1b']);
      expect(pty.submits).toEqual([]);
      expect(replies).toEqual(['⏹️ Interrupt sent to Claude (Escape key)']);
      expect(chatMessages).toEqual([]);
    });

    test('/interrupt with no menu up is the same raw Escape and the same reply', async () => {
      const { chatMessages, replies, interrupt } = telegramOverRealHandlers();

      await interrupt();

      expect(pty.writes).toEqual(['\x1b']);
      expect(pty.submits).toEqual([]);
      expect(replies).toEqual(['⏹️ Interrupt sent to Claude (Escape key)']);
      expect(chatMessages).toEqual([]);
    });

    // A refusal that does not depend on a menu: the daemon cannot route input
    // for a connection that is not attached to the session. Text and
    // /interrupt both surface the daemon's error text in the chat.
    test('text the daemon cannot route is answered with the error text', async () => {
      const { chatMessages, text } = telegramOverRealHandlers({ attached: false });

      await text('hello from telegram');

      expect(pty.submits).toEqual([]);
      expect(chatMessages.map((m) => m.text)).toEqual([
        `Error: This connection is not attached to session ${sessionId}; input was not delivered.`,
      ]);
    });

    test('/interrupt the daemon cannot route replies with the error text, not "Interrupt sent"', async () => {
      const { chatMessages, replies, interrupt } = telegramOverRealHandlers({ attached: false });

      await interrupt();

      expect(pty.writes).toEqual([]);
      expect(pty.submits).toEqual([]);
      expect(chatMessages.map((m) => m.text)).toEqual([
        `Error: This connection is not attached to session ${sessionId}; input was not delivered.`,
      ]);
      expect(replies).toEqual([]);
    });

    // A raw write that fails (the terminal has exited) was only logged, so
    // "Interrupt sent" was claimed for an Escape that never arrived.
    test('/interrupt whose raw terminal write fails shows the error, not "Interrupt sent"', async () => {
      pty.writeError = new Error('terminal gone');
      const { chatMessages, replies, interrupt } = telegramOverRealHandlers();

      await interrupt();

      expect(pty.writes).toEqual([]);
      expect(chatMessages.map((m) => m.text)).toEqual([
        'Error: Input was not delivered: the terminal is not accepting input.',
      ]);
      expect(replies).toEqual([]);
    });

    test('custom text with no menu on screen is typed and nothing is reported', async () => {
      const { chatMessages, text } = telegramOverRealHandlers();

      await text('hello from telegram');

      expect(pty.submits).toEqual(['hello from telegram']);
      expect(chatMessages).toEqual([]);
    });
  });
});

/**
 * The refusal's trace record. The trace is opt-in and writes under the home
 * directory resolved at process start, so the real behavior is observed in a
 * fresh subprocess with `HOME` pointed at a throwaway directory, the pattern
 * `question-trace.test.ts` uses.
 */
describe('chat-into-menu trace event (#1140)', () => {
  const WORKER = path.join(import.meta.dir, 'chat-into-menu-trace-worker.ts');

  async function runWorker(home: string, traceEnabled: boolean): Promise<void> {
    const { REMI_QUESTION_TRACE: _inherited, ...rest } = process.env;
    const env = { ...rest, HOME: home, ...(traceEnabled ? { REMI_QUESTION_TRACE: '1' } : {}) };
    const proc = Bun.spawn(['bun', WORKER], { env, stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`worker exited ${code}: ${await new Response(proc.stderr).text()}`);
    }
  }

  function traceLines(home: string): Record<string, unknown>[] {
    const file = path.join(home, '.remi', 'question-trace.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  }

  test('a refused chat message records reason chat-into-menu, with the length and not the text', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-chat-trace-'));
    try {
      await runWorker(home, true);
      const refused = traceLines(home).filter((l) => l['action'] === 'input_refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        action: 'input_refused',
        signal: 'PROMPT_WAITING',
        callSite: 'input-events.onUserInput:chatIntoMenuGuard',
        detail: { reason: 'chat-into-menu', textLength: 'a secret message'.length },
      });
      expect(refused[0]?.['questionId']).toBeUndefined();
      expect((refused[0]?.['detail'] as { screenValues: string[] }).screenValues).toEqual([
        '1',
        '2',
        '3',
      ]);
      // The text itself is never written.
      expect(JSON.stringify(traceLines(home))).not.toContain('a secret message');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('tracing off (the default): the refusal still happens and nothing is written', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-chat-trace-'));
    try {
      await runWorker(home, false);
      expect(fs.existsSync(path.join(home, '.remi', 'question-trace.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
