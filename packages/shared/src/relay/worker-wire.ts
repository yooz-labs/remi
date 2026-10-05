/**
 * The control messages between the relay Worker and its two kinds of endpoint
 * (ADR 0034 section 4 for admission, docs/relay-worker-v2.md for the rest).
 *
 * This is the layer BELOW the end-to-end protocol: the Worker speaks it to a
 * host or a client before a pipe exists, and never again afterwards. Once a
 * pipe is open the Worker forwards bytes and sends nothing of its own.
 *
 * Only what the Worker itself uses is here: it decodes what an endpoint sends
 * and encodes what it answers. The endpoint-side encoders belong to the phase
 * that has a caller for them (the daemon in R3, the client in R4); until then
 * the tests pin the bytes with literal strings, so the two sides cannot drift.
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
