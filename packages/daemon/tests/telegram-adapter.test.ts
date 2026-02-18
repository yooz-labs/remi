/**
 * Tests for TelegramAdapter class.
 *
 * These tests create adapter instances without starting the bot
 * (no TELEGRAM_BOT_TOKEN needed). They test method behavior on
 * the adapter object directly.
 */

import { describe, expect, test } from 'bun:test';
import type {
  AgentOutputMessage,
  ErrorMessage,
  HelloAckMessage,
  ProtocolMessage,
  QuestionMessage,
  ReplayBatchMessage,
  SessionListResponseMessage,
  SessionUpdateMessage,
  StructuredAgentOutputMessage,
  TranscriptContentMessage,
  TranscriptLoadCompleteMessage,
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
    const result = adapter.sendQuestion(unknownConnectionId, {
      id: generateId(),
      text: 'Allow?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
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

  test('unknown type returns false', () => {
    const adapter = createAdapter();
    const msg = {
      type: 'totally_unknown_type',
      id: generateId(),
      timestamp: now(),
    } as unknown as ProtocolMessage;
    expect(adapter.sendRaw(unknownConnectionId, msg)).toBe(false);
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
