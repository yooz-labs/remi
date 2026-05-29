/**
 * Tests for core types and Result utilities.
 */

import { describe, expect, test } from 'bun:test';
import { err, isErr, isOk, ok } from '../src/types.ts';
import type {
  Acknowledgment,
  Message,
  MessageState,
  Question,
  Result,
  Session,
} from '../src/types.ts';

describe('Result utilities', () => {
  describe('ok()', () => {
    test('creates successful result with value', () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      if (isOk(result)) {
        expect(result.value).toBe(42);
      }
    });

    test('works with string values', () => {
      const result = ok('hello');
      expect(result.ok).toBe(true);
      if (isOk(result)) {
        expect(result.value).toBe('hello');
      }
    });

    test('works with object values', () => {
      const data = { foo: 'bar', num: 123 };
      const result = ok(data);
      expect(result.ok).toBe(true);
      if (isOk(result)) {
        expect(result.value).toEqual(data);
      }
    });

    test('works with null value', () => {
      const result = ok(null);
      expect(result.ok).toBe(true);
      if (isOk(result)) {
        expect(result.value).toBe(null);
      }
    });

    test('works with undefined value', () => {
      const result = ok(undefined);
      expect(result.ok).toBe(true);
      if (isOk(result)) {
        expect(result.value).toBe(undefined);
      }
    });

    test('works with array values', () => {
      const arr = [1, 2, 3];
      const result = ok(arr);
      expect(result.ok).toBe(true);
      if (isOk(result)) {
        expect(result.value).toEqual(arr);
      }
    });
  });

  describe('err()', () => {
    test('creates failed result with Error', () => {
      const error = new Error('something went wrong');
      const result = err(error);
      expect(result.ok).toBe(false);
      if (isErr(result)) {
        expect(result.error).toBe(error);
      }
    });

    test('works with string errors', () => {
      const result = err('validation failed');
      expect(result.ok).toBe(false);
      if (isErr(result)) {
        expect(result.error).toBe('validation failed');
      }
    });

    test('works with custom error objects', () => {
      const customError = { code: 'E001', message: 'custom error' };
      const result = err(customError);
      expect(result.ok).toBe(false);
      if (isErr(result)) {
        expect(result.error).toEqual(customError);
      }
    });

    test('works with error codes', () => {
      const result = err(404);
      expect(result.ok).toBe(false);
      if (isErr(result)) {
        expect(result.error).toBe(404);
      }
    });
  });

  describe('isOk()', () => {
    test('returns true for ok results', () => {
      const result = ok(42);
      expect(isOk(result)).toBe(true);
    });

    test('returns false for err results', () => {
      const result = err(new Error('failed'));
      expect(isOk(result)).toBe(false);
    });

    test('type narrows correctly', () => {
      const result: Result<number, Error> = ok(42);
      if (isOk(result)) {
        // TypeScript should know result.value is number here
        const value: number = result.value;
        expect(value).toBe(42);
      }
    });
  });

  describe('isErr()', () => {
    test('returns true for err results', () => {
      const result = err(new Error('failed'));
      expect(isErr(result)).toBe(true);
    });

    test('returns false for ok results', () => {
      const result = ok(42);
      expect(isErr(result)).toBe(false);
    });

    test('type narrows correctly', () => {
      const result: Result<number, Error> = err(new Error('failed'));
      if (isErr(result)) {
        // TypeScript should know result.error is Error here
        const error: Error = result.error;
        expect(error.message).toBe('failed');
      }
    });
  });
});

describe('Type structures', () => {
  describe('Message type', () => {
    test('can create a valid message structure', () => {
      const message: Message = {
        id: 'msg-123',
        sessionId: 'session-456',
        sender: 'agent',
        content: 'Hello, world!',
        createdAt: '2026-01-10T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-10T00:00:01.000Z',
        isEditing: false,
      };

      expect(message.id).toBe('msg-123');
      expect(message.sender).toBe('agent');
      expect(message.state).toBe('sent');
    });

    test('message state transitions are valid', () => {
      const states: MessageState[] = ['sending', 'sent', 'delivered', 'read'];
      for (const state of states) {
        const message: Message = {
          id: 'msg-123',
          sessionId: 'session-456',
          sender: 'user',
          content: 'test',
          createdAt: '2026-01-10T00:00:00.000Z',
          state,
          stateChangedAt: '2026-01-10T00:00:00.000Z',
          isEditing: false,
        };
        expect(message.state).toBe(state);
      }
    });

    test('message can have optional fields', () => {
      const message: Message = {
        id: 'msg-123',
        sessionId: 'session-456',
        sender: 'agent',
        content: 'Reading file...',
        createdAt: '2026-01-10T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-10T00:00:01.000Z',
        isEditing: true,
        editedAt: '2026-01-10T00:00:02.000Z',
        tool: 'Reading config.json',
      };

      expect(message.editedAt).toBe('2026-01-10T00:00:02.000Z');
      expect(message.tool).toBe('Reading config.json');
    });
  });

  describe('Acknowledgment type', () => {
    test('can create delivered ack', () => {
      const ack: Acknowledgment = {
        messageId: 'msg-123',
        state: 'delivered',
        timestamp: '2026-01-10T00:00:00.000Z',
      };

      expect(ack.state).toBe('delivered');
    });

    test('can create read ack', () => {
      const ack: Acknowledgment = {
        messageId: 'msg-123',
        state: 'read',
        timestamp: '2026-01-10T00:00:00.000Z',
      };

      expect(ack.state).toBe('read');
    });
  });

  describe('Question type', () => {
    test('can create question with options', () => {
      const question: Question = {
        id: 'q-123',
        text: 'Do you want to proceed?',
        options: [
          { label: 'Yes', value: 'yes', isRecommended: true, isYes: true, isNo: false },
          { label: 'No', value: 'no', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      };

      expect(question.options.length).toBe(2);
      expect(question.options[0]?.isRecommended).toBe(true);
    });

    test('can create free text question', () => {
      const question: Question = {
        id: 'q-123',
        text: 'What is the file name?',
        options: [],
        allowsFreeText: true,
        isAnswered: false,
      };

      expect(question.allowsFreeText).toBe(true);
      expect(question.options.length).toBe(0);
    });

    test('question can be answered', () => {
      const question: Question = {
        id: 'q-123',
        text: 'Continue?',
        options: [],
        allowsFreeText: true,
        isAnswered: true,
        answer: 'Yes, please continue',
      };

      expect(question.isAnswered).toBe(true);
      expect(question.answer).toBe('Yes, please continue');
    });
  });

  describe('Session type', () => {
    test('can create active session', () => {
      const session: Session = {
        id: 'session-123',
        name: 'claude-code-project',
        startedAt: '2026-01-10T00:00:00.000Z',
        status: 'thinking',
        isActive: true,
      };

      expect(session.isActive).toBe(true);
      expect(session.endedAt).toBeUndefined();
    });

    test('can create ended session', () => {
      const session: Session = {
        id: 'session-123',
        name: 'claude-code-project',
        startedAt: '2026-01-10T00:00:00.000Z',
        endedAt: '2026-01-10T01:00:00.000Z',
        status: 'idle',
        isActive: false,
      };

      expect(session.isActive).toBe(false);
      expect(session.endedAt).toBe('2026-01-10T01:00:00.000Z');
    });
  });
});
