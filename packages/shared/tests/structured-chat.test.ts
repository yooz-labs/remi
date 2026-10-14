import { describe, expect, test } from 'bun:test';
import {
  type ChatSubmitRequest,
  STRUCTURED_CHAT_LIMITS,
  type StructuredChatMessage,
  decodeStructuredChatFrame,
  encodeStructuredChatFrame,
  validChatSubmitText,
} from '../src/structured-chat.ts';
import vectors from './fixtures/structured-chat/vectors.json';

describe('structured chat strict codec corpus', () => {
  for (const vector of vectors.positive)
    test(vector.name, () => {
      const expected = vector.expected as StructuredChatMessage;
      expect(decodeStructuredChatFrame(vector.raw)).toEqual(expected);
      expect(decodeStructuredChatFrame(new TextEncoder().encode(vector.raw))).toEqual(expected);
      expect(decodeStructuredChatFrame(encodeStructuredChatFrame(expected))).toEqual(expected);
    });
  for (const vector of vectors.negative)
    test(`rejects ${vector.name}`, () => {
      const input = 'raw' in vector ? vector.raw : Uint8Array.from(vector.bytes);
      expect(decodeStructuredChatFrame(input)).toBeNull();
    });

  test('all valid maximum byte lengths fit even with JSON escaping; exact content is preserved', () => {
    const base = vectors.positive[0]?.expected as ChatSubmitRequest;
    for (const content of [
      'x'.repeat(16384),
      '🌱'.repeat(4096),
      `${'界'.repeat(5461)}x`,
      '\u0001'.repeat(16384),
      '\uFEFFhello',
    ]) {
      expect(validChatSubmitText(content)).toBe(true);
      const request = { ...base, content };
      const encoded = encodeStructuredChatFrame(request);
      expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(
        STRUCTURED_CHAT_LIMITS.frameBytes,
      );
      expect(decodeStructuredChatFrame(encoded)).toEqual(request);
    }
  });

  test('oversized raw frames and runtime encoding errors fail without payload details', () => {
    expect(decodeStructuredChatFrame(' '.repeat(STRUCTURED_CHAT_LIMITS.frameBytes + 1))).toBeNull();
    expect(
      decodeStructuredChatFrame(new Uint8Array(STRUCTURED_CHAT_LIMITS.frameBytes + 1)),
    ).toBeNull();
    const value = {
      ...vectors.positive[0]?.expected,
      content: 'sensitive\0content',
    } as ChatSubmitRequest;
    expect(() => encodeStructuredChatFrame(value)).toThrow('Invalid structured chat frame');
  });
});
