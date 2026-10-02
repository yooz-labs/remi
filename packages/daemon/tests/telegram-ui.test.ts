/**
 * Tests for telegram-ui.ts pure utility functions.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentStatus, DiscoverableSession, Message, Question, UUID } from '@remi/shared';
import {
  formatHelpMessage,
  formatMessageForTelegram,
  formatQuestionCard,
  formatQuestionKeyboard,
  formatQuestionText,
  formatSessionList,
  formatStatusText,
  isValidContent,
  stripTerminalCodes,
} from '../src/adapters/telegram-ui.ts';
import { extractToolQuestion } from '../src/hooks/tool-question.ts';
import { parseQuestion } from '../src/parser/question-parser.ts';

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

describe('formatQuestionCard (#1127)', () => {
  const opt = (label: string, value: string, isYes = false, isNo = false) => ({
    label,
    value,
    isRecommended: false,
    isYes,
    isNo,
  });
  const plan: Question = {
    id: 'q-plan' as UUID,
    text: 'Plan ready for review',
    options: [opt('Approve, auto-accept edits', '1', true), opt('Keep planning', '3', false, true)],
    allowsFreeText: false,
    isAnswered: false,
    kind: 'plan_approval',
  };
  const buttons = (card: ReturnType<typeof formatQuestionCard>) =>
    (
      card.keyboard as unknown as { inline_keyboard: unknown[][] } | undefined
    )?.inline_keyboard.flat().length ?? 0;

  test('a card without detail is its text, with its buttons', () => {
    const card = formatQuestionCard({ ...plan, kind: undefined, text: 'Allow Bash: ls' });
    expect(card.text).toBe('Allow Bash: ls');
    expect(buttons(card)).toBe(2);
  });

  test('a plan that fits is shown in full below its ask, with its buttons', () => {
    const card = formatQuestionCard({ ...plan, detail: '# Plan\n\n- step 1\n' });
    expect(card.text).toBe('Plan ready for review\n\n# Plan\n\n- step 1');
    expect(buttons(card)).toBe(2);
  });

  test('a plan cut at the limit says how much is missing and offers no buttons (review S2)', () => {
    const detail = `${'x'.repeat(5000)}END`;
    const card = formatQuestionCard({ ...plan, detail });
    expect(card.text.length).toBeLessThanOrEqual(4000);
    expect(card.text).not.toContain('END');
    const shown = card.text.split('\n\n')[1] ?? '';
    const missing = detail.length - shown.length;
    expect(card.text).toEndWith(
      `[Plan truncated: ${missing} more characters. Read it and answer in the app.]`,
    );
    expect(card.keyboard).toBeUndefined();
  });

  test('a plan with missing or blank text offers no approve buttons', () => {
    // The cards the daemon builds for `{}` and `{plan: '  '}` (no detail),
    // and a card whose detail is blank.
    const built = [{}, { plan: '  ' }].map((input) => {
      const tool = extractToolQuestion('ExitPlanMode', input);
      if (tool === null) throw new Error('no plan card');
      return { ...plan, options: tool.options, detail: tool.detail };
    });
    expect(built.map((q) => q.detail)).toEqual([undefined, undefined]);
    for (const card0 of [...built, { ...plan, detail: '   ' }]) {
      const card = formatQuestionCard(card0);
      expect(card.text).toBe(
        'Plan ready for review\n\nPlan text unavailable; answer in the app or the terminal.',
      );
      expect(card.keyboard).toBeUndefined();
    }
  });

  test('several questions or a multi-select get no buttons, only "answer in the app" (review S2)', () => {
    const step = (multiSelect: boolean) => ({
      text: 'Q',
      multiSelect,
      options: [opt('A', '1'), opt('B', '2')],
    });
    const base: Question = { ...plan, kind: 'multi_question', text: 'Q', detail: undefined };
    for (const questions of [[step(false), step(false)], [step(true)]]) {
      const card = formatQuestionCard({ ...base, questions });
      expect(card.text).toBe('Q\n\nAnswer in the app.');
      expect(card.keyboard).toBeUndefined();
    }
    // One single-select question keeps its buttons.
    expect(buttons(formatQuestionCard({ ...base, questions: [step(false)] }))).toBe(2);
  });

  test('a terminal-only card gets no buttons and says where to answer (review S2, S7)', () => {
    const card = formatQuestionCard({
      ...plan,
      kind: 'multi_question',
      text: 'Pick',
      detail: undefined,
      terminalOnly: true,
    });
    expect(card.text).toBe(
      'Pick\n\nAnswer this question in the terminal (or cancel it in the app).',
    );
    expect(card.keyboard).toBeUndefined();
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

  test('formats the lifecycle statuses with human labels (#576)', () => {
    // No raw "evaluating"/"approved"/"starting" leaking through the default arm.
    // `evaluating`/`approved` are deprecated (#1125: a current daemon never
    // sets them) but stay in `AgentStatus`, so they keep their labels.
    expect(formatStatusText('evaluating')).toContain('Evaluating');
    expect(formatStatusText('approved')).toContain('Approved');
    expect(formatStatusText('starting')).toContain('Starting');
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
      canResume: false,
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

describe('formatQuestionText for a parsed Claude menu (#1140)', () => {
  test('a hook-less menu card does not invite custom text into the menu', () => {
    const parsed = parseQuestion(
      "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No",
    ).question;
    if (!parsed) throw new Error('the menu did not parse');
    const text = formatQuestionText(parsed);
    expect(text).toContain('Do you want to proceed?');
    expect(text).not.toContain('custom text');
    expect(text).not.toContain('Reply with your answer');
  });

  test('a genuine free-text prompt still asks for a reply', () => {
    const parsed = parseQuestion('Please enter your response:').question;
    if (!parsed) throw new Error('the free-text prompt did not parse');
    expect(formatQuestionText(parsed)).toContain('Reply with your answer');
  });
});

describe('/interrupt help and the free-text hint (#1140)', () => {
  test('/help says /interrupt sends Escape, which declines a pending prompt', () => {
    const line = formatHelpMessage()
      .split('\n')
      .find((l) => l.startsWith('/interrupt'));
    expect(line).toBe(
      '/interrupt - Send Escape to Claude (interrupts its work; declines a pending prompt)',
    );
  });

  test('a card with options gets no "reply with custom text" hint, even if it were flagged as taking text', () => {
    // Nothing produces allowsFreeText together with options since the parser
    // stopped marking selection boxes; the hint's branch was removed with it.
    const flagged: Question = {
      id: 'q-1' as UUID,
      text: 'Pick one',
      options: [
        { label: 'A', value: '1', isRecommended: false, isYes: false, isNo: false },
        { label: 'B', value: '2', isRecommended: false, isYes: false, isNo: false },
      ],
      allowsFreeText: true,
      isAnswered: false,
    };
    const text = formatQuestionText(flagged);
    expect(text).not.toContain('custom text');
    expect(text).not.toContain('Reply with your answer');
  });
});
