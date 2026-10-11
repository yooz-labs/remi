// Constructs the real admission wrapper and full decoders with owned image bytes.
import assert from 'node:assert/strict';
import { MAX_INPUT_BYTES, admitImage } from './admission';
import { decodeImage } from './decode';
import jpegAsset from './fixture.jpg' with { type: 'file' };
import pngAsset from './fixture.png' with { type: 'file' };
import inputs from './inputs.json';
import { dispatchProcessWorker, processProof } from './process-probe';

await dispatchProcessWorker();

if (!process.argv.includes('--owned-spike')) {
  console.error('Use --owned-spike for the owned decoder admission corpus.');
  process.exit(2);
}
const png = Buffer.from(await Bun.file(pngAsset).arrayBuffer());
const jpg = Buffer.from(await Bun.file(jpegAsset).arrayBuffer());
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const checks: string[] = [];
const images = [png, jpg].map((bytes, index) => {
  const expected = inputs.images[index];
  assert(expected, 'owned fixture metadata');
  assert.equal(sha(bytes), expected.inputSha256, 'owned fixture input hash');
  const decoded = decodeImage(bytes, index ? 'image/jpeg' : 'image/png');
  const result = {
    width: decoded.width,
    height: decoded.height,
    pixelBytes: decoded.data.byteLength,
    pixelSha256: sha(decoded.data),
  };
  assert.deepEqual(
    result,
    {
      width: expected.width,
      height: expected.height,
      pixelBytes: expected.pixelBytes,
      pixelSha256: expected.pixelSha256,
    },
    'owned full-decode pixels',
  );
  return result;
});
checks.push('owned PNG JPEG inputs and full-decode pixel hashes');
function refused(bytes: Buffer, type: 'image/png' | 'image/jpeg', witness: string) {
  assert.throws(() => admitImage(bytes, type), /^Error: IMAGE_ADMISSION_REFUSED$/, witness);
}
const pngEdit = (edit: (bytes: Buffer) => void) => {
  const bytes = Buffer.from(png);
  edit(bytes);
  return bytes;
};
refused(Buffer.alloc(0), 'image/png', 'empty image input refused');
refused(Buffer.alloc(MAX_INPUT_BYTES + 1), 'image/png', 'oversized image input refused');
const comment = Buffer.alloc(65537);
comment[0] = 255;
comment[1] = 254;
comment.writeUInt16BE(65535, 2);
const largeJPEG = Buffer.concat([
  jpg.subarray(0, 2),
  ...Array.from({ length: Math.ceil(MAX_INPUT_BYTES / comment.length) }, () => comment),
  jpg.subarray(2),
]);
assert(largeJPEG.length > MAX_INPUT_BYTES, 'owned oversized JPEG construction');
refused(largeJPEG, 'image/jpeg', 'oversized conforming JPEG input refused');
assert.throws(
  () => admitImage(jpg, 'unsupported' as 'image/png'),
  /^Error: IMAGE_ADMISSION_REFUSED$/,
  'unsupported media type refused',
);
checks.push('input byte and media type refusal');
refused(
  pngEdit((b) => {
    b[0] = 0;
  }),
  'image/png',
  'PNG signature refused',
);
refused(png.subarray(0, 32), 'image/png', 'PNG short header refused');
refused(
  pngEdit((b) => b.writeUInt32BE(0, 16)),
  'image/png',
  'PNG zero side refused',
);
refused(
  pngEdit((b) => b.writeUInt32BE(8193, 16)),
  'image/png',
  'PNG excessive side refused',
);
refused(
  pngEdit((b) => {
    b.writeUInt32BE(8192, 16);
    b.writeUInt32BE(8192, 20);
  }),
  'image/png',
  'PNG excessive pixels refused',
);
checks.push('PNG signature header and dimension refusal');
const chunk = (type: string, body = Buffer.alloc(0)) => {
  const bytes = Buffer.alloc(12 + body.length);
  bytes.writeUInt32BE(body.length);
  bytes.write(type, 4, 4, 'ascii');
  body.copy(bytes, 8);
  return bytes;
};
for (const type of ['acTL', 'fcTL', 'fdAT'])
  refused(
    Buffer.concat([png.subarray(0, 33), chunk(type), png.subarray(33)]),
    'image/png',
    'PNG animation chunk refused',
  );
