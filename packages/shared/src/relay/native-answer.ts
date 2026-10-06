/** Signed native answers (#1201): one exact tuple, no independent outer choice. */
import type { AnswerSelection } from '../protocol.ts';
import { type Bytes, be64, concat, fromB64u, lps, utf8 } from './bytes.ts';
import { LABEL } from './constants.ts';
import { RelayError } from './errors.ts';
import { ridOf, sha256, verifySignature } from './primitives.ts';
import { isSmallOrderPublicKey } from './small-order.ts';
import { parseStrictJson } from './strict-json.ts';

export const MAX_NATIVE_ANSWER_BODY = 8192;
export const MAX_NATIVE_ANSWER_JSON = 16384;
export const NATIVE_ANSWER_TTL_SECONDS = 30;
export const NATIVE_ANSWER_FUTURE_SECONDS = 5;

export interface UnsignedNativeAnswer {
  readonly type: 'native_answer';
  readonly v: 2;
  readonly id: string;
  readonly timestamp: string;
  readonly rid: string;
  readonly machinePublicKey: string;
  readonly devicePublicKey: string;
  readonly sessionId: string;
  readonly runtimeInstance: string;
  readonly questionId: string;
  readonly collapseId: string;
  readonly revision: number;
  readonly contentDigest: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly answer: string;
  readonly claudeSessionId?: string;
  readonly selections?: readonly AnswerSelection[];
  readonly cancel?: boolean;
  readonly message?: string;
}
export interface NativeAnswer extends UnsignedNativeAnswer {
  readonly signature: string;
}
export interface NativeAnswerAuthority {
  readonly rid: string;
  readonly machinePublicKey: string;
  readonly devicePublicKey: string;
}
export interface VerifiedNativeAnswer {
  readonly message: NativeAnswer;
  /** SHA256 of the unsigned tuple, excluding signature bytes. */
  readonly requestDigest: string;
}

const REQUIRED = [
  'type',
  'v',
  'id',
  'timestamp',
  'rid',
  'machinePublicKey',
  'devicePublicKey',
  'sessionId',
  'runtimeInstance',
  'questionId',
  'collapseId',
  'revision',
  'contentDigest',
  'nonce',
  'issuedAt',
  'expiresAt',
  'answer',
] as const;
const OPTIONAL = ['claudeSessionId', 'selections', 'cancel', 'message'] as const;
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const malformed = (): never => {
  throw new RelayError('MALFORMED');
};

function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed();
  const o = value as Record<string, unknown>;
  if (
    required.some((key) => !own(o, key)) ||
    Object.keys(o).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return malformed();
  return o;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return malformed();
  return value;
}
function text(value: unknown, max: number, nonempty = true): string {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) return malformed();
  // TextEncoder replaces lone surrogates; distinct inputs must never share a tuple.
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return malformed();
    } else if (n >= 0xdc00 && n <= 0xdfff) return malformed();
  }
  if (utf8(value).length > max) throw new RelayError('OVERSIZE');
  return value;
}
function binary(value: unknown, size: number, publicKey = false): Bytes {
  if (typeof value !== 'string') return malformed();
  const bytes = fromB64u(value);
  if (bytes.length !== size || (publicKey && isSmallOrderPublicKey(bytes))) return malformed();
  return bytes;
}
function rid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) return malformed();
  return value;
}
function selections(value: unknown): readonly AnswerSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return malformed();
  let previous = -1;
  return Object.freeze(
    value.map((entry) => {
      const o = object(entry, ['questionIndex', 'optionIndices'], ['text']);
      const questionIndex = integer(o['questionIndex'], 0, 0xffff);
      if (questionIndex <= previous) return malformed();
      previous = questionIndex;
      if (!Array.isArray(o['optionIndices']) || o['optionIndices'].length > 4) return malformed();
      let last = -1;
      const optionIndices = Object.freeze(
        o['optionIndices'].map((item) => {
          const n = integer(item, 0, 0xffff);
          if (n <= last) return malformed();
          last = n;
          return n;
        }),
      );
      if (own(o, 'text')) {
        if (optionIndices.length !== 0) return malformed();
        return Object.freeze({ questionIndex, optionIndices, text: text(o['text'], 2048) });
      }
      if (optionIndices.length === 0) return malformed();
      return Object.freeze({ questionIndex, optionIndices });
    }),
  );
}

