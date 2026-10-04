import { describe, expect, test } from 'bun:test';
import { b64u } from '../../src/relay/bytes.ts';
import { decodeDataFrame, encodeDataFrame } from '../../src/relay/envelope.ts';
import * as r from '../../src/relay/internal.ts';
import { codeOfSync, hex, seed, text } from './helpers.ts';

const E = new Uint8Array(65).fill(7);
E[0] = 4;
const N = seed('envelope nonce');
const S = new Uint8Array(64).fill(9);
const C_AUTH = new Uint8Array(112).fill(3);
const C_READY = new Uint8Array(17).fill(4);

const hello = (patch: Record<string, unknown> = {}, drop: string[] = []): string => {
  const o: Record<string, unknown> = {
    v: 2,
    t: 'hello',
    m: 'pair',
    e: b64u(E),
    n: b64u(N),
    ...patch,
  };
  for (const k of drop) delete o[k];
  return JSON.stringify(o);
};

describe('control frame encoding', () => {
  test('hello has the documented canonical form and round trips', () => {
    const frame = r.encodeHello('pair', E, N);
    expect(frame).toBe(`{"v":2,"t":"hello","m":"pair","e":"${b64u(E)}","n":"${b64u(N)}"}`);
    const decoded = r.decodeHello(frame);
    expect(decoded.mode).toBe('pair');
    expect(hex(decoded.ephemeral)).toBe(hex(E));
    expect(hex(decoded.nonce)).toBe(hex(N));
    expect(r.decodeHello(r.encodeHello('resume', E, N)).mode).toBe('resume');
  });

  test('hello_ack, auth and ready have the documented canonical forms and round trip', () => {
    const ack = r.encodeHelloAck(E, N, S);
    expect(ack).toBe(`{"v":2,"t":"hello_ack","e":"${b64u(E)}","n":"${b64u(N)}","s":"${b64u(S)}"}`);
    const d = r.decodeHelloAck(ack);
    expect([hex(d.ephemeral), hex(d.nonce), hex(d.signature)]).toEqual([hex(E), hex(N), hex(S)]);
    expect(r.encodeSealedControl('auth', C_AUTH)).toBe(`{"v":2,"t":"auth","c":"${b64u(C_AUTH)}"}`);
    expect(hex(r.decodeSealedControl(r.encodeSealedControl('auth', C_AUTH), 'auth'))).toBe(
      hex(C_AUTH),
    );
    expect(hex(r.decodeSealedControl(r.encodeSealedControl('ready', C_READY), 'ready'))).toBe(
      hex(C_READY),
    );
  });

  test('auth accepts exactly the documented ciphertext lengths', () => {
    for (const len of [112, 176]) {
      const frame = r.encodeSealedControl('auth', new Uint8Array(len));
      expect(r.decodeSealedControl(frame, 'auth').length).toBe(len);
    }
    for (const len of [0, 111, 177]) {
      const frame = r.encodeSealedControl('auth', new Uint8Array(len));
      expect(codeOfSync(() => r.decodeSealedControl(frame, 'auth'))).toBe('MALFORMED');
    }
    expect(
      codeOfSync(() =>
        r.decodeSealedControl(r.encodeSealedControl('ready', new Uint8Array(16)), 'ready'),
      ),
    ).toBe('MALFORMED');
  });
});

