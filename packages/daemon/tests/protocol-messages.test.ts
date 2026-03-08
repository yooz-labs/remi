/**
 * Tests for protocol message factory functions and serialization.
 */

import { describe, expect, test } from 'bun:test';
import {
  type UUID,
  createCreateSessionRequest,
  createCreateSessionResponse,
  createHello,
  createHelloAck,
  createKillSessionRequest,
  createKillSessionResponse,
  createTerminalResize,
  deserialize,
  serialize,
} from '@remi/shared';

describe('Protocol factory functions', () => {
  describe('createHello', () => {
    test('creates basic hello without optional fields', () => {
      const msg = createHello('client-1' as UUID, '1.0.0');
      expect(msg.type).toBe('hello');
      expect(msg.clientId).toBe('client-1');
      expect(msg.clientVersion).toBe('1.0.0');
      expect(msg.directory).toBeUndefined();
      expect(msg.resumeSessionId).toBeUndefined();
      expect(msg.lastReceivedIndex).toBeUndefined();
    });

    test('includes directory when provided', () => {
      const msg = createHello('client-1' as UUID, '1.0.0', '/some/path');
      expect(msg.directory).toBe('/some/path');
    });

    test('includes empty string directory', () => {
      const msg = createHello('client-1' as UUID, '1.0.0', '');
      // Empty string is a valid directory (cwd)
      expect('directory' in msg).toBe(true);
    });

    test('includes resumeSessionId when provided', () => {
      const sessionId = 'abc-123' as UUID;
      const msg = createHello('client-1' as UUID, '1.0.0', undefined, sessionId);
      expect(msg.resumeSessionId).toBe(sessionId);
    });

    test('includes lastReceivedIndex when provided', () => {
      const msg = createHello('client-1' as UUID, '1.0.0', undefined, undefined, 42);
      expect(msg.lastReceivedIndex).toBe(42);
    });

    test('round-trips through serialize/deserialize', () => {
      const original = createHello('client-1' as UUID, '1.0.0', '/dir', 'sess-1' as UUID, 5);
      const serialized = serialize(original);
      const deserialized = deserialize(serialized);
      expect(deserialized).not.toBeNull();
      expect(deserialized?.type).toBe('hello');
      expect((deserialized as typeof original).clientId).toBe('client-1');
      expect((deserialized as typeof original).directory).toBe('/dir');
      expect((deserialized as typeof original).resumeSessionId).toBe('sess-1');
      expect((deserialized as typeof original).lastReceivedIndex).toBe(5);
    });
  });

  describe('createHelloAck', () => {
    test('creates basic hello_ack', () => {
      const msg = createHelloAck('1.0.0', 'session-1' as UUID);
      expect(msg.type).toBe('hello_ack');
      expect(msg.serverVersion).toBe('1.0.0');
      expect(msg.sessionId).toBe('session-1');
      expect(msg.isResume).toBeUndefined();
    });

    test('includes resume info', () => {
      const msg = createHelloAck('1.0.0', 'session-1' as UUID, {
        isResume: true,
        replayCount: 5,
        nextBulletId: 10,
      });
      expect(msg.isResume).toBe(true);
      expect(msg.replayCount).toBe(5);
      expect(msg.nextBulletId).toBe(10);
    });

    test('round-trips through serialize/deserialize', () => {
      const original = createHelloAck('1.0.0', 'session-1' as UUID, {
        isResume: true,
        replayCount: 3,
        nextBulletId: 7,
      });
      const deserialized = deserialize(serialize(original));
      expect(deserialized).not.toBeNull();
      expect((deserialized as typeof original).isResume).toBe(true);
      expect((deserialized as typeof original).replayCount).toBe(3);
    });
  });

  describe('createCreateSessionRequest', () => {
    test('creates request without directory', () => {
      const msg = createCreateSessionRequest();
      expect(msg.type).toBe('create_session_request');
      expect(msg.id).toBeTruthy();
      expect(msg.timestamp).toBeTruthy();
      expect(msg.directory).toBeUndefined();
    });

    test('creates request with directory', () => {
      const msg = createCreateSessionRequest('/some/project');
      expect(msg.directory).toBe('/some/project');
    });

    test('round-trips through serialize/deserialize', () => {
      const original = createCreateSessionRequest('/some/dir');
      const deserialized = deserialize(serialize(original));
      expect(deserialized).not.toBeNull();
      expect(deserialized?.type).toBe('create_session_request');
      expect((deserialized as typeof original).directory).toBe('/some/dir');
    });
  });

  describe('createCreateSessionResponse', () => {
    test('creates success response with sessionId', () => {
      const msg = createCreateSessionResponse(true, 'req-1' as UUID, 'session-1' as UUID);
      expect(msg.type).toBe('create_session_response');
      expect(msg.success).toBe(true);
      expect(msg.sessionId).toBe('session-1');
      expect(msg.requestId).toBe('req-1');
      expect(msg.error).toBeUndefined();
    });

    test('creates failure response without sessionId', () => {
      const msg = createCreateSessionResponse(
        false,
        'req-1' as UUID,
        undefined,
        'Directory not found',
      );
      expect(msg.success).toBe(false);
      expect(msg.sessionId).toBeUndefined();
      expect(msg.error).toBe('Directory not found');
      expect(msg.requestId).toBe('req-1');
    });

    test('creates failure response with empty string error', () => {
      const msg = createCreateSessionResponse(false, 'req-1' as UUID, undefined, '');
      // Empty string error should be preserved (not silently dropped)
      expect('error' in msg).toBe(true);
    });

    test('round-trips through serialize/deserialize', () => {
      const original = createCreateSessionResponse(true, 'req-1' as UUID, 'sess-1' as UUID);
      const deserialized = deserialize(serialize(original));
      expect(deserialized).not.toBeNull();
      expect(deserialized?.type).toBe('create_session_response');
      expect((deserialized as typeof original).success).toBe(true);
      expect((deserialized as typeof original).sessionId).toBe('sess-1');
    });
  });

  describe('createTerminalResize', () => {
    test('creates terminal_resize with cols and rows', () => {
      const msg = createTerminalResize(120, 40);
      expect(msg.type).toBe('terminal_resize');
      expect(msg.cols).toBe(120);
      expect(msg.rows).toBe(40);
      expect(msg.id).toBeTruthy();
      expect(msg.timestamp).toBeTruthy();
    });

    test('round-trips through serialize/deserialize', () => {
      const original = createTerminalResize(80, 24);
      const deserialized = deserialize(serialize(original));
      expect(deserialized).not.toBeNull();
      expect(deserialized?.type).toBe('terminal_resize');
      expect((deserialized as typeof original).cols).toBe(80);
      expect((deserialized as typeof original).rows).toBe(24);
    });
  });

  describe('deserialize edge cases', () => {
    test('rejects invalid JSON', () => {
      expect(deserialize('not json')).toBeNull();
    });

    test('rejects object without type', () => {
      expect(deserialize('{"id":"1","timestamp":"2024-01-01T00:00:00Z"}')).toBeNull();
    });

    test('rejects unknown message type', () => {
      expect(
        deserialize('{"type":"unknown","id":"1","timestamp":"2024-01-01T00:00:00Z"}'),
      ).toBeNull();
    });

    test('accepts create_session_request type', () => {
      const result = deserialize(
        '{"type":"create_session_request","id":"1","timestamp":"2024-01-01T00:00:00Z"}',
      );
      expect(result).not.toBeNull();
      expect(result?.type).toBe('create_session_request');
    });

    test('accepts terminal_resize type', () => {
      const result = deserialize(
        '{"type":"terminal_resize","id":"1","timestamp":"2024-01-01T00:00:00Z","cols":80,"rows":24}',
      );
      expect(result).not.toBeNull();
      expect(result?.type).toBe('terminal_resize');
    });

    test('accepts create_session_response type', () => {
      const result = deserialize(
        '{"type":"create_session_response","id":"1","timestamp":"2024-01-01T00:00:00Z","success":true,"requestId":"r1"}',
      );
      expect(result).not.toBeNull();
      expect(result?.type).toBe('create_session_response');
    });

    test('accepts kill_session_request type', () => {
      const result = deserialize(
        '{"type":"kill_session_request","id":"1","timestamp":"2024-01-01T00:00:00Z","sessionId":"s1"}',
      );
      expect(result).not.toBeNull();
      expect(result?.type).toBe('kill_session_request');
    });

    test('accepts kill_session_response type', () => {
      const result = deserialize(
        '{"type":"kill_session_response","id":"1","timestamp":"2024-01-01T00:00:00Z","success":true,"requestId":"r1"}',
      );
      expect(result).not.toBeNull();
      expect(result?.type).toBe('kill_session_response');
    });
  });

  describe('createKillSessionRequest', () => {
    test('creates request with sessionId', () => {
      const msg = createKillSessionRequest('session-1' as UUID);
      expect(msg.type).toBe('kill_session_request');
      expect(msg.sessionId).toBe('session-1');
      expect(msg.id).toBeTruthy();
      expect(msg.timestamp).toBeTruthy();
    });

    test('round-trips through serialize/deserialize', () => {
      const original = createKillSessionRequest('session-1' as UUID);
      const deserialized = deserialize(serialize(original));
      expect(deserialized).not.toBeNull();
      expect(deserialized?.type).toBe('kill_session_request');
      expect((deserialized as typeof original).sessionId).toBe('session-1');
    });
  });

  describe('createKillSessionResponse', () => {
    test('creates success response', () => {
      const msg = createKillSessionResponse(true, 'req-1' as UUID);
      expect(msg.type).toBe('kill_session_response');
      expect(msg.success).toBe(true);
      expect(msg.requestId).toBe('req-1');
      expect(msg.error).toBeUndefined();
    });

    test('creates failure response with error', () => {
      const msg = createKillSessionResponse(false, 'req-1' as UUID, 'Session not found');
      expect(msg.success).toBe(false);
      expect(msg.error).toBe('Session not found');
      expect(msg.requestId).toBe('req-1');
    });

    test('round-trips through serialize/deserialize', () => {
      const original = createKillSessionResponse(true, 'req-1' as UUID);
      const deserialized = deserialize(serialize(original));
      expect(deserialized).not.toBeNull();
      expect(deserialized?.type).toBe('kill_session_response');
      expect((deserialized as typeof original).success).toBe(true);
    });
  });
});
