import { expect, test } from 'bun:test';
import { decodeFileDownloadIngress } from '../src/file-download-ingress.ts';
import { FILE_DOWNLOAD_OPERATIONS, decodeFileDownloadFrame } from '../src/file-download.ts';
import { isFileDownloadCandidate } from '../src/image-staging-ingress.ts';
import vectors from './fixtures/file-download/vectors.json';

const inputs = (raw: string): (string | Uint8Array)[] => [raw, new TextEncoder().encode(raw)];
const begin = vectors.positive.find((v) => v.expected.type === 'file_fetch_begin');
const read = vectors.positive.find((v) => v.expected.type === 'file_fetch_read');
const cancel = vectors.positive.find((v) => v.expected.type === 'file_fetch_cancel');
if (!begin || !read || !cancel) throw new Error('Missing frozen file-download vectors');

test('original file prefix routes every frozen shape, while only four client operations decode', () => {
  for (const vector of vectors.positive)
    for (const input of inputs(vector.raw)) {
      expect(isFileDownloadCandidate(input)).toBe(true);
      expect(decodeFileDownloadFrame(input) as unknown).toEqual(vector.expected);
      expect(decodeFileDownloadIngress(input) as unknown).toEqual(
        FILE_DOWNLOAD_OPERATIONS.some((type) => type === vector.expected.type)
          ? { kind: 'request', request: vector.expected }
          : { kind: 'uncorrelatable' },
      );
    }
});

test('all frozen codec counterexamples stay rejected by strict original ingress', () => {
  for (const vector of vectors.negative) {
    const frames = 'raw' in vector ? inputs(vector.raw) : [Uint8Array.from(vector.bytes)];
    for (const frame of frames) expect(decodeFileDownloadIngress(frame).kind).not.toBe('request');
  }
});

test('scanner finds escaped, duplicate and late root types without routing nested text', () => {
  for (const raw of [
    begin.raw.replace('"type"', '"t\\u0079pe"').replace('file_fetch_', 'file\\u005ffetch_'),
    `{"type":"hello",${begin.raw.slice(1)}`,
    `${begin.raw.slice(0, -1)},"t\\u0079pe":"hello"}`,
    JSON.stringify({ padding: 'x'.repeat(65536), type: 'file_fetch_begin' }),
    '{"type":"file_fetch_',
  ])
    for (const frame of inputs(raw)) expect(isFileDownloadCandidate(frame)).toBe(true);
  for (const raw of [
    JSON.stringify({ type: 'hello', nested: JSON.parse(begin.raw) }),
    JSON.stringify({ text: begin.raw }),
    JSON.stringify({ type: ['file_fetch_begin'] }),
  ])
    for (const frame of inputs(raw)) expect(isFileDownloadCandidate(frame)).toBe(false);
});

test('malformed bodies retain only canonical correlation hints; cancel uses original beginId', () => {
  for (const [vector, patch, hints] of [
    [read, { seq: 320 }, { transferId: read.expected.transferId, beginId: null }],
    [read, { transferId: 'not-a-transfer' }, { transferId: null, beginId: null }],
    [cancel, { extra: true }, { transferId: null, beginId: cancel.expected.beginId }],
    [cancel, { beginId: 'invalid' }, { transferId: null, beginId: null }],
  ] as const) {
    const raw = JSON.stringify({ ...vector.expected, ...patch });
    for (const frame of inputs(raw))
      expect(decodeFileDownloadIngress(frame) as unknown).toEqual({
        kind: 'malformed',
        correlation: {
          operation: vector.expected.type,
          requestId: vector.expected.id,
          sessionId: vector.expected.sessionId,
          ...hints,
        },
      });
  }
});

test('duplicate decoded envelope, scalar/UTF8/BOM, missing identity and excess bounds are uncorrelatable', () => {
  for (const raw of [
    `{"type":"hello",${begin.raw.slice(1)}`,
    `${begin.raw.slice(0, -1)},"t\\u0079pe":"hello"}`,
    begin.raw.replace(begin.expected.id, 'bad-id'),
    begin.raw.replace(begin.expected.id, '\\ud800'),
    begin.raw.replace('"sessionId"', '"missingSession"'),
    `\ufeff${begin.raw}`,
    JSON.stringify({ ...begin.expected, extra: 'x'.repeat(65536) }),
    JSON.stringify({
      ...begin.expected,
      nested: JSON.parse(`${'['.repeat(70)}0${']'.repeat(70)}`),
    }),
  ])
    for (const frame of inputs(raw))
      expect(decodeFileDownloadIngress(frame) as unknown).toEqual({ kind: 'uncorrelatable' });
  const invalid = new Uint8Array([...new TextEncoder().encode(begin.raw.slice(0, -1)), 255, 125]);
  expect(isFileDownloadCandidate(invalid)).toBe(true);
  expect(decodeFileDownloadIngress(invalid)).toEqual({ kind: 'uncorrelatable' });
});
