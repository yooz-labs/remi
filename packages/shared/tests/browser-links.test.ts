/** Structural codec/vector coverage only; this is not transport, native, or end-to-end acceptance. */
import { describe, expect, test } from 'bun:test';
import {
  BROWSER_LINKS_LIMITS,
  type BrowserLinkMessage,
  decodeBrowserLinkFrame,
  encodeBrowserLinkFrame,
  normalizeBrowserLinkURL,
} from '../src/browser-links.ts';
import vectors from './fixtures/browser-links/vectors.json';

describe('browser-link structural codec and vectors (NOT transport/end-to-end/native)', () => {
  for (const vector of vectors.positive as {
    name: string;
    raw: string;
    expected: BrowserLinkMessage;
  }[])
    test(vector.name, () => {
      expect(decodeBrowserLinkFrame(vector.raw)).toEqual(vector.expected);
      expect(decodeBrowserLinkFrame(new TextEncoder().encode(vector.raw))).toEqual(vector.expected);
      expect(decodeBrowserLinkFrame(encodeBrowserLinkFrame(vector.expected))).toEqual(
        vector.expected,
      );
    });

  for (const vector of vectors.negative as (
    | { name: string; raw: string }
    | { name: string; bytes: number[] }
  )[])
    test(`rejects ${vector.name}`, () => {
      const input = 'raw' in vector ? vector.raw : Uint8Array.from(vector.bytes);
      expect(decodeBrowserLinkFrame(input)).toBeNull();
    });

  for (const vector of vectors.urlNormalization.positive as {
    name: string;
    input: string;
    expected: string;
  }[])
    test(`normalizes URL: ${vector.name}`, () => {
      expect(normalizeBrowserLinkURL(vector.input)).toBe(vector.expected);
    });

  for (const vector of vectors.urlNormalization.negative as { name: string; input: unknown }[])
    test(`refuses URL: ${vector.name}`, () => {
      expect(normalizeBrowserLinkURL(vector.input)).toBeNull();
    });

  test('frame byte limits reject oversized strings and original byte arrays', () => {
    expect(decodeBrowserLinkFrame(' '.repeat(BROWSER_LINKS_LIMITS.frameBytes + 1))).toBeNull();
    expect(decodeBrowserLinkFrame(new Uint8Array(BROWSER_LINKS_LIMITS.frameBytes + 1))).toBeNull();
    expect(decodeBrowserLinkFrame('🌱'.repeat(16385))).toBeNull();
    expect(decodeBrowserLinkFrame('\ud800')).toBeNull();
  });

  test('URL bounds include exact canonical limit and reject over-limit input and serialization', () => {
    const prefix = 'https://example.com/';
    const atLimit = `${prefix}${'a'.repeat(BROWSER_LINKS_LIMITS.urlBytes - prefix.length)}`;
    expect(atLimit.length).toBe(BROWSER_LINKS_LIMITS.urlBytes);
    expect(normalizeBrowserLinkURL(atLimit)).toBe(atLimit);
    expect(normalizeBrowserLinkURL(`${atLimit}a`)).toBeNull();
    expect(normalizeBrowserLinkURL(`https://example.com/${' '.repeat(1400)}`)).toBeNull();
    expect(normalizeBrowserLinkURL('https://example.com/é'.repeat(500))).toBeNull();
  });

  test('encoder uses one payload-free error for every invalid message', () => {
    const selected = vectors.positive.find((vector) => vector.name === 'selected-result');
    const candidate = vectors.positive.find((vector) => vector.name === 'candidate-canonical-url');
    const invalidMessages: BrowserLinkMessage[] = [
      { ...(selected?.expected as BrowserLinkMessage), seq: 0 } as BrowserLinkMessage,
      {
        ...(candidate?.expected as Record<string, unknown>),
        url: 'https://private.example/?token=hidden',
        lifetimeMs: 0,
      } as unknown as BrowserLinkMessage,
    ];
    for (const message of invalidMessages) {
      try {
        encodeBrowserLinkFrame(message);
        throw new Error('expected encoder rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Invalid browser link frame');
        expect((error as Error).message).not.toContain('private.example');
        expect((error as Error).message).not.toContain('hidden');
      }
    }
  });
});
