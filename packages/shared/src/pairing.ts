/**
 * The pairing code a machine shows as a QR (#1275, ADR 0037): where the machine is, which key it
 * holds, and a single-use code that ties a phone's first connection to the `remi pair` run that
 * showed it.
 *
 * The code grants nothing. A phone that scans it still authenticates with its own key through the
 * `auth_challenge` exchange and still waits for the person at the machine to approve that key in
 * the terminal; the code only lets the terminal show which pending key came from this scan. It
 * holds no private key, capability, relay credential or secret that admits anyone.
 *
 * The text is `remi://pair#` followed by the base64url (no padding) of a JSON object whose keys come
 * in exactly the order of {@link PairingCode}, with no whitespace. A fragment is never sent anywhere
 * by a URL handler. Decoding is strict: one canonical form, every field required, no field the
 * version does not define, and a version this build does not know is refused by name.
 */

import { escapeUnsafeText } from './display-text.ts';
import { PROTOCOL_VERSION } from './protocol-version.ts';

/** The only pairing code version this build reads and writes. */
export const PAIRING_CODE_VERSION = 1;
/** What every pairing link starts with. */
export const PAIRING_LINK_PREFIX = 'remi://pair#';
/** How many random bytes a pairing nonce has. */
export const PAIRING_NONCE_BYTES = 16;
/** How long a code a machine shows stays valid. */
export const PAIRING_TTL_SECONDS = 300;

/** A code that claims to live longer than this is not one a machine made. */
const MAX_TTL_SECONDS = 900;
/** How far a phone's clock may be from the machine's before a code reads as expired or malformed. */
const CLOCK_SKEW_SECONDS = 120;
/** The longest link accepted, so a hostile QR cannot make a client parse megabytes. */
const MAX_LINK_LENGTH = 1024;
const MAX_NAME_LENGTH = 64;

/** A pairing code, in its canonical field order. */
export interface PairingCode {
  /** Always {@link PAIRING_CODE_VERSION}. */
  readonly v: number;
  /** The machine's name, for display: 1 to 64 characters, nothing `escapeUnsafeText` writes out. */
  readonly name: string;
  /** Where the phone connects: an IPv4 or IPv6 address (no brackets, no zone) or a DNS name. */
  readonly host: string;
  /** The hub's port. */
  readonly port: number;
  /**
   * The machine's Ed25519 public key, standard base64 of its 32 bytes: the same text as
   * `auth_challenge.serverPublicKey`, which the phone compares before it signs anything.
   */
  readonly key: string;
  /** The single-use code, base64url (no padding) of {@link PAIRING_NONCE_BYTES} random bytes. */
  readonly nonce: string;
  /** When the code expires, in Unix seconds. */
  readonly exp: number;
  /** The machine's `PROTOCOL_VERSION` (ADR 0035). */
  readonly proto: number;
}

const FIELD_ORDER = ['v', 'name', 'host', 'port', 'key', 'nonce', 'exp', 'proto'] as const;

/** Why a link was refused; each is its own message on a client. */
export type PairingCodeError =
  | 'NOT_A_PAIRING_LINK'
  | 'MALFORMED'
  | 'UNSUPPORTED_VERSION'
  | 'NOT_CANONICAL'
  | 'EXPIRED'
  | 'PROTOCOL_MISMATCH';

export type DecodedPairingLink =
  | { readonly ok: true; readonly code: PairingCode }
  | { readonly ok: false; readonly error: PairingCodeError; readonly detail: string };

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded =
    text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** A fresh nonce for a code, from the platform's cryptographic random source. */
export function generatePairingNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(PAIRING_NONCE_BYTES)));
}

/** Whether `nonce` is a canonical pairing nonce: 16 bytes, base64url, no padding. */
export function isPairingNonce(nonce: unknown): nonce is string {
  if (typeof nonce !== 'string') return false;
  const bytes = fromBase64Url(nonce);
  return bytes !== null && bytes.length === PAIRING_NONCE_BYTES && toBase64Url(bytes) === nonce;
}