/** Copy all authoritative values synchronously, before hashing or signature awaits. */
function validated(value: unknown, requireSignature: boolean): UnsignedNativeAnswer | NativeAnswer {
  const o = object(
    value,
    requireSignature ? [...REQUIRED, 'signature'] : REQUIRED,
    requireSignature ? OPTIONAL : [...OPTIONAL, 'signature'],
  );
  if (o['type'] !== 'native_answer' || o['v'] !== 2) return malformed();
  binary(o['machinePublicKey'], 32, true);
  binary(o['devicePublicKey'], 32, true);
  for (const key of ['runtimeInstance', 'contentDigest', 'nonce']) binary(o[key], 32);
  binary(o['collapseId'], 16);
  const issuedAt = integer(o['issuedAt'], 0, 8_640_000_000_000);
  const expiresAt = integer(o['expiresAt'], 0, 8_640_000_000_000);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > NATIVE_ANSWER_TTL_SECONDS) return malformed();
  if (o['timestamp'] !== new Date(issuedAt * 1000).toISOString()) return malformed();
  const answer = text(o['answer'], 128, false);
  const extra: {
    claudeSessionId?: string;
    selections?: readonly AnswerSelection[];
    cancel?: boolean;
    message?: string;
  } = {};
  if (own(o, 'claudeSessionId')) extra.claudeSessionId = text(o['claudeSessionId'], 128);
  if (own(o, 'selections')) extra.selections = selections(o['selections']);
  if (own(o, 'cancel')) {
    if (typeof o['cancel'] !== 'boolean') return malformed();
    extra.cancel = o['cancel'];
  }
  if (own(o, 'message')) extra.message = text(o['message'], 2048, false);
  if (extra.selections || extra.cancel === true) {
    if (answer !== '' || (extra.selections && extra.cancel === true)) return malformed();
  } else if (answer === '') return malformed();
  const copy: UnsignedNativeAnswer = {
    type: 'native_answer',
    v: 2,
    id: text(o['id'], 128),
    timestamp: o['timestamp'] as string,
    rid: rid(o['rid']),
    machinePublicKey: o['machinePublicKey'] as string,
    devicePublicKey: o['devicePublicKey'] as string,
    sessionId: text(o['sessionId'], 128),
    runtimeInstance: o['runtimeInstance'] as string,
    questionId: text(o['questionId'], 128),
    collapseId: o['collapseId'] as string,
    revision: integer(o['revision'], 1),
    contentDigest: o['contentDigest'] as string,
    nonce: o['nonce'] as string,
    issuedAt,
    expiresAt,
    answer,
    ...extra,
  };
  if (own(o, 'signature')) {
    binary(o['signature'], 64);
    return Object.freeze({ ...copy, signature: o['signature'] as string });
  }
  return Object.freeze(copy);
}
const u16 = (n: number): Bytes => Uint8Array.of(n >> 8, n & 255);
const optionalText = (
  o: UnsignedNativeAnswer | AnswerSelection,
  key: 'claudeSessionId' | 'message' | 'text',
): Bytes => {
  if (!own(o, key)) return Uint8Array.of(0);
  const value = (o as unknown as Record<string, string>)[key];
  if (value === undefined) return malformed();
  return concat(Uint8Array.of(1), utf8(value));
};
function body(m: UnsignedNativeAnswer): Bytes {
  const optionalSelections =
    m.selections === undefined
      ? Uint8Array.of(0)
      : concat(
          Uint8Array.of(1),
          lps(
            u16(m.selections.length),
            ...m.selections.map((s) =>
              lps(
                u16(s.questionIndex),
                lps(u16(s.optionIndices.length), ...s.optionIndices.map(u16)),
                optionalText(s, 'text'),
              ),
            ),
          ),
        );
  const bytes = lps(
    Uint8Array.from(m.rid.match(/../g) ?? [], (p) => Number.parseInt(p, 16)),
    fromB64u(m.machinePublicKey),
    fromB64u(m.devicePublicKey),
    m.id,
    m.sessionId,
    fromB64u(m.runtimeInstance),
    m.questionId,
    m.collapseId,
    be64(m.revision),
    fromB64u(m.contentDigest),
    fromB64u(m.nonce),
    be64(m.issuedAt),
    be64(m.expiresAt),
    m.answer,
    optionalText(m, 'claudeSessionId'),
    optionalSelections,
    m.cancel === undefined ? Uint8Array.of(0) : Uint8Array.of(1, m.cancel ? 1 : 0),
    optionalText(m, 'message'),
  );
  if (bytes.length > MAX_NATIVE_ANSWER_BODY) throw new RelayError('OVERSIZE');
  return bytes;
}
/** Accepts a signed value too; the signature is validated but excluded from the tuple. */
export function buildNativeAnswerBody(m: UnsignedNativeAnswer | NativeAnswer): Bytes {
  return body(validated(m, false));
}
export async function buildNativeAnswerSigningInput(
  m: UnsignedNativeAnswer | NativeAnswer,
): Promise<Bytes> {
  return lps(LABEL.nativeAnswer, await sha256(buildNativeAnswerBody(m)));
}
export async function nativeAnswerDigest(m: UnsignedNativeAnswer | NativeAnswer): Promise<string> {
  return Array.from(await sha256(buildNativeAnswerBody(m)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
export function encodeNativeAnswer(m: NativeAnswer): string {
  const copy = validated(m, true) as NativeAnswer;
  body(copy);
  const encoded = JSON.stringify(copy);
  if (utf8(encoded).length > MAX_NATIVE_ANSWER_JSON) throw new RelayError('OVERSIZE');
  return encoded;
}
export function decodeNativeAnswer(encoded: string): NativeAnswer {
  const copy = validated(parseStrictJson(encoded, MAX_NATIVE_ANSWER_JSON), true) as NativeAnswer;
  body(copy);
  return copy;
}
/** Verification is not permission: callers still require current captured epochs and a live prompt. */
export async function verifyNativeAnswer(
  m: NativeAnswer,
  expected: NativeAnswerAuthority,
  now: number,
): Promise<VerifiedNativeAnswer> {
  const message = validated(m, true) as NativeAnswer;
  const authority = object(expected, ['rid', 'machinePublicKey', 'devicePublicKey']);
  const expectedRid = rid(authority['rid']);
  const machine = binary(authority['machinePublicKey'], 32, true);
  const device = binary(authority['devicePublicKey'], 32, true);
  integer(now);
  if (message.issuedAt > now + NATIVE_ANSWER_FUTURE_SECONDS || now >= message.expiresAt)
    throw new RelayError('EXPIRED');
  if (
    message.rid !== expectedRid ||
    message.machinePublicKey !== authority['machinePublicKey'] ||
    message.devicePublicKey !== authority['devicePublicKey']
  )
    throw new RelayError('UNKNOWN_DEVICE');
  const derived = Array.from(await ridOf(machine), (n) => n.toString(16).padStart(2, '0')).join('');
  if (derived !== expectedRid) throw new RelayError('UNKNOWN_DEVICE');
  const digest = await sha256(body(message));
  if (
    !(await verifySignature(device, lps(LABEL.nativeAnswer, digest), fromB64u(message.signature)))
  )
    throw new RelayError('BAD_SIGNATURE');
  return Object.freeze({
    message,
    requestDigest: Array.from(digest, (n) => n.toString(16).padStart(2, '0')).join(''),
  });
}