refused(
  pngEdit((b) => {
    b[28] = 1;
  }),
  'image/png',
  'PNG interlace refused',
);
refused(
  pngEdit((b) => {
    b[26] = 1;
  }),
  'image/png',
  'PNG compression method refused',
);
refused(
  pngEdit((b) => {
    b[27] = 1;
  }),
  'image/png',
  'PNG filter method refused',
);
checks.push('PNG animation interlace and unsupported method refusal');
refused(
  Buffer.concat([png.subarray(0, 33), png.subarray(8, 33), png.subarray(33)]),
  'image/png',
  'PNG duplicate header refused',
);
refused(png.subarray(0, png.length - 12), 'image/png', 'PNG missing end refused');
refused(Buffer.concat([png, Buffer.from('trailer')]), 'image/png', 'PNG trailing bytes refused');
refused(
  Buffer.concat([png.subarray(0, 33), chunk('IEND')]),
  'image/png',
  'PNG missing image data refused',
);
refused(
  pngEdit((b) => b.writeUInt32BE(0xffffffff, 33)),
  'image/png',
  'PNG chunk overflow refused',
);
checks.push('PNG duplicate chunk and end structure refusal');
// Walk actual generated JPEG segment boundaries, rather than guessed byte offsets.
function marker(code: number) {
  let offset = 2;
  while (offset + 4 <= jpg.length) {
    assert.equal(jpg[offset], 0xff, 'owned JPEG marker structure');
    if (jpg[offset + 1] === code) return offset;
    offset += 2 + jpg.readUInt16BE(offset + 2);
  }
  throw new Error('owned JPEG marker missing');
}
const frame = marker(0xc0);
const quant = marker(0xdb);
const huffman = marker(0xc4);
const scan = marker(0xda);
const entropy = scan + 2 + jpg.readUInt16BE(scan + 2);
const jpgEdit = (edit: (bytes: Buffer) => void) => {
  const bytes = Buffer.from(jpg);
  edit(bytes);
  return bytes;
};
refused(
  jpgEdit((b) => {
    b[0] = 0;
  }),
  'image/jpeg',
  'JPEG signature refused',
);
refused(jpg.subarray(0, 3), 'image/jpeg', 'JPEG short header refused');
refused(
  jpgEdit((b) => b.writeUInt16BE(0, frame + 5)),
  'image/jpeg',
  'JPEG zero side refused',
);
refused(
  jpgEdit((b) => b.writeUInt16BE(8193, frame + 7)),
  'image/jpeg',
  'JPEG excessive side refused',
);
refused(
  jpgEdit((b) => {
    b.writeUInt16BE(8192, frame + 5);
    b.writeUInt16BE(8192, frame + 7);
  }),
  'image/jpeg',
  'JPEG excessive pixels refused',
);
checks.push('JPEG signature header and dimension refusal');
refused(
  jpgEdit((b) => {
    b[frame + 1] = 0xc3;
  }),
  'image/jpeg',
  'JPEG unsupported frame refused',
);
refused(
  jpgEdit((b) => {
    b[frame + 4] = 12;
  }),
  'image/jpeg',
  'JPEG sample precision refused',
);
refused(
  jpgEdit((b) => {
    b[frame + 9] = 0;
  }),
  'image/jpeg',
  'JPEG frame component count refused',
);
refused(
  jpgEdit((b) => {
    b[frame + 11] = 0;
  }),
  'image/jpeg',
  'JPEG sampling factor refused',
);
refused(
  jpgEdit((b) => {
    b[frame + 13] = b[frame + 10];
  }),
  'image/jpeg',
  'JPEG duplicate component refused',
);
const frameEnd = frame + 2 + jpg.readUInt16BE(frame + 2);
refused(
  Buffer.concat([jpg.subarray(0, frameEnd), jpg.subarray(frame, frameEnd), jpg.subarray(frameEnd)]),
  'image/jpeg',
  'JPEG duplicate frame refused',
);
checks.push('JPEG frame precision component and sampling refusal');
refused(
  jpgEdit((b) => b.writeUInt16BE(1, quant + 2)),
  'image/jpeg',
  'JPEG invalid segment length refused',
);
refused(
  jpgEdit((b) => {
    b[quant + 4] = 0x20;
  }),
  'image/jpeg',
  'JPEG quantization precision refused',
);
refused(
  jpgEdit((b) => {
    b[huffman + 4] = 0x20;
  }),
  'image/jpeg',
  'JPEG Huffman specification refused',
);
refused(
  jpgEdit((b) => {
    b[huffman + 5] = 255;
  }),
  'image/jpeg',
  'JPEG oversubscribed Huffman refused',
);
refused(
  Buffer.concat([jpg.subarray(0, 2), Buffer.from([255, 221, 0, 3, 0]), jpg.subarray(2)]),
  'image/jpeg',
  'JPEG DRI length refused',
);
checks.push('JPEG segment quantization Huffman and restart length refusal');
refused(
  jpgEdit((b) => {
    b[scan + 4] = 0;
  }),
  'image/jpeg',
  'JPEG scan component count refused',
);
refused(jpg.subarray(0, jpg.length - 2), 'image/jpeg', 'JPEG missing end refused');
refused(Buffer.concat([jpg, Buffer.from('trailer')]), 'image/jpeg', 'JPEG trailing bytes refused');
refused(
  jpgEdit((b) => {
    b[quant + 1] = 0xde;
  }),
  'image/jpeg',
  'JPEG unknown marker refused',
);
checks.push('JPEG scan marker and end structure refusal');
assert.throws(
  () =>
    decodeImage(
      pngEdit((b) => {
        b[29] ^= 1;
      }),
      'image/png',
    ),
  /^Error: IMAGE_DECODE_REFUSED$/,
  'PNG CRC full-decode refusal',
);
const noEntropy = Buffer.concat([jpg.subarray(0, entropy), Buffer.from([255, 217])]);
assert.deepEqual(
  admitImage(noEntropy, 'image/jpeg'),
  { width: inputs.images[1].width, height: inputs.images[1].height },
  'entropy-free header admitted for decoder check',
);
assert.throws(
  () => decodeImage(noEntropy, 'image/jpeg'),
  /^Error: IMAGE_DECODE_REFUSED$/,
  'JPEG entropy full-decode refusal',
);
checks.push('full PNG CRC and JPEG entropy decode refusal');
checks.push(...(await processProof(png, jpg)));
console.log(
  JSON.stringify({
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    checks,
    images,
    scope:
      'decoder admission and child lifetime candidate; hard memory CPU budgets and held approval remain unproved; no production integration',
  }),
);