function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/;
const DNS_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** An address a phone can dial: IPv4, IPv6 without brackets or a zone, or a DNS name. */
function isHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (IPV4.test(host)) return true;
  if (host.includes(':')) return IPV6.test(host) && host.split('::').length <= 2;
  // A name made only of digits and dots would read as an IPv4 address that failed to parse.
  if (/^[\d.]+$/.test(host)) return false;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return name.split('.').every((label) => DNS_LABEL.test(label));
}

/** Why `code` is not a valid version 1 code, or null. Expiry and protocol are checked separately. */
function shapeError(code: Record<string, unknown>): string | null {
  const keys = Object.keys(code);
  for (const key of keys) {
    if (!(FIELD_ORDER as readonly string[]).includes(key)) return `unknown field ${key}`;
  }
  for (const key of FIELD_ORDER) if (!(key in code)) return `missing field ${key}`;
  const { name, host, port, key, nonce, exp, proto } = code;
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    hasControl(name) ||
    escapeUnsafeText(name) !== name
  ) {
    return 'name';
  }
  if (typeof host !== 'string' || !isHost(host)) return 'host';
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return 'port';
  }
  if (typeof key !== 'string') return 'key';
  const keyBytes = fromBase64(key);
  if (keyBytes === null || keyBytes.length !== 32 || toBase64(keyBytes) !== key) return 'key';
  if (!isPairingNonce(nonce)) return 'nonce';
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp < 0) return 'exp';
  if (typeof proto !== 'number' || !Number.isSafeInteger(proto) || proto < 1) return 'proto';
  return null;
}

/** The link for `code`, in canonical form. Throws on a code that would not decode. */
export function encodePairingLink(code: PairingCode): string {
  const shape = shapeError(code as unknown as Record<string, unknown>);
  if (shape !== null || code.v !== PAIRING_CODE_VERSION) {
    throw new Error(`Not a valid pairing code (${shape ?? 'version'})`);
  }
  const ordered: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) ordered[key] = code[key];
  return PAIRING_LINK_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(ordered)));
}

/**
 * Reads a scanned or pasted link. Refuses, each with its own error: text that is not a pairing
 * link; a body that is not canonical base64url JSON in the field order; a version other than 1
 * (`UNSUPPORTED_VERSION`, read before anything else so a newer code is named as newer); a missing,
 * unknown or out-of-range field; an expired code (with two minutes for the clocks to differ); and a
 * protocol version other than the client's.
 */
export function decodePairingLink(
  text: string,
  options: { nowSeconds?: number; protocolVersion?: number } = {},
): DecodedPairingLink {
  const fail = (error: PairingCodeError, detail: string): DecodedPairingLink => ({
    ok: false,
    error,
    detail,
  });
  if (typeof text !== 'string' || !text.startsWith(PAIRING_LINK_PREFIX)) {
    return fail('NOT_A_PAIRING_LINK', 'not a remi://pair# link');
  }
  if (text.length > MAX_LINK_LENGTH) return fail('MALFORMED', 'too long');
  const body = text.slice(PAIRING_LINK_PREFIX.length);
  const bytes = fromBase64Url(body);
  if (bytes === null) return fail('MALFORMED', 'not base64url');
  if (toBase64Url(bytes) !== body) return fail('NOT_CANONICAL', 'base64url is not canonical');
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('MALFORMED', 'not UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail('MALFORMED', 'not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('MALFORMED', 'not an object');
  }
  const record = parsed as Record<string, unknown>;
  if (!('v' in record)) return fail('MALFORMED', 'missing field v');
  if (record['v'] !== PAIRING_CODE_VERSION) {
    return fail('UNSUPPORTED_VERSION', `version ${String(record['v'])}`);
  }
  const shape = shapeError(record);
  if (shape !== null) return fail('MALFORMED', shape);
  const code = record as unknown as PairingCode;
  const canonical = encodePairingLink(code);
  if (canonical !== text) return fail('NOT_CANONICAL', 'fields are not in canonical form');

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (code.exp + CLOCK_SKEW_SECONDS <= now) return fail('EXPIRED', 'the code has expired');
  if (code.exp > now + MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS) {
    return fail('MALFORMED', 'expiry too far ahead');
  }
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  if (code.proto !== protocolVersion) {
    return fail('PROTOCOL_MISMATCH', `machine speaks ${code.proto}, client ${protocolVersion}`);
  }
  return { ok: true, code };
}
