import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as proofAdmission from '../../../../scripts/tunnel-decoder-proof/admission';
import type { Dimensions as ProofDimensions } from '../../../../scripts/tunnel-decoder-proof/admission';
import inputs from '../../../../scripts/tunnel-decoder-proof/inputs.json';
import { MAX_INPUT_BYTES, admitImage } from '../../src/tunnel/image-admission';
import type { Dimensions } from '../../src/tunnel/image-admission';

const fixture = (name: string) =>
  fs.readFileSync(path.resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof', name));

test('proof image admission shares daemon exports and admits the owned PNG and JPEG headers', () => {
  expect(proofAdmission.admitImage).toBe(admitImage);
  expect(proofAdmission.MAX_INPUT_BYTES).toBe(MAX_INPUT_BYTES);
  expect(MAX_INPUT_BYTES).toBe(10 * 1024 * 1024);
  for (const [index, mediaType] of (['image/png', 'image/jpeg'] as const).entries()) {
    const expected = inputs.images[index];
    if (!expected) throw new Error('owned image fixture metadata missing');
    const bytes = fixture(expected.filename);
    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(expected.inputSha256);
    const dimensions: Dimensions = admitImage(bytes, mediaType);
    const proofDimensions: ProofDimensions = proofAdmission.admitImage(bytes, mediaType);
    expect(dimensions).toEqual({ width: expected.width, height: expected.height });
    expect(proofDimensions).toEqual(dimensions);
    expect(Object.isFrozen(dimensions)).toBe(true);
  }
});

test('owned image admission retains input size and format refusals', () => {
  const png = fixture('fixture.png');
  const jpeg = fixture('fixture.jpg');
  for (const mediaType of ['image/png', 'image/jpeg'] as const) {
    expect(() => admitImage(png.subarray(0, 0), mediaType)).toThrow('IMAGE_ADMISSION_REFUSED');
    expect(() => admitImage(Buffer.alloc(MAX_INPUT_BYTES + 1), mediaType)).toThrow(
      'IMAGE_ADMISSION_REFUSED',
    );
  }
  expect(() => admitImage(png, 'image/jpeg')).toThrow('IMAGE_ADMISSION_REFUSED');
  expect(() => admitImage(jpeg, 'image/png')).toThrow('IMAGE_ADMISSION_REFUSED');
  expect(() => admitImage(png.subarray(0, 32), 'image/png')).toThrow('IMAGE_ADMISSION_REFUSED');
  expect(() => admitImage(jpeg.subarray(0, 32), 'image/jpeg')).toThrow('IMAGE_ADMISSION_REFUSED');
  expect(() => admitImage(png, 'unsupported' as 'image/png')).toThrow('IMAGE_ADMISSION_REFUSED');
});
