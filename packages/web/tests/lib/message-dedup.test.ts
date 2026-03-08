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
    expect(result).toEqual({ action: 'replace', replaceIndex: 0 });
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
    expect(result).toEqual({ action: 'replace', replaceIndex: 1 });
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
});
