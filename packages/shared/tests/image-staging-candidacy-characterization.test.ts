import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { isImageStagingCandidate } from '../src/image-staging-ingress';
import vectors from './fixtures/image-staging/vectors.json';

test('original raw staging candidacy preserves all 503 measured outcomes', () => {
  const rows = [...vectors.positive, ...vectors.negative].map((vector) => [
    vector.name,
    isImageStagingCandidate('raw' in vector ? vector.raw : Uint8Array.from(vector.bytes)),
  ]);
  expect(rows).toHaveLength(503);
  expect(createHash('sha256').update(JSON.stringify(rows)).digest('hex')).toBe(
    'd4dd16c65aeb64c13bf1bd0fba38375c7d696ce17738b6e79baba9165cc57452',
  );
});
