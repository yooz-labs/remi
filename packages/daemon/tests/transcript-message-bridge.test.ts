/**
 * Tests for TranscriptMessageBridge.
 */

import { describe, expect, test } from 'bun:test';
import type { TranscriptContentMessage } from '@remi/shared';
import { generateId } from '@remi/shared';
import { MessageAPI } from '../src/api/message-api.ts';
import { TranscriptMessageBridge } from '../src/transcript/transcript-message-bridge.ts';
import type { AssistantEntry, UserEntry } from '../src/transcript/types.ts';

function createBridge(sessionId?: string) {
  const sid = sessionId ?? generateId();
  const messageApi = new MessageAPI({ sessionId: sid });
  const transcriptMessages: TranscriptContentMessage[] = [];

  const bridge = new TranscriptMessageBridge({ sessionId: sid }, messageApi, {
    onTranscriptContent: (msg) => transcriptMessages.push(msg),
  });

  return { bridge, messageApi, transcriptMessages, sessionId: sid };
}

function makeAssistantEntry(overrides?: Partial<AssistantEntry>): AssistantEntry {
  return {
    uuid: overrides?.uuid ?? generateId(),
    parentUuid: null,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    type: 'assistant',
    message: {
      role: 'assistant',
      content: overrides?.message?.content ?? [{ type: 'text', text: 'Hello from assistant' }],
      model: overrides?.message?.model ?? 'claude-opus-4-5-20251101',
      usage: overrides?.message?.usage ?? { input_tokens: 10, output_tokens: 20 },
    },
    ...overrides,
  };
}

function makeUserEntry(overrides?: Partial<UserEntry>): UserEntry {
  return {
    uuid: overrides?.uuid ?? generateId(),
    parentUuid: null,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    type: 'user',
    message: {
      role: 'user',
      content: overrides?.message?.content ?? 'Hello from user',
    },
    ...overrides,
  };
}

