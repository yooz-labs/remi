/**
 * Tests for the reply / quoted-context formatter (#401).
 */

import { describe, expect, test } from 'bun:test';
import { REPLY_PREVIEW_LENGTH, formatReplyMessage, previewText } from '../../src/lib/reply-format';

describe('previewText', () => {
  test('returns the input verbatim when within the preview length', () => {
    expect(previewText('Hello world')).toBe('Hello world');
  });

  test('truncates with an ellipsis past the preview length', () => {
    const long = 'a'.repeat(REPLY_PREVIEW_LENGTH + 10);
    const out = previewText(long);
    expect(out.length).toBe(REPLY_PREVIEW_LENGTH + 1); // 50 chars + ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('a'.repeat(REPLY_PREVIEW_LENGTH))).toBe(true);
  });

  test('exact preview length is NOT truncated', () => {
    const exact = 'a'.repeat(REPLY_PREVIEW_LENGTH);
    expect(previewText(exact)).toBe(exact);
  });

  test('collapses runs of whitespace and trims', () => {
    expect(previewText('  hello   world  \n  again  ')).toBe('hello world again');
  });

  test('whitespace collapse counts toward the preview length, not the original', () => {
    // 60 spaces collapse to 0 chars; the trailing word is short.
    const padded = `${' '.repeat(60)}short`;
    expect(previewText(padded)).toBe('short');
  });

  test('respects a custom maxLength', () => {
    expect(previewText('Hello world', 5)).toBe('Hello…');
  });
});

describe('formatReplyMessage', () => {
  test('wraps the quoted content in a markdown blockquote and appends user text', () => {
    const result = formatReplyMessage(
      { messageId: 'm-1', content: 'Refactor the authentication module' },
      'On it.',
    );
    expect(result).toBe('> Refactor the authentication module\n\nOn it.');
  });

  test('uses the truncated preview when content is long', () => {
    const long = 'a'.repeat(REPLY_PREVIEW_LENGTH + 20);
    const result = formatReplyMessage({ messageId: 'm-1', content: long }, 'reply');
    expect(result.startsWith(`> ${'a'.repeat(REPLY_PREVIEW_LENGTH)}…`)).toBe(true);
    expect(result.endsWith('reply')).toBe(true);
  });

  test('preserves multi-line user text verbatim', () => {
    const result = formatReplyMessage(
      { messageId: 'm-1', content: 'short' },
      'line one\n\nline three\n  indented',
    );
    expect(result).toBe('> short\n\nline one\n\nline three\n  indented');
  });

  test('handles empty user text without trailing whitespace', () => {
    const result = formatReplyMessage({ messageId: 'm-1', content: 'context' }, '');
    expect(result).toBe('> context\n\n');
  });
});
