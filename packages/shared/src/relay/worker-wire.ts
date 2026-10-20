/**
 * The control messages between the relay Worker and its two kinds of endpoint
 * (ADR 0034 section 4 for admission, docs/relay-worker-v2.md for the rest).
 *
 * This is the layer BELOW the end-to-end protocol: the Worker speaks it to a
 * host or a client before a pipe exists, and never again afterwards. Once a
 * pipe is open the Worker forwards bytes and sends nothing of its own.
 *
 * Both sides share strict codecs: the Worker decodes admission/host commands
 * and encodes notices; the daemon and client encode their requests and decode
 * those notices. Literal wire tests independently pin the canonical bytes.
 *
 * Every decoder is strict and fails with `MALFORMED` (or `OVERSIZE`): an
 * unknown key, a wrong length or a non-canonical base64url value is a refusal,
 * and the Worker answers every refusal with the one generic close.
 */

import { type Bytes, b64u, fromB64u } from './bytes.ts';
import { PAIRING_TTL_SECONDS, RID_LEN } from './constants.ts';
import { RelayError } from './errors.ts';

/** Largest control message an endpoint may send the Worker, in bytes of UTF-8. */
export const MAX_WORKER_TEXT = 512;

export type WorkerRole = 'host' | 'client' | 'pipe';

/**
 * `/v2/host/<rid>`, `/v2/client/<rid>` or `/v2/pipe/<rid>/<cid>`; ids are lowercase hex.
 * The protocol version is part of the path and is never negotiated.
 */
export interface WorkerPath {
  readonly role: WorkerRole;
  readonly ridHex: string;
  readonly rid: Uint8Array;
  /** The connection id (pipe only), 16 random bytes as 32 hex digits. */
  readonly cid: string | null;
}

const PATH = /^\/v2\/(host|client)\/([0-9a-f]{32})$|^\/v2\/pipe\/([0-9a-f]{32})\/([0-9a-f]{32})$/;

const unhex = (h: string): Bytes =>
  Uint8Array.from(h.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** Null for any path that is not exactly one of the three routes. */
export function parseWorkerPath(pathname: string): WorkerPath | null {
  const m = PATH.exec(pathname);
  if (!m) return null;
  const ridHex = (m[2] ?? m[3]) as string;
  const role = (m[1] ?? 'pipe') as WorkerRole;
  const rid = unhex(ridHex);
  if (rid.length !== RID_LEN) return null;
  return { role, ridHex, rid, cid: m[4] ?? null };
}

// -- Worker to endpoint --

export type HostOp = 'enroll' | 'revoke' | 'pairing';

/**
 * What the Worker says, before a pipe opens:
 * - `nonce`: the first message on every socket (32 bytes, valid for that socket, once);
 * - `admitted`: admission passed; a client also learns whether the host is up;
 * - `host`: the host came or went while a client waited for its pipe;
 * - `open`: the pipe is formed, and from the next message on everything is the peer's;
 * - `connected` / `gone`: to the host, a client is waiting for a pipe / went away first;
 * - `ack`: to the host, the outcome of an `enroll`, `revoke` or `pairing` command.
 */
export type Notice =
  | { readonly t: 'nonce'; readonly nonce: Uint8Array }
  | { readonly t: 'admitted'; readonly hostUp?: boolean }
  | { readonly t: 'host'; readonly up: boolean }
  | { readonly t: 'open' }
  | { readonly t: 'connected'; readonly cid: string }
  | { readonly t: 'gone'; readonly cid: string }
  | { readonly t: 'ack'; readonly op: HostOp; readonly ok: boolean };

export function encodeNotice(n: Notice): string {
  switch (n.t) {
    case 'nonce':
      return JSON.stringify({ t: 'nonce', n: b64u(n.nonce) });
    case 'admitted':
      return JSON.stringify(
        n.hostUp === undefined ? { t: 'admitted' } : { t: 'admitted', up: n.hostUp },
      );
    case 'host':
      return JSON.stringify({ t: 'host', up: n.up });
    case 'open':
      return JSON.stringify({ t: 'open' });
    case 'connected':
    case 'gone':
      return JSON.stringify({ t: n.t, c: n.cid });
    case 'ack':
      return JSON.stringify({ t: 'ack', r: n.op, ok: n.ok });
  }
}

// -- Endpoint to Worker --

function parseObject(text: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof text !== 'string') throw new RelayError('TYPE');
  if (new TextEncoder().encode(text).length > MAX_WORKER_TEXT) throw new RelayError('OVERSIZE');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RelayError('MALFORMED');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RelayError('MALFORMED');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) throw new RelayError('MALFORMED');
  }
  return obj;
}

