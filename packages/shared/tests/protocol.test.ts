/**
 * Tests for messaging protocol.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  generateId,
  now,
  serialize,
  deserialize,
  createHello,
  createHelloAck,
  createAgentOutput,
  createUserInput,
  createAck,
  createEdit,
  createPing,
  createPong,
  createError,
  MessageIdTracker,
} from '../src/protocol.ts';
import type {
  ProtocolMessage,
  HelloMessage,
  HelloAckMessage,
  AgentOutputMessage,
  UserInputMessage,
  AckMessage,
  EditMessage,
  PingMessage,
  PongMessage,
  ErrorMessage,
} from '../src/protocol.ts';
import type { Message, Acknowledgment } from '../src/types.ts';

describe('generateId()', () => {
  test('generates valid UUID v4 format', () => {
    const id = generateId();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidRegex);
  });

  test('generates unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(1000);
  });

  test('is cryptographically random', () => {
    // Generate many IDs and check for basic randomness
    const ids = Array.from({ length: 100 }, () => generateId());

    // All should be different
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(100);

    // Check that IDs don't have predictable patterns
    const firstChars = ids.map((id) => id[0]);
    const uniqueFirstChars = new Set(firstChars);
    // Should have variety in first character (statistically likely to have > 5 different)
    expect(uniqueFirstChars.size).toBeGreaterThan(5);
  });
});

describe('now()', () => {
  test('returns ISO 8601 timestamp', () => {
    const timestamp = now();
    // ISO 8601 format
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('returns current time', () => {
    const before = Date.now();
    const timestamp = now();
    const after = Date.now();

    const parsed = new Date(timestamp).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  test('timestamps are monotonically increasing', () => {
    const timestamps: string[] = [];
    for (let i = 0; i < 10; i++) {
      timestamps.push(now());
    }

    for (let i = 1; i < timestamps.length; i++) {
      const prev = timestamps[i - 1]!;
      const curr = timestamps[i]!;
      expect(prev <= curr).toBe(true);
    }
  });
});

describe('serialize()', () => {
  test('serializes hello message', () => {
    const msg = createHello('client-123', '1.0.0');
    const json = serialize(msg);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe('hello');
    expect(parsed.clientId).toBe('client-123');
    expect(parsed.clientVersion).toBe('1.0.0');
  });

  test('serializes ping message', () => {
    const msg = createPing();
    const json = serialize(msg);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe('ping');
    expect(typeof parsed.id).toBe('string');
    expect(typeof parsed.timestamp).toBe('string');
  });

  test('preserves all message fields', () => {
    const message: Message = {
      id: 'msg-123',
      sessionId: 'session-456',
      sender: 'agent',
      content: 'Hello, world!',
      createdAt: '2026-01-10T00:00:00.000Z',
      state: 'sent',
      stateChangedAt: '2026-01-10T00:00:01.000Z',
      isEditing: false,
      tool: 'Reading file',
    };
    const msg = createAgentOutput(message);
    const json = serialize(msg);
    const parsed = JSON.parse(json);

    expect(parsed.message.id).toBe('msg-123');
    expect(parsed.message.tool).toBe('Reading file');
  });

  test('handles special characters in content', () => {
    const message: Message = {
      id: 'msg-123',
      sessionId: 'session-456',
      sender: 'agent',
      content: 'Line1\nLine2\tTabbed\r\nWindows line',
      createdAt: '2026-01-10T00:00:00.000Z',
      state: 'sent',
      stateChangedAt: '2026-01-10T00:00:01.000Z',
      isEditing: false,
    };
    const msg = createAgentOutput(message);
    const json = serialize(msg);
    const parsed = JSON.parse(json);

    expect(parsed.message.content).toBe('Line1\nLine2\tTabbed\r\nWindows line');
  });

  test('handles unicode in content', () => {
    const message: Message = {
      id: 'msg-123',
      sessionId: 'session-456',
      sender: 'user',
      content: '你好世界 🌍 مرحبا',
      createdAt: '2026-01-10T00:00:00.000Z',
      state: 'sent',
      stateChangedAt: '2026-01-10T00:00:01.000Z',
      isEditing: false,
    };
    const msg = createAgentOutput(message);
    const json = serialize(msg);
    const parsed = JSON.parse(json);

    expect(parsed.message.content).toBe('你好世界 🌍 مرحبا');
  });
});

describe('deserialize()', () => {
  test('deserializes valid hello message', () => {
    const original = createHello('client-123', '1.0.0');
    const json = serialize(original);
    const parsed = deserialize(json);

    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('hello');
    expect((parsed as HelloMessage).clientId).toBe('client-123');
  });

  test('deserializes valid ping message', () => {
    const original = createPing();
    const json = serialize(original);
    const parsed = deserialize(json);

    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('ping');
  });

  test('returns null for invalid JSON', () => {
    const result = deserialize('not valid json');
    expect(result).toBeNull();
  });

  test('returns null for empty string', () => {
    const result = deserialize('');
    expect(result).toBeNull();
  });

  test('returns null for null value', () => {
    const result = deserialize('null');
    expect(result).toBeNull();
  });

  test('returns null for array', () => {
    const result = deserialize('[1, 2, 3]');
    expect(result).toBeNull();
  });

  test('returns null for missing type field', () => {
    const result = deserialize('{"id": "123", "timestamp": "2026-01-10T00:00:00.000Z"}');
    expect(result).toBeNull();
  });

  test('returns null for missing id field', () => {
    const result = deserialize('{"type": "ping", "timestamp": "2026-01-10T00:00:00.000Z"}');
    expect(result).toBeNull();
  });

  test('returns null for missing timestamp field', () => {
    const result = deserialize('{"type": "ping", "id": "123"}');
    expect(result).toBeNull();
  });

  test('returns null for invalid type', () => {
    const result = deserialize('{"type": "invalid_type", "id": "123", "timestamp": "2026-01-10T00:00:00.000Z"}');
    expect(result).toBeNull();
  });

  test('returns null for non-string type', () => {
    const result = deserialize('{"type": 123, "id": "123", "timestamp": "2026-01-10T00:00:00.000Z"}');
    expect(result).toBeNull();
  });

  test('deserializes all valid message types', () => {
    const validTypes = [
      'hello',
      'hello_ack',
      'agent_output',
      'user_input',
      'ack',
      'edit',
      'question',
      'answer',
      'session_update',
      'ping',
      'pong',
      'error',
    ] as const;

    for (const type of validTypes) {
      const json = JSON.stringify({
        type,
        id: generateId(),
        timestamp: now(),
      });
      const result = deserialize(json);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(type);
    }
  });

  test('roundtrip preserves message integrity', () => {
    const message: Message = {
      id: 'msg-123',
      sessionId: 'session-456',
      sender: 'agent',
      content: 'Test content with special chars: \n\t"quotes"',
      createdAt: '2026-01-10T00:00:00.000Z',
      state: 'delivered',
      stateChangedAt: '2026-01-10T00:00:01.000Z',
      isEditing: true,
      editedAt: '2026-01-10T00:00:02.000Z',
      tool: 'bash',
    };

    const original = createAgentOutput(message);
    const json = serialize(original);
    const parsed = deserialize(json) as AgentOutputMessage;

    expect(parsed.type).toBe('agent_output');
    expect(parsed.message.id).toBe(message.id);
    expect(parsed.message.content).toBe(message.content);
    expect(parsed.message.tool).toBe(message.tool);
    expect(parsed.message.isEditing).toBe(message.isEditing);
  });
});

describe('Message factory functions', () => {
  describe('createHello()', () => {
    test('creates hello message with required fields', () => {
      const msg = createHello('client-123', '1.0.0');

      expect(msg.type).toBe('hello');
      expect(msg.clientId).toBe('client-123');
      expect(msg.clientVersion).toBe('1.0.0');
      expect(typeof msg.id).toBe('string');
      expect(typeof msg.timestamp).toBe('string');
    });

    test('generates unique ID each time', () => {
      const msg1 = createHello('client-123', '1.0.0');
      const msg2 = createHello('client-123', '1.0.0');

      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  describe('createHelloAck()', () => {
    test('creates hello ack with required fields', () => {
      const msg = createHelloAck('1.0.0', 'session-456');

      expect(msg.type).toBe('hello_ack');
      expect(msg.serverVersion).toBe('1.0.0');
      expect(msg.sessionId).toBe('session-456');
    });
  });

  describe('createAgentOutput()', () => {
    test('creates agent output with message', () => {
      const message: Message = {
        id: 'msg-123',
        sessionId: 'session-456',
        sender: 'agent',
        content: 'Hello',
        createdAt: '2026-01-10T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-10T00:00:00.000Z',
        isEditing: false,
      };

      const msg = createAgentOutput(message);

      expect(msg.type).toBe('agent_output');
      expect(msg.message).toBe(message);
    });
  });

  describe('createUserInput()', () => {
    test('creates user input with content', () => {
      const msg = createUserInput('session-456', 'User message');

      expect(msg.type).toBe('user_input');
      expect(msg.sessionId).toBe('session-456');
      expect(msg.content).toBe('User message');
    });
  });

  describe('createAck()', () => {
    test('creates ack with acknowledgment', () => {
      const ack: Acknowledgment = {
        messageId: 'msg-123',
        state: 'delivered',
        timestamp: now(),
      };

      const msg = createAck(ack);

      expect(msg.type).toBe('ack');
      expect(msg.ack.messageId).toBe('msg-123');
      expect(msg.ack.state).toBe('delivered');
    });
  });

  describe('createEdit()', () => {
    test('creates edit message', () => {
      const msg = createEdit('msg-123', 'Updated content', true, 'bash');

      expect(msg.type).toBe('edit');
      expect(msg.messageId).toBe('msg-123');
      expect(msg.newContent).toBe('Updated content');
      expect(msg.isEditing).toBe(true);
      expect(msg.tool).toBe('bash');
    });

    test('tool is optional', () => {
      const msg = createEdit('msg-123', 'Updated content', false);

      expect(msg.tool).toBeUndefined();
    });
  });

  describe('createPing()', () => {
    test('creates ping message', () => {
      const msg = createPing();

      expect(msg.type).toBe('ping');
      expect(typeof msg.id).toBe('string');
    });
  });

  describe('createPong()', () => {
    test('creates pong message with ping ID', () => {
      const ping = createPing();
      const pong = createPong(ping.id);

      expect(pong.type).toBe('pong');
      expect(pong.pingId).toBe(ping.id);
    });
  });

  describe('createError()', () => {
    test('creates error message', () => {
      const msg = createError('E001', 'Something went wrong');

      expect(msg.type).toBe('error');
      expect(msg.code).toBe('E001');
      expect(msg.message).toBe('Something went wrong');
      expect(msg.details).toBeUndefined();
    });

    test('includes optional details', () => {
      const msg = createError('E002', 'Validation failed', {
        field: 'email',
        reason: 'invalid format',
      });

      expect(msg.details).toEqual({
        field: 'email',
        reason: 'invalid format',
      });
    });
  });
});

describe('MessageIdTracker', () => {
  let tracker: MessageIdTracker;

  beforeEach(() => {
    tracker = new MessageIdTracker(100);
  });

  describe('checkAndMark()', () => {
    test('returns false for new ID (not duplicate)', () => {
      const id = generateId();
      expect(tracker.checkAndMark(id)).toBe(false);
    });

    test('returns true for seen ID (duplicate)', () => {
      const id = generateId();
      tracker.checkAndMark(id);
      expect(tracker.checkAndMark(id)).toBe(true);
    });

    test('tracks multiple different IDs', () => {
      const id1 = generateId();
      const id2 = generateId();
      const id3 = generateId();

      expect(tracker.checkAndMark(id1)).toBe(false);
      expect(tracker.checkAndMark(id2)).toBe(false);
      expect(tracker.checkAndMark(id3)).toBe(false);

      expect(tracker.checkAndMark(id1)).toBe(true);
      expect(tracker.checkAndMark(id2)).toBe(true);
      expect(tracker.checkAndMark(id3)).toBe(true);
    });

    test('recognizes duplicates regardless of order', () => {
      const ids = [generateId(), generateId(), generateId()];

      // Mark all
      for (const id of ids) {
        tracker.checkAndMark(id);
      }

      // Check in reverse order
      for (const id of ids.reverse()) {
        expect(tracker.checkAndMark(id)).toBe(true);
      }
    });
  });

  describe('size', () => {
    test('starts at zero', () => {
      expect(tracker.size).toBe(0);
    });

    test('increases with unique IDs', () => {
      tracker.checkAndMark(generateId());
      expect(tracker.size).toBe(1);

      tracker.checkAndMark(generateId());
      expect(tracker.size).toBe(2);
    });

    test('does not increase for duplicates', () => {
      const id = generateId();
      tracker.checkAndMark(id);
      expect(tracker.size).toBe(1);

      tracker.checkAndMark(id);
      expect(tracker.size).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    test('evicts oldest when over capacity', () => {
      const smallTracker = new MessageIdTracker(5);
      const ids: string[] = [];

      // Add 5 IDs (at capacity)
      for (let i = 0; i < 5; i++) {
        const id = generateId();
        ids.push(id);
        smallTracker.checkAndMark(id);
      }

      expect(smallTracker.size).toBe(5);

      // Add one more, pushing oldest out
      const newId = generateId();
      smallTracker.checkAndMark(newId);

      // Size should still be 5 (capped)
      expect(smallTracker.size).toBe(5);

      // Oldest (ids[0]) should be evicted (no longer recognized as duplicate)
      // Note: checkAndMark will re-add it, so we can only check once
      expect(smallTracker.checkAndMark(ids[0]!)).toBe(false);

      // After re-adding ids[0], ids[1] should now be evicted
      // The newest ID is still tracked
      expect(smallTracker.checkAndMark(newId)).toBe(true);
    });

    test('uses default size of 1000', () => {
      const defaultTracker = new MessageIdTracker();

      // Add 1000 IDs
      for (let i = 0; i < 1000; i++) {
        defaultTracker.checkAndMark(generateId());
      }

      expect(defaultTracker.size).toBe(1000);

      // Add one more
      defaultTracker.checkAndMark(generateId());
      expect(defaultTracker.size).toBe(1000);
    });

    test('evicts in FIFO order', () => {
      const smallTracker = new MessageIdTracker(3);
      const id1 = generateId();
      const id2 = generateId();
      const id3 = generateId();

      smallTracker.checkAndMark(id1);
      smallTracker.checkAndMark(id2);
      smallTracker.checkAndMark(id3);

      expect(smallTracker.size).toBe(3);

      // Add one more - id1 (oldest) should be evicted
      const id4 = generateId();
      smallTracker.checkAndMark(id4);

      // id1 should be evicted (first in, first out)
      expect(smallTracker.checkAndMark(id1)).toBe(false);

      // id4 should still be tracked (was added before id1 was re-added)
      expect(smallTracker.checkAndMark(id4)).toBe(true);

      // Size should still be capped at 3
      expect(smallTracker.size).toBe(3);
    });
  });

  describe('clear()', () => {
    test('removes all tracked IDs', () => {
      const id1 = generateId();
      const id2 = generateId();

      tracker.checkAndMark(id1);
      tracker.checkAndMark(id2);
      expect(tracker.size).toBe(2);

      tracker.clear();

      expect(tracker.size).toBe(0);
      expect(tracker.checkAndMark(id1)).toBe(false);
      expect(tracker.checkAndMark(id2)).toBe(false);
    });

    test('can track IDs after clear', () => {
      const id = generateId();
      tracker.checkAndMark(id);
      tracker.clear();

      expect(tracker.checkAndMark(id)).toBe(false);
      expect(tracker.checkAndMark(id)).toBe(true);
    });
  });

  describe('stress test', () => {
    test('handles many IDs efficiently', () => {
      const largeTracker = new MessageIdTracker(10000);
      const start = performance.now();

      // Add 10000 IDs
      for (let i = 0; i < 10000; i++) {
        largeTracker.checkAndMark(generateId());
      }

      const duration = performance.now() - start;
      expect(largeTracker.size).toBe(10000);
      // Should complete in reasonable time (less than 1 second)
      expect(duration).toBeLessThan(1000);
    });

    test('duplicate checking is fast', () => {
      const largeTracker = new MessageIdTracker(10000);
      const ids: string[] = [];

      // Add 10000 IDs
      for (let i = 0; i < 10000; i++) {
        const id = generateId();
        ids.push(id);
        largeTracker.checkAndMark(id);
      }

      const start = performance.now();

      // Check all as duplicates
      for (const id of ids) {
        expect(largeTracker.checkAndMark(id)).toBe(true);
      }

      const duration = performance.now() - start;
      // Should complete in reasonable time
      expect(duration).toBeLessThan(1000);
    });
  });
});
