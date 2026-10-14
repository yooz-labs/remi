import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type ImageStagingMessage,
  decodeImageStagingFrame,
  decodeImageStagingIngress,
  encodeImageStagingFrame,
} from '../src/image-staging';
import vectors from './fixtures/image-staging/vectors.json';

test('original staging codec and ingress preserve all 503 measured wire outcomes', () => {
  const rows = [...vectors.positive, ...vectors.negative].map((vector) => {
    const input = 'raw' in vector ? vector.raw : Uint8Array.from(vector.bytes);
    return [
      vector.name,
      decodeImageStagingFrame(input),
      decodeImageStagingIngress(input),
      'expected' in vector ? encodeImageStagingFrame(vector.expected as ImageStagingMessage) : null,
    ];
  });
  expect(rows).toHaveLength(503);
  expect(createHash('sha256').update(JSON.stringify(rows)).digest('hex')).toBe(
    '6e4b00965be6f1ec973b1cc891778101200adc39471a5e8526fab4737b4cc8dd',
  );
});
