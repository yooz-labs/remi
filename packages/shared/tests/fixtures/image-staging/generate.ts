/** Deterministic ADR 0041 wire vectors; not transfer receipts or image-decoder acceptance. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_STAGING_REFUSAL_CODES,
  type ImageStagingMessage,
  encodeImageStagingFrame,
} from '../../../src/image-staging.ts';
import { b64u, fromB64u } from '../../../src/relay/bytes.ts';

const directory = fileURLToPath(new URL('.', import.meta.url));
const envelope = {
  id: '00112233-4455-4677-8899-aabbccddeeff',
  timestamp: '2026-10-11T12:00:00.000Z',
  sessionId: '00112233-4455-7677-8899-aabbccddeeff',
};
const response = { requestId: '11112233-4455-4677-8899-aabbccddeeff' };
const transferId = b64u(new Uint8Array(16).fill(1));
const artifactId = b64u(new Uint8Array(16).fill(2));
const binding = { harness: 'claude', harnessSessionId: 'session-🌱' };
const positive: { name: string; raw: string; expected: ImageStagingMessage }[] = [];
const negative: { name: string; raw?: string; bytes?: number[] }[] = [];
const add = (name: string, fields: Record<string, unknown>) => {
  const expected = { ...envelope, ...fields } as ImageStagingMessage;
  positive.push({ name, raw: encodeImageStagingFrame(expected), expected });
};
const images = ['fixture.png', 'fixture.jpg'].map((file, index) => {
  const bytes = readFileSync(directory + file);
  const digest = createHash('sha256').update(bytes).digest();
  const mediaType = index === 0 ? 'image/png' : 'image/jpeg';
  add(`${file}:begin`, {
    type: 'image_upload_begin',
    binding,
    mediaType,
    byteLength: bytes.length,
    digest: b64u(digest),
  });
  for (let offset = 0, seq = 0; offset < bytes.length; offset += 32768, seq++) {
    add(`${file}:chunk:${seq}`, {
      type: 'image_upload_chunk',
      transferId,
      seq,
      data: b64u(bytes.subarray(offset, offset + 32768)),
    });
    add(`${file}:ack:${seq}`, {
      type: 'image_upload_chunk_ack',
      ...response,
      transferId,
      seq,
      receivedBytes: Math.min(bytes.length, offset + 32768),
    });
  }
  add(`${file}:result`, {
    type: 'image_upload_result',
    ...response,
    transferId,
    artifactId,
    outcome: 'staged',
    artifactExpiresAt: '2026-10-12T12:00:00.000Z',
    byteLength: bytes.length,
    mediaType,
    digest: b64u(digest),
  });
  return { file, bytes: bytes.length, sha256: digest.toString('hex') };
});
add('accepted', {
  type: 'image_upload_accepted',
  ...response,
  transferId,
  expiresAt: '2026-10-11T12:05:00.000Z',
});
add('complete', { type: 'image_upload_complete', transferId });
add('cancel', { type: 'image_upload_cancel', transferId });
add('cancelled', {
  type: 'image_upload_cancel_result',
  ...response,
  transferId,
  outcome: 'cancelled',
});
for (const [index, code] of IMAGE_STAGING_REFUSAL_CODES.entries()) {
  add(`refused:${code}`, {
    type: 'image_upload_refused',
    ...response,
    operation: [
      'image_upload_begin',
      'image_upload_chunk',
      'image_upload_complete',
      'image_upload_cancel',
    ][index % 4],
    code,
  });
}
const begin = positive[0]?.expected as unknown as Record<string, unknown>;
const chunk = positive[1]?.expected as unknown as Record<string, unknown>;
const result = positive.find((v) => v.name === 'fixture.png:result')?.expected as unknown as Record<
  string,
  unknown
>;
const bad = (name: string, value: unknown) => negative.push({ name, raw: JSON.stringify(value) });
const edit = (base: Record<string, unknown>, key: string, value: unknown) => ({
  ...base,
  [key]: value,
});
for (const v of [...positive]) {
  const seed =
    v.expected.type === 'image_upload_chunk'
      ? { ...v.expected, data: b64u(fromB64u(v.expected.data).subarray(0, 1)) }
      : v.expected;
  bad(`${v.name}:unknown`, { ...seed, extra: true });
  for (const key of Object.keys(seed)) {
    const copy = { ...seed } as Record<string, unknown>;
    delete copy[key];
    bad(`${v.name}:missing:${key}`, copy);
    bad(`${v.name}:wrong-type:${key}`, edit(seed as unknown as Record<string, unknown>, key, []));
  }
}
for (const id of [
  '',
  envelope.id.toUpperCase(),
  envelope.id.replace('-4677-', '-7677-'),
  '00112233-4455-4677-0899-aabbccddeeff',
])
  bad(`bad-id:${id}`, edit(begin, 'id', id));
for (const value of [
  '',
  '2026-02-29T12:00:00.000Z',
  '2026-10-11T24:00:00.000Z',
  '2026-10-11T12:00:00Z',
  '2026-10-11T12:00:00.000+00:00',
])
  bad(`bad-date:${value}`, edit(begin, 'timestamp', value));
for (const value of [0, -1, 10485761, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1])
  bad(`bad-length:${value}`, edit(begin, 'byteLength', value));
for (const value of [-1, 320, 0.5, '0', null])
  bad(`bad-sequence:${value}`, edit(chunk, 'seq', value));
for (const [index, value] of [
  '',
  'AQ=',
  'AR',
  'A Q',
  'AQ\n',
  '+w',
  '/w',
  'A',
  b64u(new Uint8Array(32769)),
].entries())
  bad(`bad-data:${index}`, edit(chunk, 'data', value));
for (const key of ['transferId', 'digest']) {
  const base = key === 'digest' ? begin : chunk;
  for (const value of [
    '',
    'A'.repeat(key === 'digest' ? 42 : 21),
    'B'.repeat(key === 'digest' ? 43 : 22),
  ])
    bad(`bad-encoding:${key}:${value.length}`, edit(base, key, value));
}
for (const text of [
  '',
  '\ud800',
  '\udfff',
  'a'.repeat(201),
  '🌱'.repeat(51),
  '\u0000',
  '\u001f',
  '\u007f',
  '\u0080',
  '\u009f',
])
  bad(
    `bad-binding:${JSON.stringify(text)}`,
    edit(begin, 'binding', { ...binding, harnessSessionId: text }),
  );
bad('binding-extra', edit(begin, 'binding', { ...binding, extra: true }));
bad('binding-harness', edit(begin, 'binding', { ...binding, harness: 'codex' }));
bad('same-artifact', edit(result, 'artifactId', transferId));
bad('media', edit(begin, 'mediaType', 'image/gif'));
bad('result-outcome', edit(result, 'outcome', 'delivered'));
bad('cancel-outcome', {
  ...envelope,
  ...response,
  type: 'image_upload_cancel_result',
  transferId,
  outcome: 'staged',
});
bad('refusal-operation', {
  ...envelope,
  ...response,
  type: 'image_upload_refused',
  operation: 'image_upload_accepted',
  code: 'busy',
});
bad('refusal-code', {
  ...envelope,
  ...response,
  type: 'image_upload_refused',
  operation: 'image_upload_begin',
  code: 'unknown',
});
const rawBegin = JSON.stringify(begin);
negative.push({
  name: 'duplicate-binding',
  raw: rawBegin.replace('"harness":"claude"', '"harness":"claude","harness":"claude"'),
});
negative.push({
  name: 'escaped-duplicate-binding',
  raw: rawBegin.replace('"harness":"claude"', '"harness":"claude","har\\u006eess":"claude"'),
});
negative.push({
  name: 'duplicate-root',
  raw: rawBegin.replace('"id":', '"id":"00112233-4455-4677-8899-aabbccddeeff","id":'),
});
const [beforeBinding, afterBinding] = rawBegin.split('session-🌱') as [string, string];
negative.push({
  name: 'raw-surrogate',
  bytes: [...Buffer.from(beforeBinding), 0xed, 0xa0, 0x80, ...Buffer.from(afterBinding)],
});
negative.push({
  name: 'oversized-frame',
  raw: rawBegin + ' '.repeat(65537 - Buffer.byteLength(rawBegin)),
});
const multibyteBegin = JSON.stringify({
  ...begin,
  binding: { ...binding, harnessSessionId: '🌱'.repeat(50) },
});
negative.push({
  name: 'oversized-utf8',
  raw: multibyteBegin + ' '.repeat(65537 - Buffer.byteLength(multibyteBegin)),
});
for (const raw of [
  '',
  'null',
  '[]',
  '{}',
  `${rawBegin}{}`,
  rawBegin.slice(0, -1),
  rawBegin.replace('4774', 'NaN'),
  rawBegin.replace('4774', '1e999'),
  rawBegin.replace('4774', '01'),
])
  negative.push({ name: `malformed:${negative.length}`, raw });
for (const bytes of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]])
  negative.push({ name: `invalid-utf8:${bytes.join('-')}`, bytes });
for (const [name, fields] of [
  ['binding-200-ascii', { ...begin, binding: { ...binding, harnessSessionId: 'a'.repeat(200) } }],
  ['binding-200-utf8', { ...begin, binding: { ...binding, harnessSessionId: '🌱'.repeat(50) } }],
  ['max-chunk-sequence', { ...chunk, seq: 319, data: b64u(new Uint8Array(32768)) }],
  ['minimum-chunk', { ...chunk, seq: 0, data: 'AQ' }],
  ['maximum-declaration', { ...begin, byteLength: 10485760 }],
  ['minimum-declaration', { ...begin, byteLength: 1 }],
] as const)
  add(name, fields);
positive.push({
  name: 'frame-65536',
  raw: rawBegin + ' '.repeat(65536 - Buffer.byteLength(rawBegin)),
  expected: begin as unknown as ImageStagingMessage,
});
positive.push({
  name: 'member-order-whitespace',
  raw: JSON.stringify(Object.fromEntries(Object.entries(begin).reverse()), null, 2),
  expected: begin as unknown as ImageStagingMessage,
});
writeFileSync(
  `${directory}vectors.json`,
  `${JSON.stringify({ version: 1, images, positive, negative }, null, 2)}\n`,
);
