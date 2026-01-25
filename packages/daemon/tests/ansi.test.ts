/**
 * Tests for ANSI escape sequence handling.
 */

import { describe, expect, test } from 'bun:test';
import {
  MESSAGE_MARKERS,
  cleanAndFilterOutput,
  cleanForParsing,
  cleanMessageLine,
  detectMessageBoundary,
  filterTerminalUI,
  hasAnsi,
  normalizeLineEndings,
  splitLines,
  stripAnsi,
} from '../src/parser/ansi.ts';

describe('stripAnsi()', () => {
  test('removes basic color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green');
    expect(stripAnsi('\x1b[1mbold\x1b[0m')).toBe('bold');
  });

  test('removes multiple color codes', () => {
    const input = '\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m \x1b[34mblue\x1b[0m';
    expect(stripAnsi(input)).toBe('red green blue');
  });

  test('removes 256 color codes', () => {
    expect(stripAnsi('\x1b[38;5;196mcolor\x1b[0m')).toBe('color');
  });

  test('removes RGB color codes', () => {
    expect(stripAnsi('\x1b[38;2;255;0;0mcolor\x1b[0m')).toBe('color');
  });

  test('converts cursor up/down to newlines and removes other cursor moves', () => {
    expect(stripAnsi('\x1b[2Aup two')).toBe('\nup two');
    expect(stripAnsi('\x1b[3Bdown three')).toBe('\ndown three');
    expect(stripAnsi('\x1b[Hmove home')).toBe('move home');
  });

  test('removes screen clear codes', () => {
    expect(stripAnsi('\x1b[2Jclear screen')).toBe('clear screen');
    expect(stripAnsi('\x1b[Kclear line')).toBe('clear line');
  });

  test('preserves plain text', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('line1\nline2')).toBe('line1\nline2');
  });

  test('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  test('handles string with only ANSI codes', () => {
    expect(stripAnsi('\x1b[0m\x1b[31m\x1b[0m')).toBe('');
  });

  test('removes OSC sequences (like terminal title)', () => {
    expect(stripAnsi('\x1b]0;title\x07content')).toBe('content');
  });

  test('removes private mode sequences', () => {
    expect(stripAnsi('\x1b[?25hshow cursor')).toBe('show cursor');
    expect(stripAnsi('\x1b[?25lhide cursor')).toBe('hide cursor');
  });

  test('handles real terminal output example', () => {
    const input = '\x1b[1m\x1b[32m✓\x1b[0m \x1b[2mPackages installed\x1b[0m';
    expect(stripAnsi(input)).toBe('✓ Packages installed');
  });
});

describe('hasAnsi()', () => {
  test('returns true for strings with ANSI codes', () => {
    expect(hasAnsi('\x1b[31mred\x1b[0m')).toBe(true);
    expect(hasAnsi('text \x1b[0m end')).toBe(true);
  });

  test('returns false for plain text', () => {
    expect(hasAnsi('hello world')).toBe(false);
    expect(hasAnsi('no escape codes')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(hasAnsi('')).toBe(false);
  });

  test('detects CSI sequences', () => {
    expect(hasAnsi('\x9b31m')).toBe(true); // C1 control
  });
});

describe('normalizeLineEndings()', () => {
  test('converts CRLF to LF', () => {
    expect(normalizeLineEndings('line1\r\nline2')).toBe('line1\nline2');
  });

  test('converts CR to LF', () => {
    expect(normalizeLineEndings('line1\rline2')).toBe('line1\nline2');
  });

  test('preserves LF', () => {
    expect(normalizeLineEndings('line1\nline2')).toBe('line1\nline2');
  });

  test('handles mixed line endings', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  test('handles empty string', () => {
    expect(normalizeLineEndings('')).toBe('');
  });

  test('handles string without line endings', () => {
    expect(normalizeLineEndings('single line')).toBe('single line');
  });
});

describe('cleanForParsing()', () => {
  test('strips ANSI and normalizes line endings', () => {
    const input = '\x1b[31mred\x1b[0m\r\n\x1b[32mgreen\x1b[0m';
    expect(cleanForParsing(input)).toBe('red\ngreen');
  });

  test('handles complex terminal output', () => {
    const input = '\x1b[1mBold\x1b[0m text\r\nwith \x1b[4munderline\x1b[0m';
    expect(cleanForParsing(input)).toBe('Bold text\nwith underline');
  });
});

describe('splitLines()', () => {
  test('splits on LF', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  test('splits on CRLF', () => {
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
  });

  test('splits on CR', () => {
    expect(splitLines('a\rb\rc')).toEqual(['a', 'b', 'c']);
  });

  test('handles single line', () => {
    expect(splitLines('single line')).toEqual(['single line']);
  });

  test('handles empty string', () => {
    expect(splitLines('')).toEqual(['']);
  });

  test('handles trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b', '']);
  });
});

