/** Structural codec/registry only: no host, authority, lease, transport or native acceptance. */
import { describe, expect, test } from 'bun:test';
import { isTerminalViewCandidate } from '../src/image-staging-ingress.ts';
import { MESSAGE_DIRECTION, deserialize, isValidMessage, serialize } from '../src/protocol.ts';
import {
  type SessionTerminalSnapshot,
  TERMINAL_VIEW_LIMITS,
  TERMINAL_VIEW_OPERATIONS,
  TERMINAL_VIEW_REFUSAL_CODES,
  type TerminalViewMessage,
  decodeTerminalViewFrame,
  encodeTerminalViewFrame,
} from '../src/terminal-view.ts';
import vectors from './fixtures/terminal-view/vectors.json';

const snapshot = vectors.positive.find((v) => v.name === 'snapshot-wide-combining')
  ?.expected as SessionTerminalSnapshot;
const encode = (value: unknown) => encodeTerminalViewFrame(value as TerminalViewMessage);
const raw = (value: unknown) => JSON.stringify(value);

describe('terminal view structural codec/registry (NOT host/transport/native)', () => {
  for (const vector of vectors.positive)
    test(vector.name, () => {
      const expected = vector.expected as TerminalViewMessage;
      expect(decodeTerminalViewFrame(vector.raw)).toEqual(expected);
      expect(decodeTerminalViewFrame(new TextEncoder().encode(vector.raw))).toEqual(expected);
      expect(encodeTerminalViewFrame(expected)).toBe(vector.raw);
      expect(deserialize(vector.raw)).toEqual(expected);
      expect(serialize(expected)).toBe(vector.raw);
      expect(isValidMessage(expected)).toBe(true);
      expect(MESSAGE_DIRECTION[expected.type]).toBe(
        TERMINAL_VIEW_OPERATIONS.some((type) => type === expected.type) ? 'c2d' : 'd2c',
      );
    });

  for (const vector of vectors.negative)
    test(vector.name, () => {
      const input = 'raw' in vector ? vector.raw : Uint8Array.from(vector.bytes);
      expect(decodeTerminalViewFrame(input)).toBeNull();
      if (typeof input === 'string') expect(deserialize(input)).toBeNull();
    });

  test('exact UTF-8 text, per-row storage and geometry ceilings', () => {
    // Exactly 32 KiB of cell text fits within 240x60 physical cells.
    const text = `${'\ue000'.repeat(10922)}xx`;
    const lines = Array.from({ length: 60 }, (_, row) => text.slice(row * 240, (row + 1) * 240));
    expect(new TextEncoder().encode(lines.join('')).byteLength).toBe(32768);
    const maximum = {
      ...snapshot,
      columns: 240,
      rows: 60,
      lines,
      cursor: { row: 59, column: 239 },
    };
    expect(decodeTerminalViewFrame(encode(maximum))).toEqual(maximum);
    const over = [...lines];
    over[59] = 'x';
    expect(decodeTerminalViewFrame(raw({ ...maximum, lines: over }))).toBeNull();
    expect(() => encode({ ...maximum, lines: over })).toThrow('Invalid terminal view frame');
    // The codec bounds storage, not glyph/font width; B3 must use the actual model.
    const rowBound = { ...snapshot, columns: 2, rows: 1, lines: ['x'.repeat(128)], cursor: null };
    expect(decodeTerminalViewFrame(encode(rowBound))).toEqual(rowBound);
    expect(decodeTerminalViewFrame(raw({ ...rowBound, lines: ['x'.repeat(129)] }))).toBeNull();
    expect(decodeTerminalViewFrame(raw({ ...rowBound, lines: ['界'.repeat(43)] }))).toBeNull();
  });

  test('exact original raw frame ceiling, including whitespace and JSON expansion', () => {
    const base = encode(snapshot);
    const padding = TERMINAL_VIEW_LIMITS.frameBytes - new TextEncoder().encode(base).byteLength;
    expect(decodeTerminalViewFrame(base + ' '.repeat(padding))).toEqual(snapshot);
    expect(decodeTerminalViewFrame(base + ' '.repeat(padding + 1))).toBeNull();
    const lines = Array.from({ length: 60 }, (_, row) => (row < 45 ? '\\'.repeat(240) : ''));
    // Escaping doubles these bytes in JSON; fill to the text bound with two more rows.
    const escaped = {
      ...snapshot,
      columns: 240,
      rows: 60,
      lines: lines.map(() => '\\'.repeat(240)),
      cursor: null,
    };
    // 14,400 cell bytes remain below the raw cap even after escaping.
    expect(decodeTerminalViewFrame(encode(escaped))).toEqual(escaped);
    const expanded = {
      ...snapshot,
      columns: 240,
      rows: 60,
      lines: Array.from({ length: 60 }, (_, i) =>
        i < 2 ? '\\'.repeat(15360) : i === 2 ? '\\'.repeat(2048) : '',
      ),
      cursor: null,
    };
    expect(() => encode(expanded)).toThrow('Invalid terminal view frame');
    expect(decodeTerminalViewFrame(raw(expanded))).toBeNull();
  });

  test('every refusal operation/code is structural and carries no detail payload', () => {
    const refusal = decodeTerminalViewFrame(
      vectors.positive.find((v) => v.name === 'refused')?.raw ?? '',
    );
    if (!refusal || refusal.type !== 'session_terminal_refused')
      throw new Error('Missing refusal control');
    for (const operation of TERMINAL_VIEW_OPERATIONS)
      for (const code of TERMINAL_VIEW_REFUSAL_CODES) {
        const frame = { ...refusal, operation, code };
        expect(decodeTerminalViewFrame(encode(frame))).toEqual(frame);
        expect(decodeTerminalViewFrame(raw({ ...frame, detail: 'PRIVATE_DIAGNOSTIC' }))).toBeNull();
      }
  });

  test('raw prefix selection rejects malformed and duplicate terminal/legacy mixtures', () => {
    const open = vectors.positive[0]?.raw ?? '';
    for (const input of [
      open.replace('session_terminal_open', 'session_terminal_input'),
      `${open.slice(0, -1)},"type":"ping"}`,
      `{"type":"ping",${open.slice(1)}`,
      open.replace('"type"', '"t\\u0079pe"'),
      open.slice(0, open.indexOf('session_terminal_') + 'session_terminal_'.length),
      `{"type":"session_terminal_${'x'.repeat(65536)}`,
    ]) {
      expect(isTerminalViewCandidate(input)).toBe(true);
      expect(isTerminalViewCandidate(new TextEncoder().encode(input))).toBe(true);
      if (input !== open.replace('"type"', '"t\\u0079pe"')) expect(deserialize(input)).toBeNull();
    }
    expect(deserialize(open.replace('"type"', '"t\\u0079pe"'))).toEqual(JSON.parse(open));
  });

  test('runtime serializer rejects sparse/decorated arrays, coercions and cyclic objects', () => {
    const invalid: unknown[] = [
      { ...snapshot, lines: Array(4) },
      { ...snapshot, lines: Object.assign([...snapshot.lines], { extra: 'discarded' }) },
      {
        ...snapshot,
        lines: Object.assign([...snapshot.lines], { [Symbol('hidden')]: 'discarded' }),
      },
      { ...snapshot, lines: new Set(snapshot.lines) },
      { ...snapshot, revision: Number.NaN },
      { ...snapshot, revision: Number.POSITIVE_INFINITY },
      { ...snapshot, revision: 1n },
      { ...snapshot, cursor: new Date() },
      Object.assign(Object.create({ inherited: true }), snapshot),
      { ...snapshot, extra: undefined },
    ];
    let invoked = 0;
    const getter = { ...snapshot };
    Object.defineProperty(getter, 'lines', {
      enumerable: true,
      get() {
        invoked++;
        return snapshot.lines;
      },
    });
    invalid.push(getter, {
      ...snapshot,
      toJSON() {
        invoked++;
        return snapshot;
      },
    });
    const lines = [...snapshot.lines];
    Object.defineProperty(lines, '0', {
      enumerable: true,
      get() {
        invoked++;
        return 'owned';
      },
    });
    invalid.push({ ...snapshot, lines });
    const cyclic: Record<string, unknown> = { ...snapshot };
    cyclic['cycle'] = cyclic;
    invalid.push(cyclic);
    for (const value of invalid) expect(() => encode(value)).toThrow('Invalid terminal view frame');
    expect(invoked).toBe(0);
    const frozen = Object.freeze({ ...snapshot, lines: Object.freeze([...snapshot.lines]) });
    expect(decodeTerminalViewFrame(encode(frozen))).toEqual(snapshot);
  });
});
