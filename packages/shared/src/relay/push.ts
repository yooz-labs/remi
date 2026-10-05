/** Signed sealed push v2 (#1200): exact tuples, bounded content and fixed outcomes. */
import {
  type Bytes,
  b64u,
  be64,
  ctEqual,
  fromB64u,
  fromUtf8,
  lps,
  own,
  readBe64,
  utf8,
} from './bytes.ts';
import {
  LABEL,
  MAX_PUSH_PLAINTEXT,
  MAX_PUSH_SUBMIT_BYTES,
  PUSH_CLOCK_SKEW_SECONDS,
  PUSH_CONTENT_TTL_SECONDS,
  PUSH_INFORMATIONAL_TTL_SECONDS,
  PUSH_SUBMIT_TTL_SECONDS,
} from './constants.ts';
import { RelayError } from './errors.ts';
import {
  type EcPair,
  type Rng,
  type Signer,
  importEcPublic,
  ridOf,
  sha256,
  verifySignature,
} from './primitives.ts';
import { openSeal, pushAad, seal } from './seal.ts';
import { isSmallOrderPublicKey } from './small-order.ts';

export type SecurePushKind =
  | 'question'
  | 'turn_complete'
  | 'subagent_alert'
  | 'harness_denied'
  | 'turn_failed'
  | 'dismiss';
export type ApnsEnvironment = 'production' | 'sandbox';
export const PUSH_KIND_BYTE: Readonly<Record<SecurePushKind, number>> = Object.freeze({
  question: 1,
  turn_complete: 2,
  subagent_alert: 3,
  harness_denied: 4,
  turn_failed: 5,
  dismiss: 6,
});
export const APNS_ENVIRONMENT_BYTE: Readonly<Record<ApnsEnvironment, number>> = Object.freeze({
  production: 1,
  sandbox: 2,
});
export interface PushOption {
  readonly value: string;
  readonly label: string;
  readonly isYes: boolean;
  readonly isNo: boolean;
  readonly description: string | null;
  readonly standingGrant: null | 'addRules' | 'setMode' | 'session';
}
export type SecurePushPayload =
  | {
      readonly type: 'question';
      readonly actionable: true;
      readonly sessionId: string;
      readonly runtimeInstance: string;
      readonly questionId: string;
      readonly title: string;
      readonly body: string;
      readonly category: 'none' | 'REMI_YN' | 'REMI_YNA' | 'REMI_MULTI';
      readonly options: readonly PushOption[];
    }
  | {
      readonly type: 'informational';
      readonly actionable: false;
      readonly sessionId: string | null;
      readonly title: string;
      readonly body: string;
    }
  | { readonly type: 'dismiss'; readonly actionable: false };
