// Normative PLTE controls use the actual owned icon pixels and pinned pngjs CRC implementation.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import CRC from 'pngjs/lib/crc';
import { admitImage } from './admission';
import { decodeImage } from './decode';
import inputs from './inputs.json';

const sha = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, body: Buffer): Buffer {
  const bytes = Buffer.alloc(body.length + 12);
  bytes.writeUInt32BE(body.length);
  bytes.write(type, 4, 4, 'ascii');
  body.copy(bytes, 8);
  bytes.writeUInt32BE(CRC.crc32(bytes.subarray(4, bytes.length - 4)) >>> 0, bytes.length - 4);
  return bytes;
}

function header(width: number, height: number, depth: number, color: number): Buffer {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(width);
  body.writeUInt32BE(height, 4);
  body[8] = depth;
  body[9] = color;
  return chunk('IHDR', body);
}

function refused(bytes: Buffer, witness: string): void {
  assert.throws(() => admitImage(bytes, 'image/png'), /^Error: IMAGE_ADMISSION_REFUSED$/, witness);
}

export function paletteProof(png: Buffer): {
  checks: string[];
  images: { witness: string; inputSha256: string; pixelSha256: string }[];
} {
  const original = decodeImage(png, 'image/png');
  const originalPixels = Buffer.from(original.data);
  const expected = inputs.images[0];
  assert.equal(
    sha(originalPixels),
    expected.pixelSha256,
    'palette source is actual owned icon pixels',
  );
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; offset += 12 + png.readUInt32BE(offset)) {
    chunks.push(png.subarray(offset, offset + 12 + png.readUInt32BE(offset)));
  }
  const paletteIndex = chunks.findIndex((bytes) => bytes.toString('ascii', 4, 8) === 'PLTE');
  assert(paletteIndex > 0, 'owned indexed icon has actual palette');
  const ownedPalette = chunks[paletteIndex].subarray(8, chunks[paletteIndex].length - 4);
  const replacePalette = (body: Buffer) =>
    Buffer.concat([
      signature,
      ...chunks.slice(0, paletteIndex),
      chunk('PLTE', body),
      ...chunks.slice(paletteIndex + 1),
    ]);
  const oversized = Buffer.alloc(771);
  ownedPalette.copy(oversized);
  for (const size of [0, 1, 2, 4, 767, 769, 771]) {
    refused(replacePalette(oversized.subarray(0, size)), `PNG palette length ${size} refused`);
  }

  // Encode the same decoded icon as truecolor, so a suggested palette never changes its pixels.
  function truecolor(color: 2 | 6): Buffer[] {
    const encoded = PNG.sync.write(
      { width: original.width, height: original.height, data: originalPixels },
      { colorType: color, inputColorType: 6, bitDepth: 8 },
    );
    assert.equal(encoded[25], color, 'pinned encoder produces requested truecolor format');
    const result: Buffer[] = [];
    for (let offset = 8; offset < encoded.length; offset += 12 + encoded.readUInt32BE(offset)) {
      result.push(encoded.subarray(offset, offset + 12 + encoded.readUInt32BE(offset)));
    }
    assert.deepEqual(
      result.map((bytes) => bytes.toString('ascii', 4, 8)),
      ['IHDR', 'IDAT', 'IEND'],
      'pinned truecolor encoder chunk boundaries',
    );
    return result;
  }

  const rgba = truecolor(6);
  const suggested = ownedPalette.subarray(0, 3);
  for (const [body, witness] of [
    [Buffer.alloc(0), 'PNG empty truecolor palette refused'],
    [oversized, 'PNG oversized truecolor palette refused'],
  ] as const) {
    refused(Buffer.concat([signature, rgba[0], chunk('PLTE', body), ...rgba.slice(1)]), witness);
  }
  for (const color of [0, 4, 1, 5]) {
    refused(
      Buffer.concat([
        signature,
        header(original.width, original.height, 8, color),
        chunk('PLTE', suggested),
        ...rgba.slice(1),
      ]),
      `PNG palette colour ${color} refused`,
    );
  }

  const first = originalPixels.subarray(0, 4);
  let second: Buffer | undefined;
  for (let offset = 4; offset < originalPixels.length; offset += 4) {
    const pixel = originalPixels.subarray(offset, offset + 4);
    if (!pixel.equals(first)) {
      second = pixel;
      break;
    }
  }
  assert(second, 'owned icon supplies two different actual pixels');
  const tinyPixels = Buffer.concat([first, second]);
  const tinyPalette = Buffer.concat([first.subarray(0, 3), second.subarray(0, 3)]);
  function indexed(depth: number, entries = 2): Buffer {
    const palette = Buffer.alloc(entries * 3);
    tinyPalette.copy(palette);
    const packed = depth === 8 ? Buffer.from([0, 0, 1]) : Buffer.from([0, 1 << (8 - 2 * depth)]);
    return Buffer.concat([
      signature,
      header(2, 1, depth, 3),
      chunk('PLTE', palette),
      chunk('IDAT', deflateSync(packed)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
  for (const depth of [1, 2, 4]) {
    refused(indexed(depth, 2 ** depth + 1), `PNG indexed palette depth ${depth} capacity refused`);
  }
  for (const depth of [0, 3, 16]) {
    refused(indexed(depth), `PNG indexed bit depth ${depth} refused`);
  }
  const checks = ['PNG palette length colour and bit-depth refusal'];

  refused(
    Buffer.concat([
      signature,
      ...chunks.slice(0, paletteIndex + 1),
      chunks[paletteIndex],
      ...chunks.slice(paletteIndex + 1),
    ]),
    'PNG duplicate palette refused',
  );
  refused(
    Buffer.concat([signature, rgba[0], rgba[1], chunk('PLTE', suggested), rgba[2]]),
    'PNG palette after first IDAT refused',
  );
  refused(
    Buffer.concat([signature, ...chunks.filter((_, index) => index !== paletteIndex)]),
    'PNG indexed image without palette refused',
  );
  checks.push('PNG palette uniqueness ordering and required palette refusal');

  const images: { witness: string; inputSha256: string; pixelSha256: string }[] = [];
  const complete = (
    bytes: Buffer,
    pixels: Buffer,
    width: number,
    height: number,
    witness: string,
  ) => {
    assert.deepEqual(admitImage(bytes, 'image/png'), { width, height }, witness);
    const decoded = decodeImage(bytes, 'image/png');
    assert.equal(decoded.width, width, witness);
    assert.equal(decoded.height, height, witness);
    assert.equal(decoded.data.length, pixels.length, witness);
    assert.equal(sha(decoded.data), sha(pixels), witness);
    images.push({ witness, inputSha256: sha(bytes), pixelSha256: sha(decoded.data) });
  };
  const largestSuggested = Buffer.alloc(768);
  for (let offset = 0; offset < largestSuggested.length; offset += 3) {
    ownedPalette.copy(
      largestSuggested,
      offset,
      offset % ownedPalette.length,
      (offset % ownedPalette.length) + 3,
    );
  }
  for (const color of [2, 6] as const) {
    const encoded = color === 6 ? rgba : truecolor(color);
    complete(
      Buffer.concat([signature, ...encoded]),
      originalPixels,
      original.width,
      original.height,
      `PNG optional truecolor colour ${color} palette full pixels`,
    );
    for (const palette of [suggested, largestSuggested]) {
      complete(
        Buffer.concat([signature, encoded[0], chunk('PLTE', palette), ...encoded.slice(1)]),
        originalPixels,
        original.width,
        original.height,
        `PNG legal suggested palette ${palette.length / 3} colour ${color} full pixels`,
      );
    }
  }
  for (const depth of [1, 2, 4, 8]) {
    complete(indexed(depth), tinyPixels, 2, 1, `PNG legal indexed depth ${depth} full pixels`);
    complete(
      indexed(depth, 2 ** depth),
      tinyPixels,
      2,
      1,
      `PNG legal indexed depth ${depth} capacity full pixels`,
    );
  }
  checks.push('PNG legal palette full-decode pixel agreement');
  return { checks, images };
}
