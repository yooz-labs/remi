/** Compiles the real dormant codec and independent owned byte fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  decodeImageStagingFrame,
  encodeImageStagingFrame,
} from '../../packages/shared/src/image-staging.ts';
import { fromB64u } from '../../packages/shared/src/relay/bytes.ts';
import jpg from '../../packages/shared/tests/fixtures/image-staging/fixture.jpg' with {
  type: 'file',
};
import png from '../../packages/shared/tests/fixtures/image-staging/fixture.png' with {
  type: 'file',
};
import type vectorSchema from '../../packages/shared/tests/fixtures/image-staging/vectors.json';
import vectorAsset from '../../packages/shared/tests/fixtures/image-staging/vectors.json' with {
  type: 'file',
};
// JSON-module bundling replaces lone surrogates; preserve the exact fixture bytes.
const vectors: typeof vectorSchema = JSON.parse(
  await Bun.file(vectorAsset as unknown as string).text(),
);

if (!process.argv.includes('--owned-spike')) throw new Error('Owned probe only');
for (const [name, witness] of [
  ['duplicate-binding', 'rejects duplicate decoded binding key'],
  ['fixture.png:begin:unknown', 'rejects unknown root field'],
  ['oversized-frame', 'rejects oversized frame before parsing'],
  ['bad-data:2', 'rejects noncanonical chunk trailing bits'],
  ['bad-sequence:320', 'rejects sequence above319'],
  ['bad-binding:"\\ud800"', 'rejects lone binding surrogate'],
]) {
  const vector = vectors.negative.find(
    (v) =>
      v.name === name && 'raw' in v && (name !== 'bad-data:2' || v.raw.includes('"data":"AR"')),
  );
  assert(vector && 'raw' in vector, 'Fixture witness exists');
  assert.equal(decodeImageStagingFrame(vector.raw), null, `frame codec witness: ${witness}`);
}
const rawScalarFrame = vectors.positive[0]?.raw;
assert(rawScalarFrame);
assert.equal(
  decodeImageStagingFrame(rawScalarFrame.replace('session-🌱', String.fromCharCode(0xd800))),
  null,
  'raw-string lone surrogate refused',
);
for (const vector of vectors.positive) {
  const message = decodeImageStagingFrame(vector.raw);
  assert.deepEqual(message, vector.expected, vector.name);
  assert(message);
  assert.equal(encodeImageStagingFrame(message), JSON.stringify(message));
  assert.deepEqual(decodeImageStagingFrame(encodeImageStagingFrame(message)), vector.expected);
  assert.deepEqual(decodeImageStagingFrame(new TextEncoder().encode(vector.raw)), vector.expected);
}
for (const vector of vectors.negative)
  assert.equal(
    decodeImageStagingFrame('raw' in vector ? vector.raw : Uint8Array.from(vector.bytes)),
    null,
    vector.name,
  );
for (const [index, image] of vectors.images.entries()) {
  const original = new Uint8Array(await Bun.file(index === 0 ? png : jpg).arrayBuffer());
  const chunks = vectors.positive
    .filter((v) => v.name.startsWith(`${image.file}:chunk:`))
    .map((v) => {
      const message = decodeImageStagingFrame(v.raw);
      assert(message?.type === 'image_upload_chunk');
      return fromB64u(message.data);
    });
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(original));
  assert.equal(original.length, image.bytes);
  const digest = createHash('sha256').update(original).digest();
  assert.equal(digest.toString('hex'), image.sha256);
  for (const name of ['begin', 'result']) {
    const frame = vectors.positive.find((v) => v.name === `${image.file}:${name}`);
    assert(frame);
    const message = decodeImageStagingFrame(frame.raw);
    assert(message?.type === 'image_upload_begin' || message?.type === 'image_upload_result');
    assert.deepEqual(Buffer.from(fromB64u(message.digest)), digest);
  }
}
console.log(
  JSON.stringify({
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    checks: [
      'nine shapes golden roundtrips and raw refusals',
      'owned PNG JPEG chunk reconstruction and digests',
    ],
    images: vectors.images,
    scope: 'Wire shape validation only; no transfer, authority, image decoder or storage effects',
  }),
);