function field(obj: Record<string, unknown>, key: string, length: number): Bytes {
  const v = obj[key];
  if (typeof v !== 'string') throw new RelayError('MALFORMED');
  const bytes = fromB64u(v);
  if (bytes.length !== length) throw new RelayError('MALFORMED');
  return bytes;
}

/** `{"t":"admit","k":b64u(public key),"s":b64u(signature)[,"a":b64u(ticket)]}` */
export interface Admit {
  /** The Ed25519 public key: the machine key (host, pipe) or the device key (client). */
  readonly key: Uint8Array;
  readonly signature: Uint8Array;
  /** The pairing-window ticket `A` (clients only, and only while pairing). */
  readonly ticket?: Uint8Array;
}

export function decodeAdmit(text: unknown): Admit {
  const obj = parseObject(text, ['t', 'k', 's', 'a']);
  if (obj['t'] !== 'admit') throw new RelayError('TYPE');
  return {
    key: field(obj, 'k', 32),
    signature: field(obj, 's', 64),
    ...('a' in obj ? { ticket: field(obj, 'a', 32) } : {}),
  };
}

/**
 * What an admitted host may command, over its control socket only:
 * - `enroll` / `revoke`: add or remove a device key from the room's enrolled set;
 * - `pairing`: open a pairing window by registering `SHA-256(A)` for `ttl` seconds.
 */
export type HostCommand =
  | { readonly t: 'enroll' | 'revoke'; readonly key: Uint8Array }
  | { readonly t: 'pairing'; readonly ticketHash: Uint8Array; readonly ttlSeconds: number };

export function decodeHostCommand(text: unknown): HostCommand {
  const obj = parseObject(text, ['t', 'k', 'h', 'ttl']);
  switch (obj['t']) {
    case 'enroll':
    case 'revoke': {
      if ('h' in obj || 'ttl' in obj) throw new RelayError('MALFORMED');
      return { t: obj['t'], key: field(obj, 'k', 32) };
    }
    case 'pairing': {
      if ('k' in obj) throw new RelayError('MALFORMED');
      const ttl = obj['ttl'];
      if (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > PAIRING_TTL_SECONDS) {
        throw new RelayError('MALFORMED');
      }
      return { t: 'pairing', ticketHash: field(obj, 'h', 32), ttlSeconds: ttl as number };
    }
    default:
      throw new RelayError('TYPE');
  }
}

/** Endpoint codecs used by the hub control and pipe transports. Round-trip validation is strict. */
export function encodeAdmit(value: Admit): string {
  const text = JSON.stringify({
    t: 'admit',
    k: b64u(value.key),
    s: b64u(value.signature),
    ...(value.ticket ? { a: b64u(value.ticket) } : {}),
  });
  decodeAdmit(text);
  return text;
}
export function encodeHostCommand(value: HostCommand): string {
  const text =
    value.t === 'pairing'
      ? JSON.stringify({ t: value.t, h: b64u(value.ticketHash), ttl: value.ttlSeconds })
      : JSON.stringify({ t: value.t, k: b64u(value.key) });
  decodeHostCommand(text);
  return text;
}
export function decodeNotice(text: unknown): Notice {
  const value = parseObject(text, ['t', 'n', 'up', 'c', 'r', 'ok']);
  let notice: Notice;
  switch (value['t']) {
    case 'nonce':
      notice = { t: 'nonce', nonce: field(value, 'n', 32) };
      break;
    case 'admitted':
      if ('up' in value && typeof value['up'] !== 'boolean') throw new RelayError('MALFORMED');
      notice = { t: 'admitted', ...('up' in value ? { hostUp: value['up'] as boolean } : {}) };
      break;
    case 'host':
      if (typeof value['up'] !== 'boolean') throw new RelayError('MALFORMED');
      notice = { t: 'host', up: value['up'] };
      break;
    case 'open':
      notice = { t: 'open' };
      break;
    case 'connected':
    case 'gone':
      if (typeof value['c'] !== 'string' || !/^[0-9a-f]{32}$/.test(value['c']))
        throw new RelayError('MALFORMED');
      notice = { t: value['t'], cid: value['c'] };
      break;
    case 'ack':
      if (
        !['enroll', 'revoke', 'pairing'].includes(String(value['r'])) ||
        typeof value['ok'] !== 'boolean'
      )
        throw new RelayError('MALFORMED');
      notice = { t: 'ack', op: value['r'] as HostOp, ok: value['ok'] };
      break;
    default:
      throw new RelayError('TYPE');
  }
  // Canonical comparison rejects unrelated fields, alternate order and duplicate keys.
  if (encodeNotice(notice) !== text) throw new RelayError('MALFORMED');
  return notice;
}
