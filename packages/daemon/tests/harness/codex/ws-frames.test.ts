/**
 * RFC 6455 codec pins (epic #1175, phase 1 #1181). The byte vectors are the
 * ones RFC 6455 section 5.7 prints, so a mistake in the codec cannot hide
 * behind a test that shares it.
 */
import { describe, expect, test } from 'bun:test';
import {
  WS_OPCODE,
  WsFrameParser,
  WsProtocolError,
  computeAcceptKey,
  encodeClientFrame,
} from '../../../src/harness/codex/ws-frames.ts';

const hex = (s: string): Uint8Array =>
  Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .map((b) => Number.parseInt(b, 16)),
  );
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A server frame (unmasked), built independently of the parser under test. */
function serverFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const n = payload.length;
  const head =
    n < 126
      ? [(fin ? 0x80 : 0) | opcode, n]
      : n <= 0xffff
        ? [(fin ? 0x80 : 0) | opcode, 126, n >> 8, n & 0xff]
        : [
            (fin ? 0x80 : 0) | opcode,
            127,
            0,
            0,
            0,
            0,
            (n >>> 24) & 0xff,
            (n >> 16) & 0xff,
            (n >> 8) & 0xff,
            n & 0xff,
          ];
  return Uint8Array.from([...head, ...payload]);
}

/** Decode one masked client frame, independently of the parser (which refuses masked frames). */
function decodeClientFrame(frame: Uint8Array): {
  opcode: number;
  fin: boolean;
  payload: Uint8Array;
} {
  expect((frame[1] as number) & 0x80, 'client frames are masked').toBe(0x80);
  const short = (frame[1] as number) & 0x7f;
  let offset = 2;
  let length = short;
  if (short === 126) {
    length = ((frame[2] as number) << 8) | (frame[3] as number);
    offset = 4;
  } else if (short === 127) {
    length = Number(new DataView(frame.buffer, frame.byteOffset).getBigUint64(2));
    offset = 10;
  }
  const mask = frame.subarray(offset, offset + 4);
  const payload = frame
    .subarray(offset + 4, offset + 4 + length)
    .map((b, i) => b ^ (mask[i % 4] as number));
  expect(frame.length, 'no trailing bytes').toBe(offset + 4 + length);
  return { opcode: (frame[0] as number) & 0x0f, fin: ((frame[0] as number) & 0x80) !== 0, payload };
}

