/**
 * Tests for telegram-ui.ts pure utility functions.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentStatus, DiscoverableSession, Message, Question, UUID } from '@remi/shared';
import {
  formatHelpMessage,
  formatMessageForTelegram,
  formatQuestionKeyboard,
  formatSessionList,
  formatStatusText,
  isValidContent,
  stripTerminalCodes,
} from '../src/adapters/telegram-ui.ts';

describe('stripTerminalCodes', () => {
  test('removes ANSI color codes', () => {
    expect(stripTerminalCodes('\x1b[31mred text\x1b[0m')).toBe('red text');
  });

  test('removes cursor movement sequences', () => {
    expect(stripTerminalCodes('\x1b[2Ahello\x1b[3B')).toBe('hello');
  });

  test('removes OSC sequences', () => {
    expect(stripTerminalCodes('\x1b]0;title\x07content')).toBe('content');
  });

  test('removes private mode sequences', () => {
    expect(stripTerminalCodes('\x1b[?25hvisible\x1b[?25l')).toBe('visible');
  });

  test('removes control characters except newline and tab', () => {
    expect(stripTerminalCodes('hello\x00\x01\x02world')).toBe('helloworld');
    expect(stripTerminalCodes('line1\nline2\ttab')).toBe('line1\nline2\ttab');
  });

  test('passes through clean text unchanged', () => {
    expect(stripTerminalCodes('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(stripTerminalCodes('')).toBe('');
  });

  test('removes multiple mixed sequences', () => {
    const input = '\x1b[1m\x1b[32mbold green\x1b[0m normal \x1b[?25h';
    const result = stripTerminalCodes(input);
    expect(result).toBe('bold green normal ');
  });
});

describe('isValidContent', () => {
  test('returns true for text with alphanumeric content', () => {
    expect(isValidContent('hello world')).toBe(true);
  });

  test('returns true for text with numbers', () => {
    expect(isValidContent('123')).toBe(true);
  });

  test('returns false for empty string', () => {
    expect(isValidContent('')).toBe(false);
  });

  test('returns false for whitespace only', () => {
    expect(isValidContent('   ')).toBe(false);
  });

  test('returns false for only special characters', () => {
    expect(isValidContent('---')).toBe(false);
  });

  test('returns true for text with ANSI codes that has content underneath', () => {
    expect(isValidContent('\x1b[31mhello\x1b[0m')).toBe(true);
  });

  test('returns false for only ANSI codes with no real content', () => {
    expect(isValidContent('\x1b[31m\x1b[0m')).toBe(false);
  });
});

describe('formatMessageForTelegram', () => {
  function makeMessage(overrides: Partial<Message> = {}): Message {
    return {
      id: 'msg-1' as UUID,
      sessionId: 'sess-1' as UUID,
      sender: 'agent',
      content: 'Hello world',
      createdAt: '2026-01-01T00:00:00Z',
      state: 'delivered',
      stateChangedAt: '2026-01-01T00:00:00Z',
      isEditing: false,
      ...overrides,
    };
  }

  test('formats basic message', () => {
    const result = formatMessageForTelegram(makeMessage());
    expect(result).toBe('Hello world');
  });

  test('strips ANSI codes from content', () => {
    const result = formatMessageForTelegram(makeMessage({ content: '\x1b[32mgreen\x1b[0m' }));
    expect(result).toBe('green');
  });

  test('returns empty string for invalid content', () => {
    const result = formatMessageForTelegram(makeMessage({ content: '\x1b[0m' }));
    expect(result).toBe('');
  });

  test('truncates messages over 4000 characters', () => {
    const longContent = 'a'.repeat(5000);
    const result = formatMessageForTelegram(makeMessage({ content: longContent }));
    expect(result.length).toBeLessThanOrEqual(4000);
    expect(result.endsWith('...')).toBe(true);
  });

  test('adds tool indicator for editing messages', () => {
    const result = formatMessageForTelegram(
      makeMessage({ tool: 'read_file', isEditing: true, content: 'Reading file...' }),
    );
    expect(result).toContain('read_file');
    expect(result).toContain('Reading file...');
  });

  test('does not add tool indicator when not editing', () => {
    const result = formatMessageForTelegram(
      makeMessage({ tool: 'read_file', isEditing: false, content: 'Done' }),
    );
    expect(result).toBe('Done');
  });
});

describe('formatQuestionKeyboard', () => {
  function makeQuestion(overrides: Partial<Question> = {}): Question {
    return {
      id: 'q-1' as UUID,
      text: 'Allow this?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      ...overrides,
    };
  }

  test('returns an InlineKeyboard object', () => {
    const keyboard = formatQuestionKeyboard(makeQuestion());
    expect(keyboard).toBeDefined();
  });

  test('creates buttons for options', () => {
    const question = makeQuestion({
      options: [
        { label: 'Yes', value: 'y', isYes: true, isNo: false, isRecommended: false },
        { label: 'No', value: 'n', isYes: false, isNo: true, isRecommended: false },
      ],
    });
    const keyboard = formatQuestionKeyboard(question);
    // InlineKeyboard from grammY; the inline_keyboard property holds the rows
    const raw = (keyboard as unknown as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(raw).toBeDefined();
  });

  test('handles question with no options and free text', () => {
    const question = makeQuestion({ options: [], allowsFreeText: true });
    // Should not throw
    const keyboard = formatQuestionKeyboard(question);
    expect(keyboard).toBeDefined();
  });
});

describe('formatStatusText', () => {
  test('formats idle status', () => {
    expect(formatStatusText('idle')).toContain('Idle');
  });

  test('formats thinking status', () => {
    expect(formatStatusText('thinking')).toContain('Thinking');
  });

  test('formats executing status', () => {
    expect(formatStatusText('executing')).toContain('Executing');
  });

  test('formats waiting status', () => {
    expect(formatStatusText('waiting')).toContain('Waiting');
  });

  test('returns raw string for unknown status', () => {
    expect(formatStatusText('custom' as AgentStatus)).toBe('custom');
  });
});

describe('formatHelpMessage', () => {
  test('returns a non-empty string', () => {
    const help = formatHelpMessage();
    expect(help.length).toBeGreaterThan(0);
  });

  test('includes key commands', () => {
    const help = formatHelpMessage();
    expect(help).toContain('/start');
    expect(help).toContain('/stop');
    expect(help).toContain('/help');
    expect(help).toContain('/sessions');
    expect(help).toContain('/load');
  });
});

describe('formatSessionList', () => {
  function makeSession(overrides: Partial<DiscoverableSession> = {}): DiscoverableSession {
    return {
      sessionId: 'sess-abc-123',
      projectPath: '/home/user/projects/my-app',
      status: 'active',
      lastActivity: '2026-01-01T00:00:00Z',
      messageCount: 42,
      source: 'daemon',
      canAttach: true,
      ...overrides,
    };
  }

  test('returns "No sessions found." for empty list', () => {
    expect(formatSessionList([])).toBe('No sessions found.');
  });

  test('shows session count', () => {
    const result = formatSessionList([makeSession()]);
    expect(result).toContain('Sessions (1)');
  });

  test('shows project name from path', () => {
    const result = formatSessionList([makeSession({ projectPath: '/home/user/projects/my-app' })]);
    expect(result).toContain('my-app');
  });

  test('shows session ID', () => {
    const result = formatSessionList([makeSession({ sessionId: 'abc-123' })]);
    expect(result).toContain('abc-123');
  });

  test('shows message count', () => {
    const result = formatSessionList([makeSession({ messageCount: 99 })]);
    expect(result).toContain('99');
  });

  test('shows correct status icon for active', () => {
    const result = formatSessionList([makeSession({ status: 'active' })]);
    expect(result).toContain('🟢');
  });

  test('shows correct status icon for idle', () => {
    const result = formatSessionList([makeSession({ status: 'idle' })]);
    expect(result).toContain('💤');
  });

  test('shows correct status icon for orphaned', () => {
    const result = formatSessionList([makeSession({ status: 'orphaned' })]);
    expect(result).toContain('🔴');
  });

  test('shows correct status icon for completed', () => {
    const result = formatSessionList([makeSession({ status: 'completed' })]);
    expect(result).toContain('✅');
  });

  test('formats multiple sessions', () => {
    const sessions = [
      makeSession({ sessionId: 'sess-1', projectPath: '/a/proj1' }),
      makeSession({ sessionId: 'sess-2', projectPath: '/b/proj2' }),
    ];
    const result = formatSessionList(sessions);
    expect(result).toContain('Sessions (2)');
    expect(result).toContain('sess-1');
    expect(result).toContain('sess-2');
    expect(result).toContain('proj1');
    expect(result).toContain('proj2');
  });
});
