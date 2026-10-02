/**
 * Tests for TelegramAdapter class.
 *
 * These tests create adapter instances without starting the bot
 * (no TELEGRAM_BOT_TOKEN needed). They test method behavior on
 * the adapter object directly.
 */

import { describe, expect, mock, test } from 'bun:test';
import type {
  AgentOutputMessage,
  DaemonUpdateAvailableMessage,
  ErrorMessage,
  HelloAckMessage,
  KillSessionResponseMessage,
  ProtocolMessage,
  QuestionMessage,
  ReplayBatchMessage,
  ResumeSessionResponseMessage,
  SessionHistoryResponseMessage,
  SessionListResponseMessage,
  SessionRotatedMessage,
  SessionUpdateMessage,
  StructuredAgentOutputMessage,
  TranscriptContentMessage,
  TranscriptLoadCompleteMessage,
  UUID,
} from '@remi/shared';
import { createError, generateId, now } from '@remi/shared';
import type { AdapterEvents } from '../src/adapters/connection-adapter.ts';
import { TelegramAdapter } from '../src/adapters/telegram-adapter.ts';

function createAdapter(events: Partial<AdapterEvents> = {}): TelegramAdapter {
  return new TelegramAdapter(
    {
      token: 'fake-token-not-used',
      enabled: true,
      defaultDirectory: '/tmp',
    },
    events,
  );
}

const unknownConnectionId = generateId();

/** Minimal grammY bot/api stub with a sendMessage spy. */
interface SendMessageSpy {
  (chatId: number, text: string, opts?: unknown): Promise<{ message_id: number }>;
  mock: { calls: unknown[][] };
}

/**
 * Register a session on the adapter with a stubbed bot so render cases that
 * call `bot.api.sendMessage` can be observed. Reaches into private fields the
 * same way the production code populates them in handleStart().
 */
function withBoundSession(events: Partial<AdapterEvents> = {}): {
  adapter: TelegramAdapter;
  connectionId: UUID;
  sendMessage: SendMessageSpy;
} {
  const adapter = createAdapter(events);
  const sendMessage = mock(async () => ({ message_id: 1 })) as unknown as SendMessageSpy;

  const internal = adapter as unknown as {
    bot: { api: { sendMessage: SendMessageSpy } };
    sessions: Map<string, Record<string, unknown>>;
    connectionToSession: Map<UUID, string>;
  };

  internal.bot = { api: { sendMessage } };

  const connectionId = generateId();
  const chatId = 100;
  const topicId = 200;
  const sessionKey = `${chatId}:${topicId}`;

  internal.sessions.set(sessionKey, {
    connectionId,
    sessionId: generateId(),
    chatId,
    topicId,
    workingDirectory: '/tmp',
    machineName: 'test-machine',
    topicName: 'test-topic',
    sessionNumber: 1,
    startedAt: now(),
    currentMessageId: undefined,
    streamBuffer: '',
    lastSentContent: '',
    paused: false,
  });
  internal.connectionToSession.set(connectionId, sessionKey);

  return { adapter, connectionId, sendMessage };
}

describe('TelegramAdapter constructor defaults', () => {
  test('connectionCount is 0 before any sessions', () => {
    const adapter = createAdapter();
    expect(adapter.connectionCount).toBe(0);
  });

  test('isRunning is false before start', () => {
    const adapter = createAdapter();
    expect(adapter.isRunning).toBe(false);
  });

  test('type is telegram', () => {
    const adapter = createAdapter();
    expect(adapter.type).toBe('telegram');
  });
});

describe('sendMessage with unknown connection', () => {
  test('returns false for unknown connectionId', () => {
    const adapter = createAdapter();
    const result = adapter.sendMessage(unknownConnectionId, {
      id: generateId(),
      sessionId: generateId(),
      sender: 'agent',
      content: 'hello',
      createdAt: now(),
      state: 'delivered',
      stateChangedAt: now(),
      isEditing: false,
    });
    expect(result).toBe(false);
  });
});