describe('computeAcceptKey', () => {
  test('matches the RFC 6455 section 1.3 example', () => {
    expect(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('encodeClientFrame', () => {
  test('masked "Hello" is the RFC 6455 vector', () => {
    const frame = encodeClientFrame(WS_OPCODE.text, bytes('Hello'), hex('37 fa 21 3d'));
    expect(Array.from(frame)).toEqual(Array.from(hex('81 85 37 fa 21 3d 7f 9f 4d 51 58')));
  });

  test('a random mask is 4 bytes, sets the mask bit, and round-trips', () => {
    const frame = encodeClientFrame(WS_OPCODE.text, bytes('Hello'));
    expect(frame.length).toBe(2 + 4 + 5);
    const decoded = decodeClientFrame(frame);
    expect(text(decoded.payload)).toBe('Hello');
    expect(decoded.opcode).toBe(WS_OPCODE.text);
    expect(decoded.fin).toBe(true);
  });

  test('a fresh mask is drawn per frame', () => {
    const masks = new Set<string>();
    for (let i = 0; i < 16; i++) {
      masks.add(Array.from(encodeClientFrame(WS_OPCODE.text, bytes('x')).subarray(2, 6)).join(','));
    }
    expect(masks.size).toBeGreaterThan(1);
  });

  test('length encoding: 7-bit, 16-bit and 64-bit forms are chosen at the RFC thresholds', () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [125, 0],
      [126, 2],
      [65535, 2],
      [65536, 8],
    ];
    for (const [length, extra] of cases) {
      const payload = new Uint8Array(length).fill(0x61);
      const frame = encodeClientFrame(WS_OPCODE.binary, payload, hex('01 02 03 04'));
      expect(frame.length, `length ${length}`).toBe(2 + extra + 4 + length);
      expect((frame[1] as number) & 0x7f, `length ${length}`).toBe(
        extra === 0 ? length : extra === 2 ? 126 : 127,
      );
      expect(decodeClientFrame(frame).payload.length).toBe(length);
    }
  });

  test('refuses an oversized control frame and a bad mask length', () => {
    expect(() => encodeClientFrame(WS_OPCODE.ping, new Uint8Array(126))).toThrow(RangeError);
    expect(() => encodeClientFrame(WS_OPCODE.text, bytes('x'), hex('01 02'))).toThrow(RangeError);
  });

  test('a close frame carries its status code big-endian', () => {
    const frame = encodeClientFrame(WS_OPCODE.close, hex('03 e8'), hex('00 00 00 00'));
    expect(Array.from(frame)).toEqual([0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe8]);
  });
});

describe('WsFrameParser', () => {
  test('unmasked "Hello" is the RFC 6455 vector', () => {
    const frames = new WsFrameParser().push(hex('81 05 48 65 6c 6c 6f'));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ fin: true, opcode: WS_OPCODE.text });
    expect(text((frames[0] as { payload: Uint8Array }).payload)).toBe('Hello');
  });

  test('a fragmented message arrives as two frames with FIN on the last', () => {
    const parser = new WsFrameParser();
    const first = parser.push(hex('01 03 48 65 6c'));
    const second = parser.push(hex('80 02 6c 6f'));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ fin: false, opcode: WS_OPCODE.text });
    expect(Array.from((first[0] as { payload: Uint8Array }).payload)).toEqual([0x48, 0x65, 0x6c]);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ fin: true, opcode: WS_OPCODE.continuation });
    expect(text((second[0] as { payload: Uint8Array }).payload)).toBe('lo');
  });

  test('a ping is an opcode 9 frame with its payload', () => {
    const [frame] = new WsFrameParser().push(hex('89 05 48 65 6c 6c 6f'));
    expect(frame).toMatchObject({ fin: true, opcode: WS_OPCODE.ping });
    expect(text((frame as { payload: Uint8Array }).payload)).toBe('Hello');
  });

  test('16-bit length: 256 bytes (RFC vector)', () => {
    const body = new Uint8Array(256).fill(0x62);
    const [frame] = new WsFrameParser().push(Uint8Array.from([0x82, 0x7e, 0x01, 0x00, ...body]));
    expect(frame).toMatchObject({ fin: true, opcode: WS_OPCODE.binary });
    expect((frame as { payload: Uint8Array }).payload).toEqual(body);
  });

  test('64-bit length: 65536 bytes (RFC vector)', () => {
    const body = new Uint8Array(65536).fill(0x63);
    const wire = new Uint8Array(10 + body.length);
    wire.set(hex('82 7f 00 00 00 00 00 01 00 00'));
    wire.set(body, 10);
    const [frame] = new WsFrameParser().push(wire);
    expect(frame).toMatchObject({ fin: true, opcode: WS_OPCODE.binary });
    expect((frame as { payload: Uint8Array }).payload.length).toBe(65536);
    expect((frame as { payload: Uint8Array }).payload.every((b) => b === 0x63)).toBe(true);
  });

  test('an empty payload is a frame', () => {
    const [frame] = new WsFrameParser().push(hex('81 00'));
    expect(frame).toMatchObject({ fin: true, opcode: WS_OPCODE.text });
    expect((frame as { payload: Uint8Array }).payload.length).toBe(0);
  });

  test('chunk boundaries do not matter: one byte at a time equals one push', () => {
    const wire = Uint8Array.from([
      ...serverFrame(WS_OPCODE.text, bytes('first')),
      ...serverFrame(WS_OPCODE.text, new Uint8Array(300).fill(0x64)),
      ...serverFrame(WS_OPCODE.ping, bytes('p')),
      ...serverFrame(WS_OPCODE.text, bytes('last')),
    ]);
    const whole = new WsFrameParser().push(wire);
    const slow = new WsFrameParser();
    const trickled = Array.from(wire).flatMap((b) => slow.push(Uint8Array.of(b)));
    expect(whole).toHaveLength(4);
    expect(trickled).toEqual(whole);
  });

  test('several frames in one chunk come out in order', () => {
    const frames = new WsFrameParser().push(
      Uint8Array.from([...serverFrame(1, bytes('a')), ...serverFrame(1, bytes('b'))]),
    );
    expect(frames.map((f) => text(f.payload))).toEqual(['a', 'b']);
  });

  test('a payload exactly at the limit is accepted; one byte over is not', () => {
    const parser = new WsFrameParser({ maxPayloadBytes: 4 });
    expect(parser.push(serverFrame(1, bytes('abcd')))).toHaveLength(1);
    expect(() =>
      new WsFrameParser({ maxPayloadBytes: 4 }).push(serverFrame(1, bytes('abcde'))),
    ).toThrow(WsProtocolError);
  });

  test('an oversized frame is refused from its header, before the payload arrives', () => {
    const parser = new WsFrameParser({ maxPayloadBytes: 1024 });
    expect(() => parser.push(hex('82 7e 10 00'))).toThrow(/over the limit/);
    // 64-bit form, and a length with the top bit set (forbidden by the RFC, and far over any limit).
    expect(() => new WsFrameParser().push(hex('82 7f 00 00 00 00 04 00 00 01'))).toThrow(
      WsProtocolError,
    );
    expect(() => new WsFrameParser().push(hex('82 7f 80 00 00 00 00 00 00 00'))).toThrow(
      WsProtocolError,
    );
  });

  test('each protocol violation throws WsProtocolError for its own reason', () => {
    // Each wire is one violation and nothing else, so a missing check cannot hide behind another.
    const bad: Array<[string, string, RegExp]> = [
      ['RSV1 set', 'c1 01 61', /RSV/],
      ['RSV2 set', 'a1 01 61', /RSV/],
      ['RSV3 set', '91 01 61', /RSV/],
      ['a masked server frame', '81 81 00 00 00 00 61', /masked/],
      ['an unknown data opcode', '83 01 61', /opcode/],
      ['an unknown control opcode', '8b 00', /opcode/],
      ['a fragmented ping', '09 00', /control frame/],
      ['a ping over 125 bytes', '89 7e 00 7e', /control frame/],
    ];
    for (const [name, wire, reason] of bad) {
      expect(() => new WsFrameParser().push(hex(wire)), name).toThrow(WsProtocolError);
      expect(() => new WsFrameParser().push(hex(wire)), name).toThrow(reason);
    }
  });

  test('a violation discards the frames the same chunk already completed, by design', () => {
    const chunk = Uint8Array.from([...serverFrame(WS_OPCODE.text, bytes('ok')), 0xc1, 0x00]);
    const parser = new WsFrameParser();
    expect(() => parser.push(chunk)).toThrow(/RSV/);
    // Nothing was returned for the good frame that preceded the bad one.
    const fresh = new WsFrameParser();
    expect(fresh.push(chunk.subarray(0, 4)).map((f) => text(f.payload))).toEqual(['ok']);
  });

  test('a control frame of exactly 125 bytes is fine', () => {
    const [frame] = new WsFrameParser().push(serverFrame(WS_OPCODE.ping, new Uint8Array(125)));
    expect(frame).toMatchObject({ opcode: WS_OPCODE.ping });
  });
});