export interface PushContentMetadata {
  readonly machinePublicKey: string;
  readonly rid: string;
  readonly devicePublicKey: string;
  readonly pushPublicKey: string;
  readonly keyVersion: number;
  readonly collapseId: string;
  readonly revision: number;
  readonly kind: SecurePushKind;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export interface SignedPushContent {
  readonly content: PushContentMetadata;
  readonly payloadBytes: Bytes;
  readonly signature: Bytes;
}
export interface PushCarrier {
  readonly v: 2;
  readonly rid: string;
  readonly collapseId: string;
  readonly keyVersion: number;
  readonly kind: SecurePushKind;
  readonly sealed: string;
}
export interface PushAuthority {
  readonly machinePublicKey: string;
  readonly devicePublicKey: string;
  readonly pushPublicKey: string;
  readonly keyVersion: number;
}
export interface UnsignedPushSubmit extends PushContentMetadata {
  readonly v: 2;
  readonly audience: string;
  readonly token: string;
  readonly environment: ApnsEnvironment;
  readonly sealed: string;
}
export interface PushSubmit extends UnsignedPushSubmit {
  readonly signature: string;
}
export type PushRejectReason =
  | 'MALFORMED'
  | 'OVERSIZE'
  | 'BAD_SIGNATURE'
  | 'WRONG_AUDIENCE'
  | 'NOT_ENROLLED'
  | 'EXPIRED'
  | 'NONCE_CONFLICT'
  | 'CAPACITY'
  | 'RATE_LIMITED'
  | 'STORE_ERROR'
  | 'INVALID_TOKEN'
  | 'APNS_REJECTED';
export type PushSubmitResult =
  | { readonly v: 2; readonly requestDigest: string; readonly outcome: 'accepted' | 'uncertain' }
  | {
      readonly v: 2;
      readonly requestDigest: string | null;
      readonly outcome: 'rejected';
      readonly reason: PushRejectReason;
      readonly retryable: boolean;
    };

const CONTENT_KEYS = [
  'machinePublicKey',
  'rid',
  'devicePublicKey',
  'pushPublicKey',
  'keyVersion',
  'collapseId',
  'revision',
  'kind',
  'nonce',
  'issuedAt',
  'expiresAt',
] as const;
const SUBMIT_KEYS = [
  'v',
  'audience',
  'rid',
  'machinePublicKey',
  'devicePublicKey',
  'pushPublicKey',
  'keyVersion',
  'token',
  'environment',
  'collapseId',
  'revision',
  'kind',
  'nonce',
  'issuedAt',
  'expiresAt',
  'sealed',
  'signature',
] as const;
const REASONS: readonly PushRejectReason[] = [
  'MALFORMED',
  'OVERSIZE',
  'BAD_SIGNATURE',
  'WRONG_AUDIENCE',
  'NOT_ENROLLED',
  'EXPIRED',
  'NONCE_CONFLICT',
  'CAPACITY',
  'RATE_LIMITED',
  'STORE_ERROR',
  'INVALID_TOKEN',
  'APNS_REJECTED',
];
function malformed(): never {
  throw new RelayError('MALFORMED');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some((k) => !Object.hasOwn(o, k)))
    return malformed();
  return o;
}
function str(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') return malformed();
  const bytes = utf8(value);
  if (bytes.length < min || bytes.length > max || fromUtf8(bytes) !== value) return malformed();
  return value;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return malformed();
  return value;
}
function binary(value: unknown, size: number): Bytes {
  if (typeof value !== 'string') return malformed();
  const b = fromB64u(value);
  if (b.length !== size) return malformed();
  return b;
}
function unhex(value: unknown, min: number, max: number): Bytes {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) return malformed();
  if (value.length < min * 2 || value.length > max * 2) return malformed();
  return Uint8Array.from(value.match(/../g) ?? [], (p) => Number.parseInt(p, 16));
}
const hex = (value: Uint8Array): string =>
  Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
function publicKey(value: unknown): Bytes {
  const b = binary(value, 32);
  if (isSmallOrderPublicKey(b)) return malformed();
  return b;
}
function point(value: unknown): Bytes {
  const b = binary(value, 65);
  if (b[0] !== 4) return malformed();
  return b;
}
function kind(value: unknown): SecurePushKind {
  if (typeof value !== 'string' || !Object.hasOwn(PUSH_KIND_BYTE, value)) return malformed();
  return value as SecurePushKind;
}
function lifetime(issuedAt: number, expiresAt: number, max: number): void {
  if (expiresAt <= issuedAt || expiresAt - issuedAt > max) malformed();
}
function live(issuedAt: number, expiresAt: number, now: number): void {
  integer(now);
  if (issuedAt > now + PUSH_CLOCK_SKEW_SECONDS || expiresAt <= now) throw new RelayError('EXPIRED');
}
function metadata(value: unknown, allowOtherKeys = false): PushContentMetadata {
  const o = allowOtherKeys ? (value as Record<string, unknown>) : object(value, CONTENT_KEYS);
  publicKey(o['machinePublicKey']);
  publicKey(o['devicePublicKey']);
  point(o['pushPublicKey']);
  unhex(o['rid'], 16, 16);
  binary(o['collapseId'], 16);
  binary(o['nonce'], 32);
  const c: PushContentMetadata = {
    machinePublicKey: o['machinePublicKey'] as string,
    rid: o['rid'] as string,
    devicePublicKey: o['devicePublicKey'] as string,
    pushPublicKey: o['pushPublicKey'] as string,
    keyVersion: integer(o['keyVersion'], 1),
    collapseId: o['collapseId'] as string,
    revision: integer(o['revision'], 1),
    kind: kind(o['kind']),
    nonce: o['nonce'] as string,
    issuedAt: integer(o['issuedAt']),
    expiresAt: integer(o['expiresAt']),
  };
  return c;
}