describe('strict control frame decoding', () => {
  test('a frame that is not a string is TYPE (a binary frame where text is expected)', () => {
    expect(codeOfSync(() => r.decodeHello(new Uint8Array(10)))).toBe('TYPE');
    expect(codeOfSync(() => r.decodeHello(undefined))).toBe('TYPE');
  });

  test('a frame over the control limit is OVERSIZE, even if it is garbage', () => {
    expect(codeOfSync(() => r.decodeHello('x'.repeat(r.MAX_CONTROL_TEXT + 1)))).toBe('OVERSIZE');
    expect(codeOfSync(() => r.decodeHello('x'.repeat(r.MAX_CONTROL_TEXT)))).toBe('MALFORMED');
  });

  test('the control limit counts UTF-8 bytes, not characters', () => {
    expect(codeOfSync(() => r.decodeHello('\u00e9'.repeat(300)))).toBe('OVERSIZE');
    expect(codeOfSync(() => r.decodeHello('\u00e9'.repeat(256)))).toBe('MALFORMED');
  });

  test('text that is not a JSON object is MALFORMED', () => {
    for (const bad of [
      '',
      'nope',
      '[]',
      'null',
      '2',
      '"hello"',
      '{"v":2,"t":"hello"',
      '{"v":2}}',
    ]) {
      expect(codeOfSync(() => r.decodeHello(bad))).toBe('MALFORMED');
    }
  });

  test('a missing or non-integer version is MALFORMED, any other integer is VERSION', () => {
    for (const patch of [{ v: '2' }, { v: 2.5 }, { v: null }, { v: [2] }]) {
      expect(codeOfSync(() => r.decodeHello(hello(patch)))).toBe('MALFORMED');
    }
    expect(codeOfSync(() => r.decodeHello(hello({}, ['v'])))).toBe('MALFORMED');
    for (const v of [0, 1, 3, 255, -2]) {
      expect(codeOfSync(() => r.decodeHello(hello({ v })))).toBe('VERSION');
    }
  });

  test('the version is checked before the rest of the frame is trusted to have a shape', () => {
    // A future version may have another layout, so nothing else is inspected.
    expect(codeOfSync(() => r.decodeHello('{"v":3,"t":"whatever"}'))).toBe('VERSION');
    expect(codeOfSync(() => r.decodeHello('{"v":1,"t":"hello","junk":true}'))).toBe('VERSION');
  });

  test('a type other than the expected one is TYPE, including every other control type', () => {
    for (const t of ['hello_ack', 'auth', 'ready', 'bye', '', 5, null]) {
      expect(codeOfSync(() => r.decodeHello(hello({ t })))).toBe('TYPE');
    }
    const ack = r.encodeHelloAck(E, N, S);
    expect(codeOfSync(() => r.decodeHello(ack))).toBe('TYPE');
    expect(codeOfSync(() => r.decodeHelloAck(r.encodeHello('pair', E, N)))).toBe('TYPE');
    expect(
      codeOfSync(() => r.decodeSealedControl(r.encodeSealedControl('auth', C_AUTH), 'ready')),
    ).toBe('TYPE');
  });

  test('a mode that is not pair or resume is MODE, missing included', () => {
    for (const m of ['PAIR', 'Resume', '', 'pairing', 1, null]) {
      expect(codeOfSync(() => r.decodeHello(hello({ m })))).toBe('MODE');
    }
    expect(codeOfSync(() => r.decodeHello(hello({}, ['m'])))).toBe('MODE');
  });

  test('an extra, a missing or a mistyped field is MALFORMED', () => {
    expect(codeOfSync(() => r.decodeHello(hello({ x: 'extra' })))).toBe('MALFORMED');
    expect(codeOfSync(() => r.decodeHello(hello({}, ['e'])))).toBe('MALFORMED');
    expect(codeOfSync(() => r.decodeHello(hello({}, ['n'])))).toBe('MALFORMED');
    expect(codeOfSync(() => r.decodeHello(hello({ e: 5 })))).toBe('MALFORMED');
    expect(codeOfSync(() => r.decodeHello(hello({ n: null })))).toBe('MALFORMED');
    const noSignature = JSON.stringify({ v: 2, t: 'hello_ack', e: b64u(E), n: b64u(N) });
    expect(codeOfSync(() => r.decodeHelloAck(noSignature))).toBe('MALFORMED');
  });

  test('a binary value that is not canonical base64url is MALFORMED', () => {
    const good = b64u(E);
    for (const e of [
      `${good}=`,
      `+${good.slice(1)}`,
      ` ${good}`,
      `${good}\n`,
      `${good}A`,
      'AAAA',
    ]) {
      expect(codeOfSync(() => r.decodeHello(hello({ e })))).toBe('MALFORMED');
    }
  });

  test('a binary value of the wrong length is MALFORMED', () => {
    expect(codeOfSync(() => r.decodeHello(hello({ e: b64u(E.slice(0, 64)) })))).toBe('MALFORMED');
    expect(codeOfSync(() => r.decodeHello(hello({ n: b64u(N.slice(0, 31)) })))).toBe('MALFORMED');
    expect(codeOfSync(() => r.decodeHello(hello({ n: b64u(new Uint8Array(33)) })))).toBe(
      'MALFORMED',
    );
    expect(codeOfSync(() => r.decodeHelloAck(r.encodeHelloAck(E, N, S.slice(0, 63))))).toBe(
      'MALFORMED',
    );
  });

  test('an ephemeral key that is not an uncompressed point is MALFORMED', () => {
    const compressed = E.slice();
    compressed[0] = 2;
    expect(codeOfSync(() => r.decodeHello(r.encodeHello('pair', compressed, N)))).toBe('MALFORMED');
    expect(codeOfSync(() => r.decodeHelloAck(r.encodeHelloAck(compressed, N, S)))).toBe(
      'MALFORMED',
    );
  });

  test('the canonical form is enforced: reordered keys, whitespace, escapes and number forms all fail', () => {
    const canonical = r.encodeHello('pair', E, N);
    expect(r.decodeHello(canonical).mode).toBe('pair');
    const o = JSON.parse(canonical);
    const reordered = JSON.stringify({ t: o.t, v: o.v, m: o.m, e: o.e, n: o.n });
    const spaced = canonical.replace(',"t"', ', "t"');
    const escaped = canonical.replace('"pair"', '"p\\u0061ir"');
    const floaty = canonical.replace('"v":2', '"v":2.0');
    const duplicate = canonical.replace('"m":"pair"', '"m":"pair","m":"pair"');
    const trailing = `${canonical} `;
    for (const bad of [reordered, spaced, escaped, floaty, duplicate, trailing]) {
      expect(codeOfSync(() => r.decodeHello(bad))).toBe('MALFORMED');
    }
  });

  test('a duplicate key cannot smuggle a second value past the key count', () => {
    // Same decoded object as a valid hello, different bytes.
    const dup = `{"v":2,"t":"hello","m":"resume","m":"pair","e":"${b64u(E)}","n":"${b64u(N)}"}`;
    expect(codeOfSync(() => r.decodeHello(dup))).toBe('MALFORMED');
  });
});

