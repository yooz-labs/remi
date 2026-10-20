/** Compiles real shared codecs against independent accepted-contract expectations. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  decodeImageInsertionFrame,
  decodeImageInsertionIngress,
  encodeImageInsertionFrame,
} from '../../packages/shared/src/image-insertion';
import {
  type ImageStagingMessage,
  decodeImageStagingFrame,
  decodeImageStagingIngress,
  encodeImageStagingFrame,
} from '../../packages/shared/src/image-staging';
import type insertionSchema from '../../packages/shared/tests/fixtures/image-insertion/vectors.json';
import insertionAsset from '../../packages/shared/tests/fixtures/image-insertion/vectors.json' with {
  type: 'file',
};
import type stagingSchema from '../../packages/shared/tests/fixtures/image-staging/vectors.json';
import stagingAsset from '../../packages/shared/tests/fixtures/image-staging/vectors.json' with {
  type: 'file',
};

if (!process.argv.includes('--owned-spike')) throw new Error('Owned probe only');
const vectors: typeof insertionSchema = JSON.parse(
  await Bun.file(insertionAsset as unknown as string).text(),
);
for (const vector of vectors.positive) {
  for (const input of [vector.raw, new TextEncoder().encode(vector.raw)]) {
    assert.deepEqual(decodeImageInsertionFrame(input), vector.expected, vector.name);
    assert.deepEqual(decodeImageInsertionIngress(input), vector.ingress, vector.name);
  }
  const message = decodeImageInsertionFrame(vector.raw);
  assert(message);
  assert.equal(encodeImageInsertionFrame(message), JSON.stringify(message));
  assert.deepEqual(decodeImageInsertionFrame(encodeImageInsertionFrame(message)), vector.expected);
}
for (const vector of vectors.negative) {
  const inputs =
    'raw' in vector
      ? [vector.raw, new TextEncoder().encode(vector.raw)]
      : 'bytes' in vector
        ? [Uint8Array.from(vector.bytes)]
        : [String.fromCharCode(...vector.units)];
  for (const input of inputs) {
    assert.equal(decodeImageInsertionFrame(input), null, vector.name);
    assert.deepEqual(decodeImageInsertionIngress(input), vector.ingress, vector.name);
  }
}
const staging: typeof stagingSchema = JSON.parse(
  await Bun.file(stagingAsset as unknown as string).text(),
);
const characterized = [...staging.positive, ...staging.negative].map((v) => {
  const input = 'raw' in v ? v.raw : Uint8Array.from(v.bytes);
  const message = decodeImageStagingFrame(input);
  if ('expected' in v) assert(message);
  return [
    v.name,
    message,
    decodeImageStagingIngress(input),
    'expected' in v ? encodeImageStagingFrame(v.expected as ImageStagingMessage) : null,
  ];
});
const stagingHash = createHash('sha256').update(JSON.stringify(characterized)).digest('hex');
assert.equal(stagingHash, '6e4b00965be6f1ec973b1cc891778101200adc39471a5e8526fab4737b4cc8dd');
console.log(
  JSON.stringify({
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    checks: [
      'insertion golden frames and exact correlated ingress',
      'original staging codec behavior unchanged',
    ],
    counts: {
      insertionPositive: vectors.positive.length,
      insertionNegative: vectors.negative.length,
      stagingCharacterized: characterized.length,
    },
    stagingHash,
    scope:
      'Structural codecs only; no effect, authority, handler, advertised capability or Swift acceptance',
  }),
);