describe('sendQuestion with unknown connection', () => {
  test('returns false for unknown connectionId', () => {
    const adapter = createAdapter();
    const result = adapter.sendQuestion(
      unknownConnectionId,
      {
        id: generateId(),
        text: 'Allow?',
        options: [],
        allowsFreeText: false,
        isAnswered: false,
      },
      generateId(),
    );
    expect(result).toBe(false);
  });
});

describe('sendStatus with unknown connection', () => {
  test('returns false for unknown connectionId', () => {
    const adapter = createAdapter();
    const result = adapter.sendStatus(unknownConnectionId, 'thinking');
    expect(result).toBe(false);
  });
});

describe('sendRaw routing', () => {
  test('agent_output returns false for unknown connection', () => {
    const adapter = createAdapter();
    const msg: AgentOutputMessage = {
      type: 'agent_output',
      id: generateId(),
      timestamp: now(),
      message: {
        id: generateId(),
        sessionId: generateId(),
        sender: 'agent',
        content: 'output',
        createdAt: now(),
        state: 'delivered',
        stateChangedAt: now(),
        isEditing: false,
      },
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(false);
  });

  test('structured_agent_output returns false for unknown connection', () => {
    const adapter = createAdapter();
    const msg: StructuredAgentOutputMessage = {
      type: 'structured_agent_output',
      id: generateId(),
      timestamp: now(),
      message: {
        id: generateId(),
        sessionId: generateId(),
        sender: 'agent',
        content: 'structured output',
        createdAt: now(),
        state: 'delivered',
        stateChangedAt: now(),
        isEditing: false,
        bullets: [],
      },
      isUpdate: false,
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(false);
  });

  test('question returns false for unknown connection', () => {
    const adapter = createAdapter();
    const msg: QuestionMessage = {
      type: 'question',
      id: generateId(),
      timestamp: now(),
      sessionId: generateId(),
      question: {
        id: generateId(),
        text: 'Allow?',
        options: [],
        allowsFreeText: false,
        isAnswered: false,
      },
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(false);
  });

  test('session_update returns false for unknown connection', () => {
    const adapter = createAdapter();
    const msg: SessionUpdateMessage = {
      type: 'session_update',
      id: generateId(),
      timestamp: now(),
      session: {
        id: generateId(),
        name: 'test-session',
        startedAt: now(),
        status: 'thinking',
        isActive: true,
      },
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(false);
  });

  test('hello_ack returns true (no-op for unknown session)', () => {
    const adapter = createAdapter();
    const msg: HelloAckMessage = {
      type: 'hello_ack',
      id: generateId(),
      timestamp: now(),
      sessionId: generateId(),
      serverVersion: '1.0',
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('transcript_content returns true for user role (skipped)', () => {
    const adapter = createAdapter();
    const msg: TranscriptContentMessage = {
      type: 'transcript_content',
      id: generateId(),
      timestamp: now(),
      sessionId: generateId(),
      entryUuid: 'entry-1',
      role: 'user',
      content: 'user said something',
      message: {
        id: generateId(),
        sessionId: generateId(),
        sender: 'agent',
        content: 'user said something',
        createdAt: now(),
        state: 'delivered',
        stateChangedAt: now(),
        isEditing: false,
        bullets: [],
      },
      isUpdate: false,
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('transcript_content for assistant returns false for unknown connection', () => {
    const adapter = createAdapter();
    const msg: TranscriptContentMessage = {
      type: 'transcript_content',
      id: generateId(),
      timestamp: now(),
      sessionId: generateId(),
      entryUuid: 'entry-1',
      role: 'assistant',
      content: 'assistant response',
      message: {
        id: generateId(),
        sessionId: generateId(),
        sender: 'agent',
        content: 'assistant response',
        createdAt: now(),
        state: 'delivered',
        stateChangedAt: now(),
        isEditing: false,
        bullets: [],
      },
      isUpdate: false,
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(false);
  });

  test('error returns true (attempts to send but no session)', () => {
    const adapter = createAdapter();
    const msg: ErrorMessage = {
      type: 'error',
      id: generateId(),
      timestamp: now(),
      message: 'something went wrong',
      code: 'UNKNOWN',
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('replay_batch processes inner messages', () => {
    const adapter = createAdapter();
    const inner: ErrorMessage = {
      type: 'error',
      id: generateId(),
      timestamp: now(),
      message: 'inner error',
      code: 'UNKNOWN',
    };
    const msg: ReplayBatchMessage = {
      type: 'replay_batch',
      id: generateId(),
      timestamp: now(),
      sessionId: generateId(),
      messages: [inner],
      isComplete: true,
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('session_list_response returns true', () => {
    const adapter = createAdapter();
    const msg: SessionListResponseMessage = {
      type: 'session_list_response',
      id: generateId(),
      timestamp: now(),
      sessions: [],
      requestId: generateId(),
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('transcript_load_complete returns true', () => {
    const adapter = createAdapter();
    const msg: TranscriptLoadCompleteMessage = {
      type: 'transcript_load_complete',
      id: generateId(),
      timestamp: now(),
      sessionId: 'sess-123',
      messageCount: 10,
      requestId: generateId(),
    };
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('ping returns true', () => {
    const adapter = createAdapter();
    const msg = { type: 'ping', id: generateId(), timestamp: now() } as ProtocolMessage;
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('pong returns true', () => {
    const adapter = createAdapter();
    const msg = { type: 'pong', id: generateId(), timestamp: now() } as ProtocolMessage;
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('unknown type returns false and emits a warn', () => {
    const adapter = createAdapter();
    const msg = {
      type: 'totally_unknown_type',
      id: generateId(),
      timestamp: now(),
    } as unknown as ProtocolMessage;

    const originalWarn = console.warn;
    const warnSpy = mock((..._args: unknown[]) => {});
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(false);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnSpy.mock.calls.length).toBe(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('totally_unknown_type');
  });

  test('detach_session_ack returns true (no-op, was false before)', () => {
    const adapter = createAdapter();
    const msg = {
      type: 'detach_session_ack',
      id: generateId(),
      timestamp: now(),
      sessionId: generateId(),
      success: true,
    } as unknown as ProtocolMessage;
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('raw_pty_output returns true (no-op, was false before)', () => {
    const adapter = createAdapter();
    const msg = {
      type: 'raw_pty_output',
      id: generateId(),
      timestamp: now(),
      sessionId: generateId(),
      data: 'YmFzZTY0',
    } as unknown as ProtocolMessage;
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('auth_challenge returns true (no-op, was false before)', () => {
    const adapter = createAdapter();
    const msg = {
      type: 'auth_challenge',
      id: generateId(),
      timestamp: now(),
      challenge: 'abc',
      serverFingerprint: 'fp',
      serverPublicKey: 'pk',
    } as unknown as ProtocolMessage;
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });

  test('auth_result returns true (no-op, was false before)', () => {
    const adapter = createAdapter();
    const msg = {
      type: 'auth_result',
      id: generateId(),
      timestamp: now(),
      success: true,
    } as unknown as ProtocolMessage;
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(true);
  });
});

describe('sendRaw render cases with a bound session', () => {
  test('kill_session_response (success) sends a "Session stopped" line', () => {
    const { adapter, connectionId, sendMessage } = withBoundSession();
    const msg: KillSessionResponseMessage = {
      type: 'kill_session_response',
      id: generateId(),
      timestamp: now(),
      success: true,
      requestId: generateId(),
    };
    expect(adapter.sendRaw(connectionId, msg)).toBe(true);
    expect(sendMessage.mock.calls.length).toBe(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain('Session stopped');
  });

  test('resume_session_response (success) sends a "Resumed session" line with the id', () => {
    const { adapter, connectionId, sendMessage } = withBoundSession();
    const resumedId = generateId();
    const msg: ResumeSessionResponseMessage = {
      type: 'resume_session_response',
      id: generateId(),
      timestamp: now(),
      success: true,
      sessionId: resumedId,
      requestId: generateId(),
    };
    expect(adapter.sendRaw(connectionId, msg)).toBe(true);
    expect(sendMessage.mock.calls.length).toBe(1);
    const text = String(sendMessage.mock.calls[0]?.[1]);
    expect(text).toContain('Resumed session');
    expect(text).toContain(resumedId);
  });

  test('session_rotated sends a "Session restarted" line with the new claude id', () => {
    const { adapter, connectionId, sendMessage } = withBoundSession();
    const newClaudeId = generateId();
    const msg: SessionRotatedMessage = {
      type: 'session_rotated',
      id: generateId(),
      timestamp: now(),
      sessionId: generateId(),
      newClaudeSessionId: newClaudeId,
      newTranscriptPath: '/tmp/new.jsonl',
      reason: 'clear',
    };
    expect(adapter.sendRaw(connectionId, msg)).toBe(true);
    expect(sendMessage.mock.calls.length).toBe(1);
    const text = String(sendMessage.mock.calls[0]?.[1]);
    expect(text).toContain('Session restarted');
    expect(text).toContain(newClaudeId);
  });

  test('daemon_update_available sends a line with the new version', () => {
    const { adapter, connectionId, sendMessage } = withBoundSession();
    const msg: DaemonUpdateAvailableMessage = {
      type: 'daemon_update_available',
      id: generateId(),
      timestamp: now(),
      currentVersion: '0.9.9',
      binaryPath: '/opt/homebrew/bin/remi',
    };
    expect(adapter.sendRaw(connectionId, msg)).toBe(true);
    expect(sendMessage.mock.calls.length).toBe(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain('0.9.9');
  });

  test('session_history_response sends a best-effort summary line', () => {
    const { adapter, connectionId, sendMessage } = withBoundSession();
    const msg: SessionHistoryResponseMessage = {
      type: 'session_history_response',
      id: generateId(),
      timestamp: now(),
      directories: [
        { directory: '/a', lastUsed: now(), sessionCount: 2, displayName: 'a' },
        { directory: '/b', lastUsed: now(), sessionCount: 1, displayName: 'b' },
      ],
      requestId: generateId(),
    };
    expect(adapter.sendRaw(connectionId, msg)).toBe(true);
    expect(sendMessage.mock.calls.length).toBe(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain('2');
  });
});

describe('broadcast', () => {
  test('does not throw with no sessions', () => {
    const adapter = createAdapter();
    const msg: ErrorMessage = {
      type: 'error',
      id: generateId(),
      timestamp: now(),
      message: 'test',
      code: 'UNKNOWN',
    };
    expect(() => adapter.broadcast(msg)).not.toThrow();
  });
});

describe('hasConnection', () => {
  test('returns false for unknown connectionId', () => {
    const adapter = createAdapter();
    expect(adapter.hasConnection(unknownConnectionId)).toBe(false);
  });
});

/**
 * #1140: `/interrupt` sends its Escape raw and reports the daemon's verdict.
 * The daemon here is a controllable double (an `onUserInput` that stays pending
 * until released), because the cases are about CONCURRENT requests on one
 * topic; the real handlers' behavior is covered in
 * `cli/handlers/chat-into-menu.test.ts`. The adapter, its `error` rendering and
 * the request bookkeeping are the real ones.
 */
describe('TelegramAdapter /interrupt outcome (#1140)', () => {
  interface Request {
    readonly content: string;
    readonly raw: boolean | undefined;
    readonly messageId: UUID | undefined;
    release: () => void;
  }

  function interruptRig() {
    const requests: Request[] = [];
    const events: Partial<AdapterEvents> = {
      onUserInput: (_connectionId, _sessionId, content, raw, _claudeSessionId, messageId) =>
        new Promise<void>((resolve) => {
          requests.push({ content, raw, messageId, release: resolve });
        }),
    };
    const { adapter, connectionId, sendMessage } = withBoundSession(events);
    const replies: string[] = [];
    const interrupt = () =>
      (adapter as unknown as { handleInterrupt: (ctx: unknown) => Promise<void> }).handleInterrupt({
        chat: { id: 100 },
        message: { message_thread_id: 200 },
        reply: async (text: string) => {
          replies.push(text);
        },
      });
    const chat = () => sendMessage.mock.calls.map((c) => c[1] as string);
    return { adapter, connectionId, requests, replies, interrupt, chat };
  }

  test('sends the Escape raw, with a distinct message id per request', async () => {
    const { requests, interrupt } = interruptRig();

    const first = interrupt();
    const second = interrupt();

    expect(requests.map((r) => [r.content, r.raw])).toEqual([
      ['\x1b', true],
      ['\x1b', true],
    ]);
    expect(typeof requests[0]?.messageId).toBe('string');
    expect(requests[0]?.messageId).not.toBe(requests[1]?.messageId);
    for (const r of requests) r.release();
    await Promise.all([first, second]);
  });

  test('a clean outcome replies "Interrupt sent"', async () => {
    const { requests, replies, interrupt } = interruptRig();

    const pending = interrupt();
    requests[0]?.release();
    await pending;

    expect(replies).toEqual(['⏹️ Interrupt sent to Claude (Escape key)']);
  });

  test("an error naming the first request refuses only it, even when the second finishes first (neither clobbers the other's entry)", async () => {
    const { adapter, connectionId, requests, replies, interrupt, chat } = interruptRig();
    const first = interrupt();
    const second = interrupt();
    const [a, b] = requests;
    if (!a || !b) throw new Error('both requests should be pending');

    // The daemon refuses the first request and names it.
    adapter.sendRaw(
      connectionId,
      createError('SESSION_NOT_FOUND', 'boom', { messageId: a.messageId }),
    );
    // The second finishes (and removes its own entry) before the first settles.
    b.release();
    await second;
    a.release();
    await first;

    expect(chat()).toEqual(['Error: boom']);
    // Only the second claims success.
    expect(replies).toEqual(['⏹️ Interrupt sent to Claude (Escape key)']);
  });

  test("the first request is still refused by an error that arrives after the second settled (the second's cleanup does not remove it)", async () => {
    const { adapter, connectionId, requests, replies, interrupt, chat } = interruptRig();
    const first = interrupt();
    const second = interrupt();
    const [a, b] = requests;
    if (!a || !b) throw new Error('both requests should be pending');

    b.release();
    await second;
    adapter.sendRaw(
      connectionId,
      createError('SESSION_NOT_FOUND', 'late', { messageId: a.messageId }),
    );
    a.release();
    await first;

    expect(chat()).toEqual(['Error: late']);
    expect(replies).toEqual(['⏹️ Interrupt sent to Claude (Escape key)']);
  });

  test('an error naming the second request does not refuse the first', async () => {
    const { adapter, connectionId, requests, replies, interrupt } = interruptRig();
    const first = interrupt();
    const second = interrupt();
    const [a, b] = requests;
    if (!a || !b) throw new Error('both requests should be pending');

    adapter.sendRaw(
      connectionId,
      createError('SESSION_NOT_FOUND', 'boom', { messageId: b.messageId }),
    );
    a.release();
    b.release();
    await Promise.all([first, second]);

    expect(replies).toEqual(['⏹️ Interrupt sent to Claude (Escape key)']);
  });

  test('an error that names no message refuses every request in flight on the connection', async () => {
    const { adapter, connectionId, requests, replies, interrupt } = interruptRig();
    const first = interrupt();
    const second = interrupt();

    adapter.sendRaw(connectionId, createError('STALE_BINDING', 'rotated'));
    for (const r of requests) r.release();
    await Promise.all([first, second]);

    expect(replies).toEqual([]);
  });

  test('an error for another connection does not refuse', async () => {
    const { adapter, requests, replies, interrupt } = interruptRig();
    const pending = interrupt();

    adapter.sendRaw(generateId(), createError('SESSION_NOT_FOUND', 'elsewhere'));
    requests[0]?.release();
    await pending;

    expect(replies).toEqual(['⏹️ Interrupt sent to Claude (Escape key)']);
  });

  test('the request is forgotten once it settles: a later error refuses nothing', async () => {
    const { adapter, connectionId, requests, replies, interrupt } = interruptRig();
    const pending = interrupt();
    requests[0]?.release();
    await pending;

    adapter.sendRaw(connectionId, createError('STALE_BINDING', 'late'));
    const next = interrupt();
    requests[1]?.release();
    await next;

    expect(replies).toEqual([
      '⏹️ Interrupt sent to Claude (Escape key)',
      '⏹️ Interrupt sent to Claude (Escape key)',
    ]);
  });
});

/**
 * #1127 review S2: an answer button reports the daemon's verdict. The daemon
 * is a controllable double (an `onAnswer` that stays pending until released,
 * optionally sending an `error` first, as the real handler does for a refusal);
 * the real handlers are covered in `cli/session-phases/structured-answers-e2e`.
 * The adapter, its `error` rendering and the tap bookkeeping are the real ones.
 */
describe('TelegramAdapter answer button outcome (#1127)', () => {
  function answerRig() {
    const taps: Array<{ questionId: UUID; answer: string; release: () => void }> = [];
    const events: Partial<AdapterEvents> = {
      onAnswer: (_connectionId, _sessionId, questionId, answer) =>
        new Promise<void>((resolve) => {
          taps.push({ questionId, answer, release: resolve });
        }),
    };
    const { adapter, connectionId, sendMessage } = withBoundSession(events);
    const acks: string[] = [];
    const markupEdits: number[] = [];
    const tap = (questionId: string, value: string) =>
      (
        adapter as unknown as { handleAnswerCallback: (ctx: unknown) => Promise<void> }
      ).handleAnswerCallback({
        match: ['', questionId, value],
        chat: { id: 100 },
        callbackQuery: { message: { message_thread_id: 200 } },
        answerCallbackQuery: async (text: string) => {
          acks.push(text);
        },
        editMessageReplyMarkup: async () => {
          markupEdits.push(1);
        },
      });
    const chat = () => sendMessage.mock.calls.map((c) => c[1] as string);
    return { adapter, connectionId, taps, acks, markupEdits, tap, chat };
  }

  test('an applied answer replies "Sent!" and removes the buttons', async () => {
    const { taps, acks, markupEdits, tap } = answerRig();
    const pending = tap('q-1', '2');
    expect(taps.map((t) => [t.questionId, t.answer])).toEqual([['q-1', '2']]);
    taps[0]?.release();
    await pending;
    expect(acks).toEqual(['Sent!']);
    expect(markupEdits).toHaveLength(1);
  });

  test('a refused answer does not claim success and keeps the buttons', async () => {
    const { adapter, connectionId, taps, acks, markupEdits, tap, chat } = answerRig();
    const pending = tap('q-1', '1');
    // The daemon refuses it (a held card's refusal names no question).
    adapter.sendRaw(
      connectionId,
      createError('STALE_ANSWER', 'This prompt takes one of its own options', {}),
    );
    taps[0]?.release();
    await pending;
    expect(chat()).toEqual(['Error: This prompt takes one of its own options']);
    expect(acks).toEqual(['Not applied (see the message)']);
    expect(markupEdits).toHaveLength(0);
  });

  test('an error naming another question does not refuse this tap', async () => {
    const { adapter, connectionId, taps, acks, tap } = answerRig();
    const pending = tap('q-1', '1');
    adapter.sendRaw(connectionId, createError('STALE_ANSWER', 'gone', { questionId: 'q-2' }));
    taps[0]?.release();
    await pending;
    expect(acks).toEqual(['Sent!']);
  });
});