/** Scan decoded member names BEFORE JSON.parse can discard duplicates. Raw bytes stay unchanged. */
function json(value: string, max: number): unknown {
  if (utf8(value).length > max) throw new RelayError('OVERSIZE');
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(value[at] ?? '\0')) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < value.length) {
      const c = value[at++];
      if (c === '\\') {
        at++;
        continue;
      }
      if (c === '"') {
        try {
          return JSON.parse(value.slice(start, at)) as string;
        } catch {
          return malformed();
        }
      }
    }
    return malformed();
  };
  const scan = (depth: number): void => {
    if (depth > 8 || ++nodes > 512) malformed();
    whitespace();
    const c = value[at];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{') {
      at++;
      whitespace();
      const seen = new Set<string>();
      if (value[at] === '}') {
        at++;
        return;
      }
      while (true) {
        if (value[at] !== '"') malformed();
        const key = string();
        if (seen.has(key)) malformed();
        seen.add(key);
        whitespace();
        if (value[at++] !== ':') malformed();
        scan(depth + 1);
        whitespace();
        const end = value[at++];
        if (end === '}') return;
        if (end !== ',') malformed();
        whitespace();
      }
    }
    if (c === '[') {
      at++;
      whitespace();
      if (value[at] === ']') {
        at++;
        return;
      }
      while (true) {
        scan(depth + 1);
        whitespace();
        const end = value[at++];
        if (end === ']') return;
        if (end !== ',') malformed();
      }
    }
    const start = at;
    while (at < value.length && !/[\x20\t\r\n,\]}]/.test(value[at] ?? '')) at++;
    if (at === start) malformed();
    // JSON.parse below validates exact literal/number grammar and numeric semantics.
  };
  scan(0);
  whitespace();
  if (at !== value.length) malformed();
  try {
    return JSON.parse(value);
  } catch {
    return malformed();
  }
}