describe('filterTerminalUI()', () => {
  test('filters Claude Code ASCII art logo fragments', () => {
    const input = '▐▛▜▌▝█▘▐▛▜\nReal content here';
    expect(filterTerminalUI(input)).toBe('Real content here');
  });

  test('filters box-drawing lines', () => {
    const input = '─────────────────\nReal content here\n━━━━━━━━━━━';
    expect(filterTerminalUI(input)).toBe('Real content here');
  });

  test('filters prompt indicators', () => {
    const input = '❯ some prompt\nActual output';
    expect(filterTerminalUI(input)).toBe('Actual output');
  });

  test('filters thinking indicators', () => {
    const input = 'Analyzing...\nReal output here';
    expect(filterTerminalUI(input)).toBe('Real output here');
  });

  test('filters version lines', () => {
    const input = 'Claude Code v1.2.3\nOutput content';
    expect(filterTerminalUI(input)).toBe('Output content');
  });

  test('filters path display lines', () => {
    const input = '~/Documents/project/src\nOutput content';
    expect(filterTerminalUI(input)).toBe('Output content');
  });

  test('filters tool execution indicators', () => {
    const input = '⏺ Bash(date)\nactual output';
    expect(filterTerminalUI(input)).toBe('actual output');
  });

  test('filters accept edits UI', () => {
    const input = '⏵⏵ accept edits\nActual content';
    expect(filterTerminalUI(input)).toBe('Actual content');
  });

  test('filters token count indicators', () => {
    const input = '↓ 5.2k tokens\nReal content here';
    expect(filterTerminalUI(input)).toBe('Real content here');
  });

  test('filters tool output metadata lines', () => {
    const input = '  ⎿ Read 5 lines\nReal content here';
    expect(filterTerminalUI(input)).toBe('Real content here');
  });

  test('filters ANSI color code fragments', () => {
    const input = '39m\nReal content here\n90m';
    expect(filterTerminalUI(input)).toBe('Real content here');
  });

  test('filters empty and whitespace-only lines', () => {
    const input = '  \nReal content here\n   ';
    expect(filterTerminalUI(input)).toBe('Real content here');
  });

  test('preserves real content lines', () => {
    const input = 'Here is a function that does X.\nIt takes two parameters.';
    expect(filterTerminalUI(input)).toBe(
      'Here is a function that does X.\nIt takes two parameters.',
    );
  });

  test('filters checkbox wizard elements', () => {
    const input = '☒ Option A\n☐ Option B\nReal output';
    expect(filterTerminalUI(input)).toBe('Real output');
  });

  test('filters enter to select instruction text', () => {
    const input = 'Enter to select\nActual content';
    expect(filterTerminalUI(input)).toBe('Actual content');
  });

  test('filters thinking animation fragments', () => {
    const input = '* z n\n+ g\nActual content';
    expect(filterTerminalUI(input)).toBe('Actual content');
  });

  test('filters lines with replacement characters', () => {
    const input = 'Line with \uFFFD invalid chars\nGood content';
    expect(filterTerminalUI(input)).toBe('Good content');
  });

  test('filters date output from bash', () => {
    const input = 'Sat Jan 24 14:18:51 PST 2026\nReal content here';
    expect(filterTerminalUI(input)).toBe('Real content here');
  });

  test('handles empty input', () => {
    expect(filterTerminalUI('')).toBe('');
  });

  test('handles input with only UI elements', () => {
    const input = '─────\n❯ prompt\n⏺ Bash(ls)\n';
    expect(filterTerminalUI(input)).toBe('');
  });

  test('filters lines starting with > (prompts)', () => {
    const input = '> some prompt\nActual content';
    expect(filterTerminalUI(input)).toBe('Actual content');
  });

  test('filters shift+tab instruction text', () => {
    const input = 'shift+tab to cycle\nReal content';
    expect(filterTerminalUI(input)).toBe('Real content');
  });

  test('filters Claude in Chrome enabled status', () => {
    const input = 'Claude in Chrome enabled\nActual output text';
    expect(filterTerminalUI(input)).toBe('Actual output text');
  });
});

