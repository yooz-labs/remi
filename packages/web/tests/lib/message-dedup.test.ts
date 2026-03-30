import { describe, expect, test } from 'bun:test';
import { deduplicateMessage, type IncomingMessage } from '../../src/lib/message-dedup';
import type { UIMessage } from '../../src/types';

function makeUIMessage(overrides: Partial<UIMessage> = {}): UIMessage {
  return {
    id: 'msg-1' as UIMessage['id'],
    sessionId: 'session-1' as UIMessage['sessionId'],
    sender: 'agent',
    content: 'Hello world',
    timestamp: '2024-01-01T00:00:00Z',
    state: 'delivered',
    isEditing: false,
    source: 'pty',
    ...overrides,
  };
}

describe('deduplicateMessage', () => {
  // --- Transcript arriving ---

  test('transcript arriving with no existing messages returns add', () => {
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      entryUuid: 'entry-1',
      source: 'transcript',
    };
    const result = deduplicateMessage([], incoming);
    expect(result).toEqual({ action: 'add' });
  });

  test('transcript arriving replaces PTY duplicate (no entryUuid, same content)', () => {
    const existing = [
      makeUIMessage({ entryUuid: undefined, source: 'pty' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      entryUuid: 'entry-1',
      source: 'transcript',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'replace', replaceIndex: 0, preserveId: 'msg-1' });
  });

  test('transcript arriving replaces optimistic duplicate and preserves its id', () => {
    const existing = [
      makeUIMessage({ id: 'optimistic-abc' as UIMessage['id'], sender: 'user', source: 'optimistic', entryUuid: undefined }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'user',
      content: 'Hello world',
      entryUuid: 'entry-1',
      source: 'transcript',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'replace', replaceIndex: 0, preserveId: 'optimistic-abc' });
  });

  test('transcript arriving does not replace message with different content', () => {
    const existing = [
      makeUIMessage({ content: 'Different content', entryUuid: undefined, source: 'pty' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      entryUuid: 'entry-1',
      source: 'transcript',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'add' });
  });

  test('transcript arriving does not replace message with different sessionId', () => {
    const existing = [
      makeUIMessage({ sessionId: 'session-2' as UIMessage['sessionId'], entryUuid: undefined, source: 'pty' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      entryUuid: 'entry-1',
      source: 'transcript',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'add' });
  });

  test('transcript arriving does not replace message that already has entryUuid', () => {
    const existing = [
      makeUIMessage({ entryUuid: 'existing-entry', source: 'transcript' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      entryUuid: 'entry-2',
      source: 'transcript',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'add' });
  });

  test('transcript replaces correct index among multiple messages', () => {
    const existing = [
      makeUIMessage({ id: 'msg-0' as UIMessage['id'], content: 'First', source: 'pty' }),
      makeUIMessage({ id: 'msg-1' as UIMessage['id'], content: 'Hello world', entryUuid: undefined, source: 'pty' }),
      makeUIMessage({ id: 'msg-2' as UIMessage['id'], content: 'Third', source: 'pty' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      entryUuid: 'entry-1',
      source: 'transcript',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'replace', replaceIndex: 1, preserveId: 'msg-1' });
  });

  test('sender mismatch prevents dedup', () => {
    const existing = [
      makeUIMessage({ sender: 'user', entryUuid: undefined, source: 'pty' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      entryUuid: 'entry-1',
      source: 'transcript',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'add' });
  });

  // --- PTY arriving ---

  test('PTY arriving skips when transcript duplicate exists', () => {
    const existing = [
      makeUIMessage({ entryUuid: 'entry-1', source: 'transcript' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      source: 'pty',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'skip' });
  });

  test('PTY arriving adds when no transcript duplicate exists', () => {
    const existing = [
      makeUIMessage({ content: 'Other message', entryUuid: 'entry-1', source: 'transcript' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      source: 'pty',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'add' });
  });

  test('PTY arriving adds when existing messages have no entryUuid', () => {
    const existing = [
      makeUIMessage({ entryUuid: undefined, source: 'pty' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'agent',
      content: 'Hello world',
      source: 'pty',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'add' });
  });

  test('PTY arriving skips when optimistic duplicate exists', () => {
    const existing = [
      makeUIMessage({ id: 'opt-1' as UIMessage['id'], sender: 'user', source: 'optimistic', entryUuid: undefined }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'user',
      content: 'Hello world',
      source: 'pty',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'skip' });
  });

  test('PTY arriving adds when optimistic message has different content', () => {
    const existing = [
      makeUIMessage({ sender: 'user', source: 'optimistic', content: 'Different text' }),
    ];
    const incoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'user',
      content: 'Hello world',
      source: 'pty',
    };
    const result = deduplicateMessage(existing, incoming);
    expect(result).toEqual({ action: 'add' });
  });

  // --- Full three-way lifecycle ---

  test('three-way lifecycle: optimistic -> PTY skip -> transcript replace preserves id', () => {
    // Step 1: optimistic message is already in the list
    const optimisticMsg = makeUIMessage({
      id: 'opt-xyz' as UIMessage['id'],
      sender: 'user',
      source: 'optimistic',
      entryUuid: undefined,
    });
    const messages = [optimisticMsg];

    // Step 2: PTY echo arrives and should be skipped
    const ptyIncoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'user',
      content: 'Hello world',
      source: 'pty',
    };
    const ptyResult = deduplicateMessage(messages, ptyIncoming);
    expect(ptyResult).toEqual({ action: 'skip' });

    // Step 3: transcript arrives and should replace the optimistic message,
    // preserving its id for stable React keys
    const transcriptIncoming: IncomingMessage = {
      sessionId: 'session-1',
      sender: 'user',
      content: 'Hello world',
      entryUuid: 'entry-abc',
      source: 'transcript',
    };
    const transcriptResult = deduplicateMessage(messages, transcriptIncoming);
    expect(transcriptResult).toEqual({
      action: 'replace',
      replaceIndex: 0,
      preserveId: 'opt-xyz',
    });
  });
});