describe('TranscriptMessageBridge', () => {
  test('constructs with config and message API', () => {
    const { bridge } = createBridge();
    expect(bridge.processedCount).toBe(0);
  });

  describe('handleAssistantEntry()', () => {
    test('processes text content and emits transcript message', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry();

      bridge.handleAssistantEntry(entry);

      expect(transcriptMessages.length).toBe(1);
      expect(transcriptMessages[0]?.role).toBe('assistant');
      expect(transcriptMessages[0]?.content).toBe('Hello from assistant');
      expect(transcriptMessages[0]?.entryUuid).toBe(entry.uuid);
    });

    test('includes model info in message', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'test' }],
          model: 'claude-opus-4-5-20251101',
        },
      });

      bridge.handleAssistantEntry(entry);

      expect(transcriptMessages[0]?.model).toBe('claude-opus-4-5-20251101');
    });

    test('includes usage info in message', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'test' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });

      bridge.handleAssistantEntry(entry);

      expect(transcriptMessages[0]?.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    test('extracts tool names from content blocks', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'test.ts' } },
            { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      });

      bridge.handleAssistantEntry(entry);

      expect(transcriptMessages[0]?.tools).toEqual(['Read', 'Bash']);
    });

    test('detects thinking blocks', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Here is my answer.' },
          ],
        },
      });

      bridge.handleAssistantEntry(entry);

      expect(transcriptMessages[0]?.hadThinking).toBe(true);
    });

    test('skips entries with no text content and no tools', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Just thinking...' }],
        },
      });

      bridge.handleAssistantEntry(entry);

      expect(transcriptMessages.length).toBe(0);
      expect(bridge.processedCount).toBe(1); // Still marked as processed
    });

    test('deduplicates entries by UUID', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry();

      bridge.handleAssistantEntry(entry);
      bridge.handleAssistantEntry(entry); // Same UUID again

      expect(transcriptMessages.length).toBe(1);
      expect(bridge.processedCount).toBe(1);
    });

    test('processes multiple different entries', () => {
      const { bridge, transcriptMessages } = createBridge();

      bridge.handleAssistantEntry(makeAssistantEntry());
      bridge.handleAssistantEntry(makeAssistantEntry());
      bridge.handleAssistantEntry(makeAssistantEntry());

      expect(transcriptMessages.length).toBe(3);
      expect(bridge.processedCount).toBe(3);
    });

    test('joins multiple text blocks with newlines', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'First paragraph.' },
            { type: 'text', text: 'Second paragraph.' },
          ],
        },
      });

      bridge.handleAssistantEntry(entry);

      expect(transcriptMessages[0]?.content).toBe('First paragraph.\nSecond paragraph.');
    });

    test('filters out thinking and tool_result blocks from text content', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden thinking' },
            { type: 'text', text: 'Visible content' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
          ],
        },
      });

      bridge.handleAssistantEntry(entry);

      expect(transcriptMessages[0]?.content).toBe('Visible content');
    });

    test('includes structured message', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Here is some multi-line content.\nWith a second line.' },
          ],
        },
      });

      bridge.handleAssistantEntry(entry);

      expect(transcriptMessages[0]?.message).toBeDefined();
      expect(transcriptMessages[0]?.message.id).toBeDefined();
      expect(transcriptMessages[0]?.message.sender).toBe('agent');
    });
  });

  describe('handleUserEntry()', () => {
    test('processes string content', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeUserEntry();

      bridge.handleUserEntry(entry);

      expect(transcriptMessages.length).toBe(1);
      expect(transcriptMessages[0]?.role).toBe('user');
      expect(transcriptMessages[0]?.content).toBe('Hello from user');
    });

    test('processes content block array', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeUserEntry({
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'User message with blocks' }],
        },
      });

      bridge.handleUserEntry(entry);

      expect(transcriptMessages[0]?.content).toBe('User message with blocks');
    });

    test('deduplicates user entries by UUID', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeUserEntry();

      bridge.handleUserEntry(entry);
      bridge.handleUserEntry(entry); // Same UUID

      expect(transcriptMessages.length).toBe(1);
    });

    test('processes multiple user entries', () => {
      const { bridge, transcriptMessages } = createBridge();

      bridge.handleUserEntry(makeUserEntry());
      bridge.handleUserEntry(makeUserEntry());

      expect(transcriptMessages.length).toBe(2);
      expect(bridge.processedCount).toBe(2);
    });

    test('does not include tools or model for user entries', () => {
      const { bridge, transcriptMessages } = createBridge();
      bridge.handleUserEntry(makeUserEntry());

      expect(transcriptMessages[0]?.tools).toBeUndefined();
      expect(transcriptMessages[0]?.model).toBeUndefined();
    });
  });

  describe('processedCount', () => {
    test('starts at zero', () => {
      const { bridge } = createBridge();
      expect(bridge.processedCount).toBe(0);
    });

    test('increments for each unique entry', () => {
      const { bridge } = createBridge();
      bridge.handleAssistantEntry(makeAssistantEntry());
      expect(bridge.processedCount).toBe(1);

      bridge.handleUserEntry(makeUserEntry());
      expect(bridge.processedCount).toBe(2);
    });

    test('does not increment for duplicates', () => {
      const { bridge } = createBridge();
      const entry = makeAssistantEntry();

      bridge.handleAssistantEntry(entry);
      bridge.handleAssistantEntry(entry);

      expect(bridge.processedCount).toBe(1);
    });
  });

  describe('reset()', () => {
    test('clears processed entries', () => {
      const { bridge, transcriptMessages } = createBridge();
      const entry = makeAssistantEntry();

      bridge.handleAssistantEntry(entry);
      expect(bridge.processedCount).toBe(1);

      bridge.reset();
      expect(bridge.processedCount).toBe(0);

      // Can re-process the same entry after reset
      bridge.handleAssistantEntry(entry);
      expect(bridge.processedCount).toBe(1);
      expect(transcriptMessages.length).toBe(2);
    });
  });

  describe('session boundary detection', () => {
    test('accepts entries from a single session', () => {
      const { bridge, transcriptMessages } = createBridge();
      bridge.handleAssistantEntry(makeAssistantEntry({ sessionId: 'session-A' }));
      bridge.handleUserEntry(makeUserEntry({ sessionId: 'session-A' }));
      bridge.handleAssistantEntry(
        makeAssistantEntry({ sessionId: 'session-A', uuid: generateId() }),
      );

      expect(transcriptMessages.length).toBe(3);
    });

    test('switches to new session when sessionId changes (prefers latest)', () => {
      const { bridge, transcriptMessages } = createBridge();
      // First entry establishes session A
      bridge.handleAssistantEntry(makeAssistantEntry({ sessionId: 'session-A' }));
      expect(transcriptMessages.length).toBe(1);

      // Entry from session B is accepted (switch to latest session)
      bridge.handleAssistantEntry(
        makeAssistantEntry({ sessionId: 'session-B', uuid: generateId() }),
      );
      expect(transcriptMessages.length).toBe(2);
    });

    test('entries without sessionId pass through regardless', () => {
      const { bridge, transcriptMessages } = createBridge();
      bridge.handleAssistantEntry(makeAssistantEntry({ sessionId: 'session-A' }));

      // Entry with no sessionId passes through
      const noSessionEntry = makeAssistantEntry({ uuid: generateId() });
      // Remove sessionId by creating entry without it
      const entryWithoutSession = { ...noSessionEntry, sessionId: undefined as unknown as string };
      bridge.handleAssistantEntry(entryWithoutSession);
      expect(transcriptMessages.length).toBe(2);
    });

    test('user entries switch to new session (prefers latest)', () => {
      const { bridge, transcriptMessages } = createBridge();
      bridge.handleUserEntry(makeUserEntry({ sessionId: 'session-A' }));
      expect(transcriptMessages.length).toBe(1);

      bridge.handleUserEntry(makeUserEntry({ sessionId: 'session-B', uuid: generateId() }));
      expect(transcriptMessages.length).toBe(2); // accepted, switched to B
    });

    test('reset clears session boundary state', () => {
      const { bridge, transcriptMessages } = createBridge();
      bridge.handleAssistantEntry(makeAssistantEntry({ sessionId: 'session-A' }));
      expect(transcriptMessages.length).toBe(1);

      bridge.reset();

      // After reset, entries from a new session are accepted
      bridge.handleAssistantEntry(
        makeAssistantEntry({ sessionId: 'session-B', uuid: generateId() }),
      );
      expect(transcriptMessages.length).toBe(2);
    });
  });

  describe('event handling', () => {
    test('works without event handlers', () => {
      const messageApi = new MessageAPI({ sessionId: generateId() });
      const bridge = new TranscriptMessageBridge(
        { sessionId: generateId() },
        messageApi,
        {}, // No event handlers
      );

      // Should not throw
      bridge.handleAssistantEntry(makeAssistantEntry());
      bridge.handleUserEntry(makeUserEntry());
      expect(bridge.processedCount).toBe(2);
    });
  });
});
