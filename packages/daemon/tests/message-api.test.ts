/**
 * Tests for MessageAPI - structured message layer.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, StructuredMessage } from '@remi/shared';
import { MessageAPI } from '../src/api/message-api.ts';

describe('MessageAPI', () => {
  let api: MessageAPI;
  let events: {
    onStructuredMessage: ReturnType<typeof mock>;
    onStructuredMessageUpdate: ReturnType<typeof mock>;
    onMessageFinalized: ReturnType<typeof mock>;
    onQuestion: ReturnType<typeof mock>;
    onStatusChange: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    events = {
      onStructuredMessage: mock(() => {}),
      onStructuredMessageUpdate: mock(() => {}),
      onMessageFinalized: mock(() => {}),
      onQuestion: mock(() => {}),
      onStatusChange: mock(() => {}),
    };

    api = new MessageAPI({ sessionId: 'test-session' }, events);
  });

  describe('handleMessage()', () => {
    test('structures message and emits event', () => {
      const message: Message = {
        id: 'msg-1',
        sessionId: 'test-session',
        sender: 'agent',
        content: `- First bullet
- Second bullet`,
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: true,
      };

      api.handleMessage(message);

      expect(events.onStructuredMessage).toHaveBeenCalledTimes(1);
      const structured = events.onStructuredMessage.mock.calls[0]?.[0] as StructuredMessage;
      expect(structured.bullets.length).toBe(2);
      expect(structured.firstBulletId).toBe(1);
      expect(structured.lastBulletId).toBe(2);
    });

    test('stores message for later retrieval', () => {
      const message: Message = {
        id: 'msg-1',
        sessionId: 'test-session',
        sender: 'agent',
        content: '- Single bullet',
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: true,
      };

      api.handleMessage(message);

      const retrieved = api.getMessage('msg-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.bullets.length).toBe(1);
    });

    test('increments bullet count across messages', () => {
      const msg1: Message = {
        id: 'msg-1',
        sessionId: 'test-session',
        sender: 'agent',
        content: '- First\n- Second',
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: false,
      };

      const msg2: Message = {
        id: 'msg-2',
        sessionId: 'test-session',
        sender: 'agent',
        content: '- Third\n- Fourth',
        createdAt: '2026-01-21T00:00:01.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:01.000Z',
        isEditing: false,
      };

      api.handleMessage(msg1);
      api.handleMessage(msg2);

      const structured2 = api.getMessage('msg-2');
      expect(structured2?.firstBulletId).toBe(3); // Continues from msg1
      expect(structured2?.lastBulletId).toBe(4);
      expect(api.bulletCount).toBe(4);
    });
  });

  describe('handleMessageUpdate()', () => {
    test('updates message and tracks changed bullets', () => {
      const message: Message = {
        id: 'msg-1',
        sessionId: 'test-session',
        sender: 'agent',
        content: '- Original bullet',
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: true,
      };

      api.handleMessage(message);
      events.onStructuredMessage.mockClear();

      api.handleMessageUpdate('msg-1', '- Original bullet\n- New bullet');

      expect(events.onStructuredMessageUpdate).toHaveBeenCalledTimes(1);
      const [msgId, updated, changed] = events.onStructuredMessageUpdate.mock.calls[0] ?? [];
      expect(msgId).toBe('msg-1');
      expect((updated as StructuredMessage).bullets.length).toBe(2);
      expect(changed).toContain(2); // New bullet ID
    });

    test('creates message if not found', () => {
      api.handleMessageUpdate('new-msg', '- Brand new bullet');

      expect(events.onStructuredMessage).toHaveBeenCalledTimes(1);
      const created = api.getMessage('new-msg');
      expect(created?.bullets.length).toBe(1);
    });

    test('detects content changes in existing bullets', () => {
      const message: Message = {
        id: 'msg-1',
        sessionId: 'test-session',
        sender: 'agent',
        content: '- Original content',
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: true,
      };

      api.handleMessage(message);

      api.handleMessageUpdate('msg-1', '- Modified content');

      const [, , changed] = events.onStructuredMessageUpdate.mock.calls[0] ?? [];
      expect(changed).toContain(1); // Same bullet ID but content changed
    });
  });

  describe('finalizeMessage()', () => {
    test('marks message as no longer editing', () => {
      const message: Message = {
        id: 'msg-1',
        sessionId: 'test-session',
        sender: 'agent',
        content: '- Bullet',
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: true,
      };

      api.handleMessage(message);
      api.finalizeMessage('msg-1');

      expect(events.onMessageFinalized).toHaveBeenCalledWith('msg-1');
      const retrieved = api.getMessage('msg-1');
      expect(retrieved?.isEditing).toBe(false);
    });
  });

  describe('processHistoryContent()', () => {
    test('counts history bullets and sets initial ID', () => {
      const history = `- First
- Second
- Third`;

      const count = api.processHistoryContent(history);

      expect(count).toBe(3);
      expect(api.engine.nextId).toBe(4); // Next bullet will be 4
    });

    test('new messages after history continue from correct ID', () => {
      api.processHistoryContent('- One\n- Two');

      const message: Message = {
        id: 'msg-after-resume',
        sessionId: 'test-session',
        sender: 'agent',
        content: '- Three',
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: false,
      };

      api.handleMessage(message);

      const structured = api.getMessage('msg-after-resume');
      expect(structured?.firstBulletId).toBe(3);
    });
  });

  describe('reset()', () => {
    test('clears all messages and resets bullet counter', () => {
      const message: Message = {
        id: 'msg-1',
        sessionId: 'test-session',
        sender: 'agent',
        content: '- Bullet',
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: false,
      };

      api.handleMessage(message);
      expect(api.getAllMessages().length).toBe(1);
      expect(api.bulletCount).toBe(1);

      api.reset();

      expect(api.getAllMessages().length).toBe(0);
      expect(api.bulletCount).toBe(0);
    });
  });

  describe('pass-through events', () => {
    test('handleQuestion emits onQuestion', () => {
      const question = {
        id: 'q-1',
        text: 'Continue?',
        options: [],
        allowsFreeText: true,
        isAnswered: false,
      };

      api.handleQuestion(question);

      expect(events.onQuestion).toHaveBeenCalledWith(question);
    });

    test('handleStatusChange emits onStatusChange', () => {
      api.handleStatusChange('thinking', 'Planning...');

      expect(events.onStatusChange).toHaveBeenCalledWith('thinking', 'Planning...');
    });
  });
});
