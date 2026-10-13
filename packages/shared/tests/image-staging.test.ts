import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  IMAGE_STAGING_CAPABILITY,
  type ImageStagingMessage,
  decodeImageStagingFrame,
  encodeImageStagingFrame,
} from '../src/image-staging.ts';
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from '../src/protocol-version.ts';
import { MESSAGE_DIRECTION, deserialize } from '../src/protocol.ts';
import { fromB64u } from '../src/relay/bytes.ts';
import vectors from './fixtures/image-staging/vectors.json';

describe('actual image staging codec', () => {
  for (const vector of vectors.positive)
    test(vector.name, () => {
      expect(decodeImageStagingFrame(vector.raw)).toEqual(vector.expected as ImageStagingMessage);
      expect(decodeImageStagingFrame(new TextEncoder().encode(vector.raw))).toEqual(
        vector.expected as ImageStagingMessage,
      );
      const encoded = encodeImageStagingFrame(vector.expected as ImageStagingMessage);
      expect(encoded).toBe(JSON.stringify(vector.expected));
      expect(decodeImageStagingFrame(encoded)).toEqual(vector.expected as ImageStagingMessage);
    });
  for (const vector of vectors.negative)
    test(`rejects ${vector.name}`, () => {
      const input = 'raw' in vector ? vector.raw : Uint8Array.from(vector.bytes);
      expect(decodeImageStagingFrame(input)).toBeNull();
      if (typeof input === 'string') {
        try {
          const value = JSON.parse(input);
          if (decodeImageStagingFrame(JSON.stringify(value)) === null)
            expect(() => encodeImageStagingFrame(value)).toThrow('Invalid image staging frame');
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
    });
  for (const image of vectors.images)
    test(`reconstructs actual ${image.file}`, () => {
      const original = readFileSync(
        new URL(`./fixtures/image-staging/${image.file}`, import.meta.url),
      );
      const chunks = vectors.positive
        .filter((v) => v.name.startsWith(`${image.file}:chunk:`))
        .map((v) => {
          const chunk = decodeImageStagingFrame(v.raw);
          expect(chunk?.type).toBe('image_upload_chunk');
          if (chunk?.type !== 'image_upload_chunk') throw new Error('Missing chunk');
          return fromB64u(chunk.data);
        });
      const bytes = Buffer.concat(chunks);
      expect(bytes).toEqual(original);
      expect(bytes.length).toBe(image.bytes);
      const digest = createHash('sha256').update(bytes).digest();
      expect(digest.toString('hex')).toBe(image.sha256);
      for (const name of ['begin', 'result']) {
        const raw = vectors.positive.find((v) => v.name === `${image.file}:${name}`)?.raw;
        if (!raw) throw new Error('Missing declaration');
        const message = decodeImageStagingFrame(raw);
        if (message?.type !== 'image_upload_begin' && message?.type !== 'image_upload_result')
          throw new Error('Invalid declaration');
        expect(Buffer.from(fromB64u(message.digest))).toEqual(digest);
      }
    });
  test('rejects a raw-string lone surrogate constructed at runtime', () => {
    const raw = vectors.positive[0]?.raw;
    if (!raw) throw new Error('Missing raw frame');
    expect(
      decodeImageStagingFrame(raw.replace('session-🌱', String.fromCharCode(0xd800))),
    ).toBeNull();
  });
  test('encoder rejects values JSON would otherwise discard or coerce', () => {
    const original = vectors.positive[0]?.expected as ImageStagingMessage;
    for (const value of [
      { ...original, extra: undefined },
      { ...original, byteLength: Number.NaN },
      { ...original, byteLength: 1n },
      null,
    ]) {
      expect(() => encodeImageStagingFrame(value as ImageStagingMessage)).toThrow(
        'Invalid image staging frame',
      );
    }
  });
  test('additive staging registry preserves version 1 and names exactly nine message directions', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(Object.hasOwn(PROTOCOL_CAPABILITIES, IMAGE_STAGING_CAPABILITY)).toBe(true);
    const expected = {
      image_upload_begin: 'c2d',
      image_upload_accepted: 'd2c',
      image_upload_chunk: 'c2d',
      image_upload_chunk_ack: 'd2c',
      image_upload_complete: 'c2d',
      image_upload_result: 'd2c',
      image_upload_cancel: 'c2d',
      image_upload_cancel_result: 'd2c',
      image_upload_refused: 'd2c',
    } as const;
    expect(
      Object.fromEntries(
        Object.entries(MESSAGE_DIRECTION).filter(([name]) => name.startsWith('image_upload_')),
      ),
    ).toEqual(expected);
  });
  test('registered string frames retain every strict negative vector', () => {
    for (const vector of vectors.negative)
      if ('raw' in vector) expect(deserialize(vector.raw)).toBeNull();
  });
});
