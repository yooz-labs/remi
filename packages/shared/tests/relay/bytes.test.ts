import { describe, expect, test } from 'bun:test';
import { be64, concat, readBe64, utf8, zero } from '../../src/relay/bytes.ts';
import * as r from '../../src/relay/internal.ts';
import { codeOfSync, hex, unhex } from './helpers.ts';

describe('relay v2 byte helpers', () => {
  test('lps prefixes every part with its big-endian 16-bit length', () => {
    expect(hex(r.lps('ab', unhex('ff')))).toBe('0002616200' + '01ff');
    expect(hex(r.lps(''))).toBe('0000');
  });

  test('lps refuses a part longer than 65535 bytes', () => {
    expect(codeOfSync(() => r.lps(new Uint8Array(65536)))).toBe('MALFORMED');
    expect(r.lps(new Uint8Array(65535)).length).toBe(65537);
  });

  test('be64 and readBe64 round trip and agree on the byte layout', () => {
    expect(hex(be64(0))).toBe('0000000000000000');
    expect(hex(be64(1))).toBe('0000000000000001');
    expect(hex(be64(2 ** 40))).toBe('0000010000000000');
    expect(hex(be64(2 ** 32 + 5))).toBe('0000000100000005');
    for (const n of [0, 1, 255, 2 ** 32 - 1, 2 ** 32, 2 ** 40, 2 ** 53 - 1]) {
      expect(readBe64(be64(n), 0)).toBe(n);
    }
  });

  test('readBe64 reports a value that does not fit a safe integer as null, never a wrong number', () => {
    expect(readBe64(unhex('0020000000000000'), 0)).toBeNull();
    expect(readBe64(unhex('ffffffffffffffff'), 0)).toBeNull();
    expect(readBe64(unhex('001fffffffffffff'), 0)).toBe(2 ** 53 - 1);
  });

  test('base64url round trips and is unpadded', () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 65]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
      const encoded = r.b64u(bytes);
      expect(encoded).not.toContain('=');
      expect(hex(r.fromB64u(encoded))).toBe(hex(bytes));
    }
    expect(r.b64u(unhex('fbff'))).toBe('-_8');
  });

  test('strict base64url rejects padding, the standard alphabet, whitespace and a stray length', () => {
    for (const bad of ['QQ==', 'a+b/', 'ab cd', 'ab\n', 'A', 'AAAAA', 'é']) {
      expect(codeOfSync(() => r.fromB64u(bad))).toBe('MALFORMED');
    }
  });

  test('strict base64url rejects non-canonical trailing bits', () => {
    // "QR" decodes to the same byte as "QQ" but sets the unused low bits.
    expect(hex(r.fromB64u('QQ'))).toBe('41');
    expect(codeOfSync(() => r.fromB64u('QR'))).toBe('MALFORMED');
    expect(codeOfSync(() => r.fromB64u('AB'))).toBe('MALFORMED');
  });

  test('ctEqual compares content and length', () => {
    expect(r.ctEqual(unhex('0102'), unhex('0102'))).toBe(true);
    expect(r.ctEqual(unhex('0102'), unhex('0103'))).toBe(false);
    expect(r.ctEqual(unhex('0102'), unhex('010200'))).toBe(false);
    expect(r.ctEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  test('zero overwrites in place and ignores absent parts', () => {
    const a = unhex('0102');
    const b = unhex('ff');
    zero(a, undefined, null, b);
    expect(hex(a)).toBe('0000');
    expect(hex(b)).toBe('00');
  });

  test('concat joins parts in order', () => {
    expect(hex(concat(unhex('01'), new Uint8Array(0), unhex('0203')))).toBe('010203');
    expect(hex(utf8('A'))).toBe('41');
  });
});
