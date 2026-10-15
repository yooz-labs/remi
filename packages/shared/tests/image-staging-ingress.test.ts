import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isBrowserLinkCandidate, isImageStagingCandidate } from '../src/image-staging-ingress.ts';
import {
  type ImageStagingOperation,
  type ImageStagingRequest,
  decodeImageStagingFrame,
  decodeImageStagingIngress,
} from '../src/image-staging.ts';
import vectors from './fixtures/image-staging/vectors.json';

const operations = new Set<ImageStagingOperation>([
  'image_upload_begin',
  'image_upload_chunk',
  'image_upload_complete',
  'image_upload_cancel',
]);
const begin = vectors.positive.find((v) => v.name === 'fixture.png:begin');
const complete = vectors.positive.find((v) => v.name === 'complete');
const cancel = vectors.positive.find((v) => v.name === 'cancel');
const chunk = vectors.positive.find((v) => v.name === 'fixture.jpg:chunk:0');
if (!begin || !complete || !cancel || !chunk)
  throw new Error('Missing owned image staging fixtures');
const inputs = (raw: string): (string | Uint8Array)[] => [raw, new TextEncoder().encode(raw)];

test('optional browser prefix scans original escaped/duplicate/late types without capturing nested data', () => {
  for (const raw of [
    '{"type":"browser_link_receiver_request"}',
    '{"t\\u0079pe":"browser\\u005flink_receiver_request"}',
    '{"type":"hello","type":"browser_link_receiver_request"}',
    '{"type":"browser_link_receiver_request","type":"hello"}',
    JSON.stringify({ padding: 'x'.repeat(65536), type: 'browser_link_receiver_request' }),
  ])
    for (const input of inputs(raw)) expect(isBrowserLinkCandidate(input)).toBe(true);
  for (const raw of [
    '{"type":"hello"}',
    '{"nested":{"type":"browser_link_receiver_request"}}',
    '{"url":"browser_link_receiver_request"}',
  ])
    for (const input of inputs(raw)) expect(isBrowserLinkCandidate(input)).toBe(false);
});

