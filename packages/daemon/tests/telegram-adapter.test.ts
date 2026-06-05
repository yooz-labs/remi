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
import { generateId, now } from '@remi/shared';
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