function option(value: unknown): PushOption {
  const o = object(value, ['value', 'label', 'isYes', 'isNo', 'description', 'standingGrant']);
  if (typeof o['isYes'] !== 'boolean' || typeof o['isNo'] !== 'boolean') malformed();
  if (
    o['standingGrant'] !== null &&
    o['standingGrant'] !== 'addRules' &&
    o['standingGrant'] !== 'setMode' &&
    o['standingGrant'] !== 'session'
  )
    malformed();
  return {
    value: str(o['value'], 1, 128),
    label: str(o['label'], 1, 128),
    isYes: o['isYes'] as boolean,
    isNo: o['isNo'] as boolean,
    description: o['description'] === null ? null : str(o['description'], 0, MAX_PUSH_PLAINTEXT),
    standingGrant: o['standingGrant'] as PushOption['standingGrant'],
  };
}
function payload(value: unknown): SecurePushPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed();
  const type = (value as Record<string, unknown>)['type'];
  if (type === 'dismiss') {
    const o = object(value, ['type', 'actionable']);
    if (o['actionable'] !== false) malformed();
    return { type, actionable: false };
  }
  if (type === 'informational') {
    const o = object(value, ['type', 'actionable', 'sessionId', 'title', 'body']);
    if (o['actionable'] !== false) malformed();
    return {
      type,
      actionable: false,
      sessionId: o['sessionId'] === null ? null : str(o['sessionId'], 1, 128),
      title: str(o['title'], 0, 128),
      body: str(o['body'], 0, 512),
    };
  }
  if (type !== 'question') return malformed();
  const o = object(value, [
    'type',
    'actionable',
    'sessionId',
    'runtimeInstance',
    'questionId',
    'title',
    'body',
    'category',
    'options',
  ]);
  if (
    o['actionable'] !== true ||
    !Array.isArray(o['options']) ||
    o['options'].length < 2 ||
    o['options'].length > 4
  )
    malformed();
  const category = o['category'];
  if (
    category !== 'none' &&
    category !== 'REMI_YN' &&
    category !== 'REMI_YNA' &&
    category !== 'REMI_MULTI'
  )
    malformed();
  binary(o['runtimeInstance'], 32);
  return {
    type,
    actionable: true,
    sessionId: str(o['sessionId'], 1, 128),
    runtimeInstance: o['runtimeInstance'] as string,
    questionId: str(o['questionId'], 1, 128),
    title: str(o['title'], 0, 128),
    body: str(o['body'], 0, 512),
    category,
    options: o['options'].map(option),
  };
}
export function buildPushPayload(value: SecurePushPayload): Bytes {
  const bytes = utf8(JSON.stringify(payload(value)));
  if (bytes.length > MAX_PUSH_PLAINTEXT) throw new RelayError('OVERSIZE');
  return bytes;
}
export function parsePushPayload(bytes: Uint8Array): SecurePushPayload {
  if (bytes.length < 1) malformed();
  if (bytes.length > MAX_PUSH_PLAINTEXT) throw new RelayError('OVERSIZE');
  return payload(json(fromUtf8(bytes), MAX_PUSH_PLAINTEXT));
}
function checkPayload(c: PushContentMetadata, p: SecurePushPayload): void {
  if (
    (c.kind === 'dismiss') !== (p.type === 'dismiss') ||
    (p.type === 'question' && c.kind !== 'question')
  )
    malformed();
  lifetime(
    c.issuedAt,
    c.expiresAt,
    p.type === 'informational' ? PUSH_INFORMATIONAL_TTL_SECONDS : PUSH_CONTENT_TTL_SECONDS,
  );
}
function tupleBody(value: PushContentMetadata, payloadBytes: Uint8Array): Bytes {
  const c = metadata(value);
  return lps(
    publicKey(c.machinePublicKey),
    unhex(c.rid, 16, 16),
    publicKey(c.devicePublicKey),
    point(c.pushPublicKey),
    be64(c.keyVersion),
    c.collapseId,
    be64(c.revision),
    Uint8Array.of(PUSH_KIND_BYTE[c.kind]),
    binary(c.nonce, 32),
    be64(c.issuedAt),
    be64(c.expiresAt),
    payloadBytes,
  );
}
function contentBody(c: PushContentMetadata, payloadBytes: Uint8Array): Bytes {
  checkPayload(c, parsePushPayload(payloadBytes));
  return tupleBody(c, payloadBytes);
}
export async function buildPushContentSigningInput(
  c: PushContentMetadata,
  payloadBytes: Uint8Array,
): Promise<Bytes> {
  return lps(LABEL.pushContent, await sha256(contentBody(c, payloadBytes)));
}
export function encodeSignedPushContent(
  c: PushContentMetadata,
  payloadBytes: Uint8Array,
  signature: Uint8Array,
): Bytes {
  if (signature.length !== 64) malformed();
  const body = tupleBody(c, payloadBytes);
  const bytes = lps(body, signature);
  if (bytes.length > MAX_PUSH_PLAINTEXT) throw new RelayError('OVERSIZE');
  checkPayload(c, parsePushPayload(payloadBytes));
  return bytes;
}
function parts(bytes: Uint8Array, count: number): Bytes[] {
  const out: Bytes[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 2 > bytes.length || out.length >= count) malformed();
    const length = (bytes[at] as number) * 256 + (bytes[at + 1] as number);
    at += 2;
    if (at + length > bytes.length) malformed();
    out.push(own(bytes.slice(at, at + length)));
    at += length;
  }
  if (out.length !== count) malformed();
  return out;
}
export function decodeSignedPushContent(bytes: Uint8Array): SignedPushContent {
  if (bytes.length > MAX_PUSH_PLAINTEXT) throw new RelayError('OVERSIZE');
  const [body, signature] = parts(bytes, 2) as [Bytes, Bytes];
  if (signature.length !== 64) malformed();
  const fields = parts(body, 12);
  const num = (i: number): number => {
    const b = fields[i] as Bytes;
    if (b.length !== 8) return malformed();
    const n = readBe64(b, 0);
    return n === null ? malformed() : n;
  };
  const kindBytes = fields[7] as Bytes;
  const kindValue = Object.entries(PUSH_KIND_BYTE).find(([, b]) => b === kindBytes[0])?.[0];
  if (kindBytes.length !== 1 || !kindValue) malformed();
  const content = metadata({
    machinePublicKey: b64u(fields[0] as Bytes),
    rid: hex(fields[1] as Bytes),
    devicePublicKey: b64u(fields[2] as Bytes),
    pushPublicKey: b64u(fields[3] as Bytes),
    keyVersion: num(4),
    collapseId: fromUtf8(fields[5] as Bytes),
    revision: num(6),
    kind: kindValue,
    nonce: b64u(fields[8] as Bytes),
    issuedAt: num(9),
    expiresAt: num(10),
  });
  const payloadBytes = fields[11] as Bytes;
  return { content, payloadBytes, signature };
}
async function keys(c: PushContentMetadata): Promise<void> {
  const machine = publicKey(c.machinePublicKey);
  const device = publicKey(c.devicePublicKey);
  if (!ctEqual(await ridOf(machine), unhex(c.rid, 16, 16))) malformed();
  try {
    await crypto.subtle.importKey('raw', own(machine), 'Ed25519', false, ['verify']);
    await crypto.subtle.importKey('raw', own(device), 'Ed25519', false, ['verify']);
    await importEcPublic(point(c.pushPublicKey));
  } catch {
    malformed();
  }
}
export async function sealPushContent(
  machine: Signer,
  c: PushContentMetadata,
  p: SecurePushPayload,
  random: Rng,
): Promise<Bytes> {
  metadata(c);
  if (!ctEqual(machine.publicKey, publicKey(c.machinePublicKey)))
    throw new RelayError('BAD_SIGNATURE');
  await keys(c);
  const payloadBytes = buildPushPayload(p);
  const signature = await machine.sign(await buildPushContentSigningInput(c, payloadBytes));
  const inner = encodeSignedPushContent(c, payloadBytes, signature);
  return seal(point(c.pushPublicKey), pushAad(unhex(c.rid, 16, 16), c.collapseId), inner, random);
}
export async function openPushContent(
  recipient: EcPair,
  carrier: PushCarrier,
  authority: PushAuthority,
  now: number,
): Promise<{
  content: PushContentMetadata;
  payload: SecurePushPayload;
  contentDigest: string;
}> {
  object(carrier, ['v', 'rid', 'collapseId', 'keyVersion', 'kind', 'sealed']);
  object(authority, ['machinePublicKey', 'devicePublicKey', 'pushPublicKey', 'keyVersion']);
  if (
    carrier.v !== 2 ||
    carrier.keyVersion !== authority.keyVersion ||
    !ctEqual(recipient.publicKey, point(authority.pushPublicKey))
  )
    malformed();
  const rid = unhex(carrier.rid, 16, 16);
  if (!ctEqual(await ridOf(publicKey(authority.machinePublicKey)), rid)) malformed();
  binary(carrier.collapseId, 16);
  kind(carrier.kind);
  const inner = await openSeal(
    recipient,
    pushAad(rid, carrier.collapseId),
    fromB64u(carrier.sealed),
  );
  const decoded = decodeSignedPushContent(inner);
  const c = decoded.content;
  if (
    c.machinePublicKey !== authority.machinePublicKey ||
    c.rid !== carrier.rid ||
    c.devicePublicKey !== authority.devicePublicKey ||
    c.pushPublicKey !== authority.pushPublicKey ||
    c.keyVersion !== authority.keyVersion ||
    c.collapseId !== carrier.collapseId ||
    c.kind !== carrier.kind
  )
    malformed();
  await keys(c);
  live(c.issuedAt, c.expiresAt, now);
  const body = tupleBody(c, decoded.payloadBytes);
  const digest = await sha256(body);
  if (
    !(await verifySignature(
      publicKey(c.machinePublicKey),
      lps(LABEL.pushContent, digest),
      decoded.signature,
    ))
  )
    throw new RelayError('BAD_SIGNATURE');
  const parsed = parsePushPayload(decoded.payloadBytes);
  checkPayload(c, parsed);
  return { content: c, payload: parsed, contentDigest: hex(digest) };
}