describe('actual pure staging candidacy and strict ingress', () => {
  for (const vector of vectors.positive)
    test(`routes owned golden ${vector.name}`, () => {
      for (const input of inputs(vector.raw)) {
        expect(isImageStagingCandidate(input)).toBe(true);
        const result = decodeImageStagingIngress(input);
        if (operations.has(vector.expected.type as ImageStagingOperation))
          expect(result).toEqual({
            kind: 'request',
            request: vector.expected as ImageStagingRequest,
          });
        else expect(result).toEqual({ kind: 'uncorrelatable' });
      }
    });
  for (const vector of vectors.negative)
    test(`never accepts negative golden ${vector.name}`, () => {
      const frames = 'raw' in vector ? inputs(vector.raw) : [Uint8Array.from(vector.bytes)];
      for (const input of frames) {
        expect(decodeImageStagingFrame(input)).toBeNull();
        expect(decodeImageStagingIngress(input).kind).not.toBe('request');
      }
    });

  test('matches escaped root keys/values and member order with the same strict request', () => {
    const object = JSON.parse(begin.raw);
    const { type, ...fields } = object;
    for (const raw of [
      begin.raw.replace('"type"', '"t\\u0079pe"'),
      begin.raw.replace('"type"', '"\\u0074\\u0079\\u0070\\u0065"'),
      begin.raw.replace('image_upload_begin', 'image\\u005fupload\\u005fbegin'),
      JSON.stringify({ ...fields, type }),
    ])
      for (const input of inputs(raw)) {
        expect(isImageStagingCandidate(input)).toBe(true);
        expect(decodeImageStagingIngress(input)).toEqual({
          kind: 'request',
          request: begin.expected as ImageStagingRequest,
        });
      }
  });

  test('considers every duplicate root type in either order, including escaped duplicate keys', () => {
    for (const prefix of ['"type":"hello",', '"t\\u0079pe":"hello",'])
      for (const raw of [
        `{${prefix}${begin.raw.slice(1)}`,
        `${begin.raw.slice(0, -1)},${prefix.slice(0, -1)}}`,
      ])
        for (const input of inputs(raw)) {
          expect(isImageStagingCandidate(input)).toBe(true);
          expect(decodeImageStagingIngress(input)).toEqual({ kind: 'uncorrelatable' });
        }
  });

  test('ignores nested types, quoted text, empty strings and non-string root type values', () => {
    for (const raw of [
      JSON.stringify({ type: 'hello', payload: begin.expected, empty: '' }),
      JSON.stringify({ payload: [begin.expected], type: 'hello' }),
      JSON.stringify({ type: 'hello', text: begin.raw }),
      JSON.stringify({ type: ['image_upload_begin'] }),
      JSON.stringify({ type: { type: 'image_upload_begin' } }),
      JSON.stringify([{ type: 'image_upload_begin' }]),
      '{"type":"image_upload", "notype":"image_upload_begin"}',
      '{"type":"hello", "image_upload_begin":"type"}',
    ])
      for (const input of inputs(raw)) expect(isImageStagingCandidate(input)).toBe(false);
  });

  test('finds a staging type after oversized owned chunk data without capping ordinary frames', () => {
    const object = JSON.parse(chunk.raw);
    const { type, data, ...fields } = object;
    const oversized = data.repeat(8);
    for (const raw of [
      JSON.stringify({ data: oversized, ...fields, type }),
      JSON.stringify({ data: oversized, ...fields, type }).replace('"type"', '"t\\u0079pe"'),
    ])
      for (const input of inputs(raw)) {
        expect(input.length).toBeGreaterThan(65536);
        expect(isImageStagingCandidate(input)).toBe(true);
        expect(decodeImageStagingIngress(input)).toEqual({ kind: 'uncorrelatable' });
      }
    const ordinary = JSON.stringify({ data: oversized, type: 'hello', text: begin.raw });
    for (const input of inputs(ordinary)) {
      expect(input.length).toBeGreaterThan(65536);
      expect(isImageStagingCandidate(input)).toBe(false);
    }
  });

  test('unknown staging operations and recognizable partial frames select strict refusal', () => {
    for (const raw of [
      begin.raw.replace('image_upload_begin', 'image_upload_unknown'),
      '{"type":"image_upload_begin"',
      '{"type":"image_upload_',
      '{"t\\u0079pe":"image\\u005fupload\\u005f',
      `${begin.raw} trailing`,
    ])
      for (const input of inputs(raw)) {
        expect(isImageStagingCandidate(input)).toBe(true);
        expect(decodeImageStagingIngress(input)).toEqual({ kind: 'uncorrelatable' });
      }
  });

  test('malformed bodies correlate only the exact guarded envelope and optional transfer hint', () => {
    for (const vector of [begin, complete, chunk, cancel]) {
      const object = JSON.parse(vector.raw);
      const malformed = JSON.stringify({ ...object, extra: 'owned invalid field' });
      for (const input of inputs(malformed))
        expect(decodeImageStagingIngress(input)).toEqual({
          kind: 'malformed',
          correlation: {
            operation: object.type,
            requestId: object.id,
            sessionId: object.sessionId,
            transferId: object.type === 'image_upload_begin' ? null : object.transferId,
          },
        });
    }
    const object = JSON.parse(complete.raw);
    for (const transferId of ['?', 'AA', '', 1, null])
      expect(decodeImageStagingIngress(JSON.stringify({ ...object, transferId }))).toEqual({
        kind: 'malformed',
        correlation: {
          operation: object.type,
          requestId: object.id,
          sessionId: object.sessionId,
          transferId: null,
        },
      });
    // Body encoding guards throw; the already-strict envelope still gives a safe refusal correlation.
    const badData = JSON.stringify({ ...JSON.parse(chunk.raw), data: '?' });
    expect(decodeImageStagingIngress(badData).kind).toBe('malformed');
  });

  test('bad or ambiguous envelope fields never supply correlation', () => {
    const original = JSON.parse(begin.raw);
    for (const key of ['type', 'id', 'timestamp', 'sessionId']) {
      const object = { ...original };
      delete object[key];
      expect(decodeImageStagingIngress(JSON.stringify(object))).toEqual({ kind: 'uncorrelatable' });
    }
    for (const replacement of [
      { id: 'not-an-id' },
      { id: original.id.toUpperCase() },
      { id: `${original.id.slice(0, 14)}3${original.id.slice(15)}` },
      { sessionId: 'not-a-session' },
      { timestamp: '2026-99-01T00:00:00.000Z' },
      { timestamp: '2026-10-12T00:00:00Z' },
      { type: 'image_upload_result' },
    ])
      expect(decodeImageStagingIngress(JSON.stringify({ ...original, ...replacement }))).toEqual({
        kind: 'uncorrelatable',
      });
    expect(decodeImageStagingIngress(`${begin.raw.slice(0, -1)},"id":"${original.id}"}`)).toEqual({
      kind: 'uncorrelatable',
    });
  });

  test('strict correlation rejects escaped non-scalars even in unknown keys/nested body fields', () => {
    for (const suffix of [
      ',"extra":"\\ud800"}',
      ',"extra":{"text":"\\udc00"}}',
      ',"\\ud800":"owned"}',
      ',"extra":["\\ud800"]}',
    ])
      for (const input of inputs(begin.raw.slice(0, -1) + suffix)) {
        expect(isImageStagingCandidate(input)).toBe(true);
        expect(decodeImageStagingIngress(input)).toEqual({ kind: 'uncorrelatable' });
      }
    const raw = begin.raw.replace('session-🌱', String.fromCharCode(0xd800));
    expect(isImageStagingCandidate(raw)).toBe(true);
    expect(decodeImageStagingIngress(raw)).toEqual({ kind: 'uncorrelatable' });
    const encoded = new TextEncoder().encode(begin.raw);
    const malformed = Uint8Array.from([
      ...encoded.slice(0, -1),
      0xff,
      encoded[encoded.length - 1] ?? 0,
    ]);
    expect(isImageStagingCandidate(malformed)).toBe(true);
    expect(decodeImageStagingIngress(malformed)).toEqual({ kind: 'uncorrelatable' });
  });

  test('probe source retains fixed scalar state and no input conversion or copied payload', () => {
    const source = readFileSync(
      new URL('../src/image-staging-ingress.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/JSON\.parse|new Text(?:Encoder|Decoder)|\.slice\(|\.split\(/);
    expect(source).not.toMatch(/new (?:Set|Map|Array)|fromUtf8\(|fromB64u\(|utf8\(/);
  });
});
