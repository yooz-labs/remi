import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  IMAGE_INSERTION_CAPABILITY,
  type ImageInsertionIngressResult,
  type ImageInsertionMessage,
  decodeImageInsertionFrame,
  decodeImageInsertionIngress,
  encodeImageInsertionFrame,
} from '../src/image-insertion';
import { isImageInsertionCandidate } from '../src/image-staging-ingress';
import { MESSAGE_DIRECTION, deserialize } from '../src/protocol';
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from '../src/protocol-version';
import type schema from './fixtures/image-insertion/vectors.json';

const vectors: typeof schema = JSON.parse(
  readFileSync(new URL('./fixtures/image-insertion/vectors.json', import.meta.url), 'utf8'),
);
describe('actual accepted image insertion structural codec', () => {
  for (const vector of vectors.positive)
    test(vector.name, () => {
      for (const input of [vector.raw, new TextEncoder().encode(vector.raw)]) {
        expect(decodeImageInsertionFrame(input)).toEqual(vector.expected as ImageInsertionMessage);
        expect(decodeImageInsertionIngress(input)).toEqual(
          vector.ingress as ImageInsertionIngressResult,
        );
      }
      const encoded = encodeImageInsertionFrame(vector.expected as ImageInsertionMessage);
      expect(encoded).toBe(JSON.stringify(vector.expected));
      expect(decodeImageInsertionFrame(encoded)).toEqual(vector.expected as ImageInsertionMessage);
    });
  for (const vector of vectors.negative)
    test(`refuses ${vector.name}`, () => {
      const inputs =
        'raw' in vector
          ? [vector.raw, new TextEncoder().encode(vector.raw)]
          : 'bytes' in vector
            ? [Uint8Array.from(vector.bytes)]
            : [String.fromCharCode(...vector.units)];
      for (const input of inputs) {
        expect(decodeImageInsertionFrame(input)).toBeNull();
        expect(decodeImageInsertionIngress(input)).toEqual(
          vector.ingress as ImageInsertionIngressResult,
        );
      }
      if ('raw' in vector) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(vector.raw);
        } catch {
          return;
        }
        if (decodeImageInsertionFrame(JSON.stringify(parsed)) === null)
          expect(() => encodeImageInsertionFrame(parsed as ImageInsertionMessage)).toThrow(
            'Invalid image insertion frame',
          );
      }
    });
  test('two strict registry directions preserve version1 without advertising insertion', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(Object.hasOwn(PROTOCOL_CAPABILITIES, IMAGE_INSERTION_CAPABILITY)).toBe(false);
    expect(
      Object.fromEntries(
        Object.entries(MESSAGE_DIRECTION).filter(([type]) => type.startsWith('image_insert_')),
      ),
    ).toEqual({ image_insert_request: 'c2d', image_insert_result: 'd2c' });
    for (const vector of vectors.positive)
      expect(deserialize(vector.raw)).toEqual(vector.expected as ImageInsertionMessage);
    // Other known legacy types retain their own parser; only insertion candidates select this codec.
    for (const vector of vectors.negative)
      if ('raw' in vector && isImageInsertionCandidate(vector.raw))
        expect(deserialize(vector.raw)).toBeNull();
  });
  test('encoder rejects discarded fields and unsupported values uniformly', () => {
    const request = vectors.positive[0]?.expected;
    for (const value of [
      null,
      { ...request, extra: undefined },
      { ...request, artifactId: 1n },
      { ...request, binding: { harness: 'claude', harnessSessionId: '\ud800' } },
    ])
      expect(() => encodeImageInsertionFrame(value as ImageInsertionMessage)).toThrow(
        'Invalid image insertion frame',
      );
  });
});