function submission(value: unknown, signed: boolean): PushSubmit | UnsignedPushSubmit {
  const o = object(value, signed ? SUBMIT_KEYS : SUBMIT_KEYS.filter((k) => k !== 'signature'));
  if (o['v'] !== 2) malformed();
  const c = metadata(o, true);
  lifetime(c.issuedAt, c.expiresAt, PUSH_SUBMIT_TTL_SECONDS);
  const audience = str(o['audience'], 1, 512);
  try {
    const url = new URL(audience);
    // Scheme authorization is deployment-owned. Exact canonical origin excludes credentials,
    // path/query/fragment and leaves explicitly configured loopback test origins possible.
    if (url.origin !== audience || (url.protocol !== 'https:' && url.protocol !== 'http:'))
      malformed();
  } catch {
    malformed();
  }
  const environment = o['environment'];
  if (environment !== 'production' && environment !== 'sandbox') malformed();
  unhex(o['token'], 1, 256);
  if (typeof o['sealed'] !== 'string') malformed();
  const sealed = fromB64u(o['sealed']);
  if (sealed.length < 94 || sealed.length > 2141) malformed();
  const result: UnsignedPushSubmit = {
    v: 2,
    audience,
    rid: c.rid,
    machinePublicKey: c.machinePublicKey,
    devicePublicKey: c.devicePublicKey,
    pushPublicKey: c.pushPublicKey,
    keyVersion: c.keyVersion,
    token: o['token'] as string,
    environment,
    collapseId: c.collapseId,
    revision: c.revision,
    kind: c.kind,
    nonce: c.nonce,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    sealed: o['sealed'],
  };
  if (!signed) return result;
  binary(o['signature'], 64);
  return { ...result, signature: o['signature'] as string };
}
async function submitBody(value: UnsignedPushSubmit): Promise<Bytes> {
  const s = submission(value, false);
  return lps(
    'POST',
    `/v2/push/${s.rid}`,
    s.audience,
    publicKey(s.machinePublicKey),
    unhex(s.rid, 16, 16),
    publicKey(s.devicePublicKey),
    point(s.pushPublicKey),
    be64(s.keyVersion),
    unhex(s.token, 1, 256),
    Uint8Array.of(APNS_ENVIRONMENT_BYTE[s.environment]),
    s.collapseId,
    be64(s.revision),
    Uint8Array.of(PUSH_KIND_BYTE[s.kind]),
    binary(s.nonce, 32),
    be64(s.issuedAt),
    be64(s.expiresAt),
    await sha256(fromB64u(s.sealed)),
  );
}
export async function buildPushSubmitSigningInput(s: UnsignedPushSubmit): Promise<Bytes> {
  return lps(LABEL.pushSubmit, await sha256(await submitBody(s)));
}
export function encodePushSubmit(s: PushSubmit): string {
  const encoded = JSON.stringify(submission(s, true));
  if (utf8(encoded).length > MAX_PUSH_SUBMIT_BYTES) throw new RelayError('OVERSIZE');
  return encoded;
}
export function decodePushSubmit(encoded: string): PushSubmit {
  return submission(json(encoded, MAX_PUSH_SUBMIT_BYTES), true) as PushSubmit;
}
export async function verifyPushSubmit(
  s: PushSubmit,
  expected: { rid: string; audience: string },
  now: number,
): Promise<{ requestDigest: string }> {
  const checked = submission(s, true) as PushSubmit;
  if (checked.rid !== expected.rid || checked.audience !== expected.audience) malformed();
  await keys(checked);
  live(checked.issuedAt, checked.expiresAt, now);
  const { signature, ...unsigned } = checked;
  const digest = await sha256(await submitBody(unsigned));
  if (
    !(await verifySignature(
      publicKey(checked.machinePublicKey),
      lps(LABEL.pushSubmit, digest),
      binary(signature, 64),
    ))
  )
    throw new RelayError('BAD_SIGNATURE');
  return { requestDigest: hex(digest) };
}
function result(value: unknown): PushSubmitResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed();
  const raw = value as Record<string, unknown>;
  const outcome = raw['outcome'];
  if (outcome === 'accepted' || outcome === 'uncertain') {
    const o = object(value, ['v', 'requestDigest', 'outcome']);
    if (o['v'] !== 2) malformed();
    unhex(o['requestDigest'], 32, 32);
    return { v: 2, requestDigest: o['requestDigest'] as string, outcome };
  }
  const o = object(value, ['v', 'requestDigest', 'outcome', 'reason', 'retryable']);
  if (
    o['v'] !== 2 ||
    outcome !== 'rejected' ||
    typeof o['retryable'] !== 'boolean' ||
    !REASONS.includes(o['reason'] as PushRejectReason)
  )
    malformed();
  if (o['requestDigest'] !== null) unhex(o['requestDigest'], 32, 32);
  return {
    v: 2,
    requestDigest: o['requestDigest'] as string | null,
    outcome,
    reason: o['reason'] as PushRejectReason,
    retryable: o['retryable'] as boolean,
  };
}
export function encodePushSubmitResult(value: PushSubmitResult): string {
  return JSON.stringify(result(value));
}
export function decodePushSubmitResult(encoded: string): PushSubmitResult {
  return result(json(encoded, 1024));
}