describe('data frames', () => {
  const ct = new Uint8Array(17).fill(5);

  test('the layout is the type byte, a big-endian counter, then the ciphertext', () => {
    const frame = encodeDataFrame(258, ct);
    expect(hex(frame.slice(0, 9))).toBe('030000000000000102');
    expect(frame.length).toBe(9 + 17);
    const d = decodeDataFrame(frame);
    expect(d.counter).toBe(258);
    expect(hex(d.ciphertext)).toBe(hex(ct));
  });

  test('a text frame is TYPE: there is no plaintext after the handshake', () => {
    expect(codeOfSync(() => decodeDataFrame(r.encodeHello('pair', E, N)))).toBe('TYPE');
    expect(codeOfSync(() => decodeDataFrame('hello'))).toBe('TYPE');
  });

  test('length bounds: below the minimum is MALFORMED, above the maximum is OVERSIZE', () => {
    expect(codeOfSync(() => decodeDataFrame(new Uint8Array(0)))).toBe('MALFORMED');
    const min = r.MIN_FRAME;
    const make = (len: number, type = r.TYPE_DATA): Uint8Array => {
      const f = new Uint8Array(len);
      f[0] = type;
      f[8] = 1;
      return f;
    };
    expect(codeOfSync(() => decodeDataFrame(make(min - 1)))).toBe('MALFORMED');
    expect(decodeDataFrame(make(min)).ciphertext.length).toBe(17);
    expect(decodeDataFrame(make(r.MAX_FRAME)).counter).toBe(1);
    expect(codeOfSync(() => decodeDataFrame(make(r.MAX_FRAME + 1)))).toBe('OVERSIZE');
  });

  test('any first byte other than the data type is TYPE, including the handshake types', () => {
    for (const type of [0, r.TYPE_AUTH, r.TYPE_READY, 4, 255]) {
      const frame = encodeDataFrame(1, ct);
      frame[0] = type;
      expect(codeOfSync(() => decodeDataFrame(frame))).toBe('TYPE');
    }
  });

  test('a counter above the maximum is COUNTER_LIMIT, the maximum itself is accepted', () => {
    expect(decodeDataFrame(encodeDataFrame(r.MAX_COUNTER, ct)).counter).toBe(r.MAX_COUNTER);
    expect(codeOfSync(() => decodeDataFrame(encodeDataFrame(r.MAX_COUNTER + 1, ct)))).toBe(
      'COUNTER_LIMIT',
    );
    const huge = encodeDataFrame(0, ct);
    huge.fill(0xff, 1, 9);
    expect(codeOfSync(() => decodeDataFrame(huge))).toBe('COUNTER_LIMIT');
  });

  test('a frame holds plain bytes: nothing about it is readable as the text it carries', () => {
    expect(hex(encodeDataFrame(1, text('abc')))).toBe('03000000000000000161' + '6263');
  });
});
