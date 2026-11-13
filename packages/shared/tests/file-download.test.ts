/** Structural codec tests only; no admission, copy, transfer-state, transport or native behavior. */
import { describe, expect, test } from 'bun:test';
import {
  FILE_DOWNLOAD_LIMITS,
  type FileDownloadMessage,
  type FileFetchAccepted,
  type FileFetchBegin,
  type FileFetchChunk,
  decodeFileDownloadFrame,
  encodeFileDownloadFrame,
} from '../src/file-download.ts';
import { fromB64u } from '../src/relay/bytes.ts';
import vectors from './fixtures/file-download/vectors.json';

describe('file-download structural codec and vectors (NOT admission/transfer/integrity/transport/native)', () => {
  for (const vector of vectors.positive as {
    name: string;
    raw: string;
    expected: FileDownloadMessage;
  }[])
    test(vector.name, () => {
      expect(decodeFileDownloadFrame(vector.raw)).toEqual(vector.expected);
      expect(decodeFileDownloadFrame(new TextEncoder().encode(vector.raw))).toEqual(
        vector.expected,
      );
      const encoded = encodeFileDownloadFrame(vector.expected);
      expect(encoded).toBe(vector.raw);
      expect(decodeFileDownloadFrame(encoded)).toEqual(vector.expected);
    });

  for (const vector of vectors.negative as (
    | { name: string; raw: string }
    | { name: string; bytes: number[] }
  )[])
    test(vector.name, () => {
      const input = 'raw' in vector ? vector.raw : Uint8Array.from(vector.bytes);
      expect(decodeFileDownloadFrame(input) === null).toBe(true);
    });

  test('structural path spellings decode unchanged; no filesystem access is tested or granted', () => {
    for (const name of [
      'begin-percent-spelling-and-non-uuid-codex-binding',
      'structural-only-dotted-credential-and-extension-path',
    ]) {
      const vector = vectors.positive.find((item) => item.name === name);
      const expected = vector?.expected as FileFetchBegin;
      const decoded = decodeFileDownloadFrame(vector?.raw ?? '');
      expect(decoded).toEqual(expected);
      expect(decoded?.type).toBe('file_fetch_begin');
      if (decoded?.type === 'file_fetch_begin')
        expect(decoded.relativePath).toBe(expected.relativePath);
    }
  });

  test('path component count and byte boundaries are exact and do not normalize spelling', () => {
    const begin = vectors.positive.find(
      (vector) => vector.name === 'begin-percent-spelling-and-non-uuid-codex-binding',
    )?.expected as FileFetchBegin;
    const sixtyFour = { ...begin, relativePath: Array(64).fill('x').join('/') };
    expect(decodeFileDownloadFrame(encodeFileDownloadFrame(sixtyFour))).toEqual(sixtyFour);

    const sixteenMaxComponents = {
      ...begin,
      relativePath: Array(16).fill('a'.repeat(255)).join('/'),
    };
    expect(new TextEncoder().encode(sixteenMaxComponents.relativePath).length).toBe(4095);
    expect(decodeFileDownloadFrame(encodeFileDownloadFrame(sixteenMaxComponents))).toEqual(
      sixteenMaxComponents,
    );

    const tooManyComponents = { ...begin, relativePath: Array(65).fill('x').join('/') };
    expect(decodeFileDownloadFrame(JSON.stringify(tooManyComponents))).toBeNull();
    const componentTooLong = { ...begin, relativePath: 'x'.repeat(256) };
    expect(decodeFileDownloadFrame(JSON.stringify(componentTooLong))).toBeNull();
    const multibyteComponentTooLong = { ...begin, relativePath: 'é'.repeat(128) };
    expect(decodeFileDownloadFrame(JSON.stringify(multibyteComponentTooLong))).toBeNull();
    const pathOverByteLimit = {
      ...begin,
      relativePath: Array(17).fill('x'.repeat(255)).join('/'),
    };
    expect(new TextEncoder().encode(pathOverByteLimit.relativePath).length).toBeGreaterThan(
      FILE_DOWNLOAD_LIMITS.relativePathBytes,
    );
    expect(decodeFileDownloadFrame(JSON.stringify(pathOverByteLimit))).toBeNull();
    const utf8PathOverByteLimit = {
      ...begin,
      relativePath: Array(17).fill('🌱'.repeat(63)).join('/'),
    };
    expect(utf8PathOverByteLimit.relativePath.length).toBeLessThan(
      FILE_DOWNLOAD_LIMITS.relativePathBytes,
    );
    expect(new TextEncoder().encode(utf8PathOverByteLimit.relativePath).length).toBeGreaterThan(
      FILE_DOWNLOAD_LIMITS.relativePathBytes,
    );
    expect(decodeFileDownloadFrame(JSON.stringify(utf8PathOverByteLimit)) === null).toBe(true);
  });

  test('file names and binding strings use their own UTF-8 byte limits', () => {
    const accepted = vectors.positive.find(
      (vector) => vector.name === 'accepted-maximum-file-and-inert-hidden-basename',
    )?.expected as FileFetchAccepted;
    const maximumName = { ...accepted, fileName: 'n'.repeat(FILE_DOWNLOAD_LIMITS.fileNameBytes) };
    expect(decodeFileDownloadFrame(encodeFileDownloadFrame(maximumName))).toEqual(maximumName);
    const multibyteNameAtLimit = { ...accepted, fileName: 'é'.repeat(127).concat('x') };
    expect(new TextEncoder().encode(multibyteNameAtLimit.fileName).length).toBe(255);
    expect(decodeFileDownloadFrame(encodeFileDownloadFrame(multibyteNameAtLimit))).toEqual(
      multibyteNameAtLimit,
    );
    const multibyteNameOverLimit = { ...accepted, fileName: 'é'.repeat(128) };
    expect(multibyteNameOverLimit.fileName.length).toBeLessThan(FILE_DOWNLOAD_LIMITS.fileNameBytes);
    expect(new TextEncoder().encode(multibyteNameOverLimit.fileName).length).toBe(256);
    expect(decodeFileDownloadFrame(JSON.stringify(multibyteNameOverLimit))).toBeNull();
    const longName = { ...accepted, fileName: 'n'.repeat(FILE_DOWNLOAD_LIMITS.fileNameBytes + 1) };
    expect(decodeFileDownloadFrame(JSON.stringify(longName))).toBeNull();

    const begin = vectors.positive.find(
      (vector) => vector.name === 'begin-percent-spelling-and-non-uuid-codex-binding',
    )?.expected as FileFetchBegin;
    const maximumBinding = {
      ...begin,
      binding: { harness: 'codex' as const, harnessSessionId: 'x'.repeat(200) },
    };
    expect(decodeFileDownloadFrame(encodeFileDownloadFrame(maximumBinding))).toEqual(
      maximumBinding,
    );
    const unicodeBinding = {
      ...begin,
      binding: { harness: 'claude' as const, harnessSessionId: '🌱'.repeat(50) },
    };
    expect(new TextEncoder().encode(unicodeBinding.binding.harnessSessionId).length).toBe(200);
    expect(decodeFileDownloadFrame(encodeFileDownloadFrame(unicodeBinding))).toEqual(
      unicodeBinding,
    );
    const longUnicodeBinding = {
      ...begin,
      binding: { harness: 'codex' as const, harnessSessionId: '🌱'.repeat(51) },
    };
    expect(longUnicodeBinding.binding.harnessSessionId.length).toBeLessThan(
      FILE_DOWNLOAD_LIMITS.bindingBytes,
    );
    expect(
      new TextEncoder().encode(longUnicodeBinding.binding.harnessSessionId).length,
    ).toBeGreaterThan(FILE_DOWNLOAD_LIMITS.bindingBytes);
    expect(decodeFileDownloadFrame(JSON.stringify(longUnicodeBinding))).toBeNull();
    const longBinding = {
      ...begin,
      binding: { harness: 'claude' as const, harnessSessionId: 'x'.repeat(201) },
    };
    expect(decodeFileDownloadFrame(JSON.stringify(longBinding))).toBeNull();
  });

  test('JSON escaping can expand a legal path while the encoded frame remains bounded', () => {
    const begin = vectors.positive.find(
      (vector) => vector.name === 'begin-percent-spelling-and-non-uuid-codex-binding',
    )?.expected as FileFetchBegin;
    const path = Array(16).fill('"'.repeat(255)).join('/');
    const value = { ...begin, relativePath: path };
    const rawPathBytes = new TextEncoder().encode(path).length;
    const frame = encodeFileDownloadFrame(value);
    const frameBytes = new TextEncoder().encode(frame).length;
    expect(rawPathBytes).toBe(4095);
    expect(frameBytes).toBeGreaterThan(rawPathBytes);
    expect(frameBytes).toBeLessThanOrEqual(FILE_DOWNLOAD_LIMITS.frameBytes);
    expect(decodeFileDownloadFrame(frame)).toEqual(value);
  });

  test('maximum canonical chunk data stays within the raw frame limit', () => {
    const base = vectors.positive.find((vector) => vector.name === 'chunk-one-decoded-byte')
      ?.expected as FileFetchChunk;
    const data = 'A'.repeat(Math.ceil((FILE_DOWNLOAD_LIMITS.chunkBytes * 4) / 3));
    expect(fromB64u(data).length).toBe(FILE_DOWNLOAD_LIMITS.chunkBytes);
    const maximumChunk = { ...base, data };
    const frame = encodeFileDownloadFrame(maximumChunk);
    expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(
      FILE_DOWNLOAD_LIMITS.frameBytes,
    );
    expect(decodeFileDownloadFrame(frame)).toEqual(maximumChunk);
    expect(() => encodeFileDownloadFrame({ ...maximumChunk, data: data.concat('A') })).toThrow(
      'Invalid file download frame',
    );
  });

  test('the maximum file length and sequence encode the declared 320 chunk slots', () => {
    expect(FILE_DOWNLOAD_LIMITS.fileBytes / FILE_DOWNLOAD_LIMITS.chunkBytes).toBe(320);
    expect(FILE_DOWNLOAD_LIMITS.maxSequence + 1).toBe(320);
  });

  test('raw frame limits check original UTF-8 bytes and scalar text', () => {
    expect(decodeFileDownloadFrame(' '.repeat(FILE_DOWNLOAD_LIMITS.frameBytes + 1))).toBeNull();
    expect(decodeFileDownloadFrame(new Uint8Array(FILE_DOWNLOAD_LIMITS.frameBytes + 1))).toBeNull();
    expect(decodeFileDownloadFrame('🌱'.repeat(16385))).toBeNull();
    expect(decodeFileDownloadFrame(String.fromCharCode(0xd800))).toBeNull();
  });

  test('encoder rejects JSON-coerced runtime values with one payload-free error', () => {
    const begin = vectors.positive.find(
      (vector) => vector.name === 'begin-percent-spelling-and-non-uuid-codex-binding',
    )?.expected as FileFetchBegin;
    const accepted = vectors.positive.find(
      (vector) => vector.name === 'accepted-maximum-file-and-inert-hidden-basename',
    )?.expected as FileFetchAccepted;
    const invalid: unknown[] = [
      { ...begin, relativePath: undefined },
      { ...begin, unrecognized: undefined },
      { ...begin, relativePath: 'C:/private/secret.txt' },
      { ...accepted, byteLength: Number.NaN },
      { ...accepted, byteLength: Number.POSITIVE_INFINITY },
      { ...accepted, fileName: 'private-customer-name.txt', byteLength: 0 },
      { ...begin, relativePath: String.fromCharCode(0x62, 0x61, 0x64, 0xd800) },
      { ...begin, [Symbol('extra-field')]: 'secret value' },
      { ...begin, id: Symbol('not-a-wire-id') },
      { ...begin, id: 1n },
      { ...begin, toJSON: () => begin },
    ];
    for (const value of invalid) {
      let thrown: unknown;
      try {
        encodeFileDownloadFrame(value as FileDownloadMessage);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('Invalid file download frame');
      expect((thrown as Error).message).not.toContain('private');
      expect((thrown as Error).message).not.toContain('secret');
    }
  });
});
