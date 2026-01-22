/**
 * Tests for package exports.
 * Ensures all public API is properly exported.
 */

import { describe, expect, test } from 'bun:test';

// Test that all exports are accessible
import {
  MessageIdTracker,
  createAck,
  createAgentOutput,
  createEdit,
  createError,
  createHello,
  createHelloAck,
  createPing,
  createPong,
  createUserInput,
  deserialize,
  err,
  // Protocol utilities
  generateId,
  isErr,
  isOk,
  now,
  // Types - these are type-only exports, can't test at runtime
  // but TypeScript will fail to compile if they're missing

  // Result utilities
  ok,
  serialize,
} from '../src/index.ts';

// Type-only imports to verify they compile
import type {
  Acknowledgment,
  AgentStatus,
  ConnectionInfo,
  Message,
  MessageSender,
  MessageState,
  Question,
  QuestionOption,
  Result,
  Session,
  Timestamp,
  UUID,
} from '../src/index.ts';

describe('Package exports', () => {
  describe('Result utilities', () => {
    test('ok is exported and functional', () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
    });

    test('err is exported and functional', () => {
      const result = err(new Error('test'));
      expect(result.ok).toBe(false);
    });

    test('isOk is exported and functional', () => {
      expect(isOk(ok(1))).toBe(true);
      expect(isOk(err(1))).toBe(false);
    });

    test('isErr is exported and functional', () => {
      expect(isErr(err(1))).toBe(true);
      expect(isErr(ok(1))).toBe(false);
    });
  });

  describe('Protocol utilities', () => {
    test('generateId is exported and functional', () => {
      const id = generateId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    test('now is exported and functional', () => {
      const timestamp = now();
      expect(typeof timestamp).toBe('string');
      expect(new Date(timestamp).getTime()).toBeGreaterThan(0);
    });

    test('serialize is exported and functional', () => {
      const msg = createPing();
      const json = serialize(msg);
      expect(typeof json).toBe('string');
    });

    test('deserialize is exported and functional', () => {
      const msg = createPing();
      const json = serialize(msg);
      const parsed = deserialize(json);
      expect(parsed).not.toBeNull();
    });

    test('MessageIdTracker is exported and functional', () => {
      const tracker = new MessageIdTracker();
      expect(tracker.size).toBe(0);
    });
  });

  describe('Message factories', () => {
    test('createHello is exported and functional', () => {
      const msg = createHello('client-123', '1.0.0');
      expect(msg.type).toBe('hello');
    });

    test('createHelloAck is exported and functional', () => {
      const msg = createHelloAck('1.0.0', 'session-456');
      expect(msg.type).toBe('hello_ack');
    });

    test('createAgentOutput is exported and functional', () => {
      const message: Message = {
        id: 'msg-123',
        sessionId: 'session-456',
        sender: 'agent',
        content: 'test',
        createdAt: now(),
        state: 'sent',
        stateChangedAt: now(),
        isEditing: false,
      };
      const msg = createAgentOutput(message);
      expect(msg.type).toBe('agent_output');
    });

    test('createUserInput is exported and functional', () => {
      const msg = createUserInput('session-456', 'test');
      expect(msg.type).toBe('user_input');
    });

    test('createAck is exported and functional', () => {
      const ack: Acknowledgment = {
        messageId: 'msg-123',
        state: 'delivered',
        timestamp: now(),
      };
      const msg = createAck(ack);
      expect(msg.type).toBe('ack');
    });

    test('createEdit is exported and functional', () => {
      const msg = createEdit('msg-123', 'new content', false);
      expect(msg.type).toBe('edit');
    });

    test('createPing is exported and functional', () => {
      const msg = createPing();
      expect(msg.type).toBe('ping');
    });

    test('createPong is exported and functional', () => {
      const msg = createPong('ping-123');
      expect(msg.type).toBe('pong');
    });

    test('createError is exported and functional', () => {
      const msg = createError('E001', 'test error');
      expect(msg.type).toBe('error');
    });
  });

  describe('Type definitions compile correctly', () => {
    test('Message type structure', () => {
      // This test verifies the type compiles correctly
      const message: Message = {
        id: 'test' as UUID,
        sessionId: 'test' as UUID,
        sender: 'agent' as MessageSender,
        content: 'test',
        createdAt: 'test' as Timestamp,
        state: 'sent' as MessageState,
        stateChangedAt: 'test' as Timestamp,
        isEditing: false,
      };
      expect(message).toBeDefined();
    });

    test('Session type structure', () => {
      const session: Session = {
        id: 'test' as UUID,
        name: 'test',
        startedAt: 'test' as Timestamp,
        status: 'idle' as AgentStatus,
        isActive: true,
      };
      expect(session).toBeDefined();
    });

    test('Question type structure', () => {
      const option: QuestionOption = {
        label: 'Yes',
        value: 'yes',
        isRecommended: true,
        isYes: true,
        isNo: false,
      };
      const question: Question = {
        id: 'test' as UUID,
        text: 'test?',
        options: [option],
        allowsFreeText: true,
        isAnswered: false,
      };
      expect(question).toBeDefined();
    });

    test('ConnectionInfo type structure', () => {
      const info: ConnectionInfo = {
        code: 'ABCD-1234',
        directAddresses: ['192.168.1.1:8080'],
        expiresAt: 'test' as Timestamp,
      };
      expect(info).toBeDefined();
    });

    test('Result type works with custom error types', () => {
      type CustomError = { code: number; message: string };
      const result: Result<string, CustomError> = ok('success');
      expect(isOk(result)).toBe(true);
    });
  });
});
