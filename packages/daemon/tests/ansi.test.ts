/**
 * Tests for ANSI escape sequence handling.
 */

import { describe, expect, test } from 'bun:test';
import {
  cleanForParsing,
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

  test('removes cursor movement codes', () => {
    expect(stripAnsi('\x1b[2Aup two')).toBe('up two');
    expect(stripAnsi('\x1b[3Bdown three')).toBe('down three');
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
