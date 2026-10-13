import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodeImage as proofDecodeImage } from '../../../../scripts/tunnel-decoder-proof/decode';
import inputs from '../../../../scripts/tunnel-decoder-proof/inputs.json';
import { admitImage } from '../../src/tunnel/image-admission';
import { decodeImage } from '../../src/tunnel/image-decode';

const fixture = (name: string) =>
  fs.readFileSync(path.resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof', name));
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

test('proof decoder shares the daemon function and fully decodes the owned image pixels', () => {
  expect(proofDecodeImage).toBe(decodeImage);
  for (const [index, mediaType] of (['image/png', 'image/jpeg'] as const).entries()) {
    const expected = inputs.images[index];
    if (!expected) throw new Error('owned image fixture metadata missing');
    const bytes = fixture(expected.filename);
    expect(sha256(bytes)).toBe(expected.inputSha256);
    const decoded = decodeImage(bytes, mediaType);
    expect({ width: decoded.width, height: decoded.height }).toEqual({
      width: expected.width,
      height: expected.height,
    });
    expect(decoded.data.byteLength).toBe(expected.pixelBytes);
    expect(sha256(decoded.data)).toBe(expected.pixelSha256);
  }
});

test('full decoding preserves header refusal and normalized PNG CRC refusal', () => {
  const png = fixture('fixture.png');
  const jpeg = fixture('fixture.jpg');
  for (const mediaType of ['image/png', 'image/jpeg'] as const) {
    expect(() => decodeImage(png.subarray(0, 0), mediaType)).toThrow('IMAGE_ADMISSION_REFUSED');
  }
  expect(() => decodeImage(png, 'image/jpeg')).toThrow('IMAGE_ADMISSION_REFUSED');
  expect(() => decodeImage(jpeg, 'image/png')).toThrow('IMAGE_ADMISSION_REFUSED');
  const corrupt = Buffer.from(png);
  const crcByte = corrupt[29];
  if (crcByte === undefined) throw new Error('owned PNG CRC byte missing');
  corrupt[29] = crcByte ^ 1;
  expect(admitImage(corrupt, 'image/png')).toEqual({ width: 1024, height: 1024 });
  expect(() => decodeImage(corrupt, 'image/png')).toThrow('IMAGE_DECODE_REFUSED');
});