describe('cleanAndFilterOutput()', () => {
  test('strips ANSI codes and filters UI elements', () => {
    const input = '\x1b[31m❯ prompt\x1b[0m\r\n\x1b[32mActual output\x1b[0m';
    expect(cleanAndFilterOutput(input)).toBe('Actual output');
  });

  test('handles complex terminal output with mixed UI and content', () => {
    const input = '─────\n\x1b[1mImportant message\x1b[0m\n⏺ Bash(test)';
    expect(cleanAndFilterOutput(input)).toBe('Important message');
  });

  test('handles empty input', () => {
    expect(cleanAndFilterOutput('')).toBe('');
  });

  test('preserves multi-line content without UI markers', () => {
    const input = 'Line one of output.\nLine two continues.\nLine three ends.';
    expect(cleanAndFilterOutput(input)).toBe(
      'Line one of output.\nLine two continues.\nLine three ends.',
    );
  });
});

describe('MESSAGE_MARKERS', () => {
  test('AGENT_START matches filled circle characters', () => {
    expect(MESSAGE_MARKERS.AGENT_START.test('⏺ Reading file')).toBe(true);
    expect(MESSAGE_MARKERS.AGENT_START.test('● Output')).toBe(true);
    expect(MESSAGE_MARKERS.AGENT_START.test('  ⏺ indented')).toBe(true);
  });

  test('USER_INPUT matches prompt character', () => {
    expect(MESSAGE_MARKERS.USER_INPUT.test('❯ user input')).toBe(true);
    expect(MESSAGE_MARKERS.USER_INPUT.test('  ❯ indented')).toBe(true);
  });

  test('THINKING matches thinking symbols', () => {
    expect(MESSAGE_MARKERS.THINKING.test('✻ thinking...')).toBe(true);
    expect(MESSAGE_MARKERS.THINKING.test('✱ analyzing')).toBe(true);
  });

  test('TOOL_OUTPUT matches tool output continuation', () => {
    expect(MESSAGE_MARKERS.TOOL_OUTPUT.test('⎿ output line')).toBe(true);
    expect(MESSAGE_MARKERS.TOOL_OUTPUT.test('  ⎿ indented output')).toBe(true);
  });

  test('does not match regular text', () => {
    expect(MESSAGE_MARKERS.AGENT_START.test('Regular text')).toBe(false);
    expect(MESSAGE_MARKERS.USER_INPUT.test('no prompt here')).toBe(false);
    expect(MESSAGE_MARKERS.THINKING.test('normal line')).toBe(false);
    expect(MESSAGE_MARKERS.TOOL_OUTPUT.test('just text')).toBe(false);
  });
});

describe('detectMessageBoundary()', () => {
  test('detects agent message start', () => {
    expect(detectMessageBoundary('⏺ Reading file.ts')).toBe('agent');
    expect(detectMessageBoundary('● Output here')).toBe('agent');
  });

  test('detects user input', () => {
    expect(detectMessageBoundary('❯ user typed this')).toBe('user');
  });

  test('detects thinking blocks', () => {
    expect(detectMessageBoundary('✻ thinking about approach')).toBe('thinking');
    expect(detectMessageBoundary('✱ analyzing code')).toBe('thinking');
  });

  test('detects tool output', () => {
    expect(detectMessageBoundary('⎿ tool output line')).toBe('tool_output');
  });

  test('returns null for regular text', () => {
    expect(detectMessageBoundary('Regular text line')).toBeNull();
    expect(detectMessageBoundary('  indented text')).toBeNull();
    expect(detectMessageBoundary('')).toBeNull();
  });

  test('returns null for empty lines', () => {
    expect(detectMessageBoundary('')).toBeNull();
    expect(detectMessageBoundary('   ')).toBeNull();
  });

  test('handles indented markers', () => {
    expect(detectMessageBoundary('  ⏺ indented agent')).toBe('agent');
    expect(detectMessageBoundary('  ❯ indented user')).toBe('user');
  });
});

describe('cleanMessageLine()', () => {
  test('removes agent marker and keeps content', () => {
    expect(cleanMessageLine('⏺ Reading file.ts')).toBe('Reading file.ts');
    expect(cleanMessageLine('● Some output')).toBe('Some output');
  });

  test('removes user marker and keeps content', () => {
    expect(cleanMessageLine('❯ user input here')).toBe('user input here');
  });

  test('removes thinking marker and keeps content', () => {
    expect(cleanMessageLine('✻ thinking about this')).toBe('thinking about this');
    expect(cleanMessageLine('✱ analyzing')).toBe('analyzing');
  });

  test('removes tool output marker and keeps content', () => {
    expect(cleanMessageLine('⎿ output line content')).toBe('output line content');
  });

  test('handles indented markers', () => {
    expect(cleanMessageLine('  ⏺ indented content')).toBe('indented content');
  });

  test('returns trimmed text for lines without markers', () => {
    expect(cleanMessageLine('no marker here')).toBe('no marker here');
    expect(cleanMessageLine('  spaces around  ')).toBe('spaces around');
  });

  test('handles empty string', () => {
    expect(cleanMessageLine('')).toBe('');
  });
});
