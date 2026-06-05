/**
 * Tests for the reply / quoted-context formatter (#401).
 */

import { describe, expect, test } from 'bun:test';
import type { UUID } from '@remi/shared';
import {
  MAX_QUOTED_BYTES,
  REPLY_PREVIEW_LENGTH,
  formatReplyMessage,
  previewText,
} from '../../src/lib/reply-format';

const ID = 'm-1' as UUID;

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
  test('wraps the full quoted content in a markdown blockquote (#402 review)', () => {
    // Wire payload is the FULL content, not the 50-char preview, so the
    // agent receives the complete reference, not an excerpt.
    const long = 'a'.repeat(REPLY_PREVIEW_LENGTH + 20);
    const result = formatReplyMessage({ messageId: ID, content: long }, 'reply');
    expect(result).toBe(`> ${long}\n\nreply`);
    expect(result).not.toContain('…');
  });

  test('multi-line quoted content prefixes each line with ">" (#402 review)', () => {
    const result = formatReplyMessage(
      { messageId: ID, content: 'line one\nline two\nline three' },
      'thanks',
    );
    expect(result).toBe('> line one\n> line two\n> line three\n\nthanks');
  });

  test('preserves blank lines inside the quoted content', () => {
    const result = formatReplyMessage(
      { messageId: ID, content: 'paragraph one\n\nparagraph two' },
      'reply',
    );
    expect(result).toBe('> paragraph one\n> \n> paragraph two\n\nreply');
  });

  test('preserves multi-line user text verbatim', () => {
    const result = formatReplyMessage(
      { messageId: ID, content: 'short' },
      'line one\n\nline three\n  indented',
    );
    expect(result).toBe('> short\n\nline one\n\nline three\n  indented');
  });

  test('handles empty user text without adding stray content', () => {
    const result = formatReplyMessage({ messageId: ID, content: 'context' }, '');
    expect(result).toBe('> context\n\n');
  });

  test('truncates content over MAX_QUOTED_BYTES with an ellipsis', () => {
    const huge = 'x'.repeat(MAX_QUOTED_BYTES + 100);
    const result = formatReplyMessage({ messageId: ID, content: huge }, 'reply');
    // Quoted line is "> {chars}" — the chars portion ends in an ellipsis.
    expect(result.startsWith('> ')).toBe(true);
    expect(result).toContain('…');
    // Reply text is preserved verbatim after the blockquote.
    expect(result.endsWith('\n\nreply')).toBe(true);
  });
});
