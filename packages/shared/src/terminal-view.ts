/** ADR0047 structural screen codec only; shape validity grants no authority or view lease. */
import {
  type Guard,
  IMAGE_WIRE_LIMITS,
  date,
  encoded,
  exact,
  imageWireValue,
  integer,
  scalar,
  scalarJson,
  uuid,
  uuid4,
} from './image-wire.ts';
import { utf8 } from './relay/bytes.ts';

export const TERMINAL_VIEW_LIMITS = {
  frameBytes: IMAGE_WIRE_LIMITS.frameBytes,
  textBytes: 32768,
  cellBytes: 64,
  minimumColumns: 2,
  columns: 240,
  rows: 60,
  bindingBytes: IMAGE_WIRE_LIMITS.bindingBytes,
} as const;
export const TERMINAL_VIEW_OPERATIONS = [
  'session_terminal_open',
  'session_terminal_read',
  'session_terminal_close',
] as const;
export type TerminalViewOperation = (typeof TERMINAL_VIEW_OPERATIONS)[number];
export const TERMINAL_VIEW_REFUSAL_CODES = [
  'malformed',
  'unavailable',
  'busy',
  'expired',
  'binding_changed',
  'unsupported_screen',
] as const;
export type TerminalViewRefusalCode = (typeof TERMINAL_VIEW_REFUSAL_CODES)[number];
export interface TerminalViewBinding {
  readonly harness: 'claude' | 'codex';
  readonly harnessSessionId: string;
}
interface Envelope<T extends string> {
  readonly type: T;
  readonly id: string;
  readonly timestamp: string;
  readonly sessionId: string;
}
interface Response<T extends string> extends Envelope<T> {
  readonly requestId: string;
}
export interface SessionTerminalOpen extends Envelope<'session_terminal_open'> {
  readonly binding: TerminalViewBinding;
}
export interface SessionTerminalOpened extends Response<'session_terminal_opened'> {
  readonly viewId: string;
  readonly expiresAt: string;
}
export interface SessionTerminalRead extends Envelope<'session_terminal_read'> {
  readonly viewId: string;
  readonly afterRevision: number | null;
}
export interface SessionTerminalSnapshot extends Response<'session_terminal_snapshot'> {
  readonly viewId: string;
  readonly revision: number;
  readonly columns: number;
  readonly rows: number;
  readonly lines: readonly string[];
  readonly cursor: { readonly row: number; readonly column: number } | null;
}
export interface SessionTerminalUnchanged extends Response<'session_terminal_unchanged'> {
  readonly viewId: string;
  readonly revision: number;
}
export interface SessionTerminalClose extends Envelope<'session_terminal_close'> {
  readonly viewId: string;
}
export interface SessionTerminalClosed extends Response<'session_terminal_closed'> {
  readonly viewId: string;
}
export interface SessionTerminalRefused extends Response<'session_terminal_refused'> {
  readonly operation: TerminalViewOperation;
  readonly code: TerminalViewRefusalCode;
}
export type TerminalViewMessage =
  | SessionTerminalOpen
  | SessionTerminalOpened
  | SessionTerminalRead
  | SessionTerminalSnapshot
  | SessionTerminalUnchanged
  | SessionTerminalClose
  | SessionTerminalClosed
  | SessionTerminalRefused;
export type TerminalViewRequest = Extract<TerminalViewMessage, { type: TerminalViewOperation }>;

const viewId = encoded(16, 16);
const revision = integer(0, Number.MAX_SAFE_INTEGER);
const binding: Guard = (value) =>
  exact(value, {
    harness: (value) => value === 'claude' || value === 'codex',
    harnessSessionId: (value) =>
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= TERMINAL_VIEW_LIMITS.bindingBytes &&
      scalar(value) &&
      utf8(value).length <= TERMINAL_VIEW_LIMITS.bindingBytes &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  });
// Screen text is inert: no row separators, terminal commands or misleading direction controls.
const unsafeText =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]|\u200d/u;

function screenLines(value: unknown, columns: number, rows: number): boolean {
  if (!Array.isArray(value) || value.length !== rows) return false;
  let bytes = 0;
  return value.every((line) => {
    if (
      typeof line !== 'string' ||
      line.length > columns * TERMINAL_VIEW_LIMITS.cellBytes ||
      !scalar(line) ||
      unsafeText.test(line)
    )
      return false;
    const length = utf8(line).length;
    bytes += length;
    // This is a cell-storage upper bound, not a font/display-width calculation.
    return (
      length <= columns * TERMINAL_VIEW_LIMITS.cellBytes && bytes <= TERMINAL_VIEW_LIMITS.textBytes
    );
  });
}

function validated(value: unknown): TerminalViewMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const type = object['type'];
  const envelope = {
    type: (value: unknown) => value === type,
    id: uuid4,
    timestamp: date,
    sessionId: uuid,
  };
  const response = { ...envelope, requestId: uuid4 };
  let valid = false;
  if (type === 'session_terminal_open') valid = exact(object, { ...envelope, binding });
  else if (type === 'session_terminal_opened')
    valid = exact(object, { ...response, viewId, expiresAt: date });
  else if (type === 'session_terminal_read')
    valid = exact(object, {
      ...envelope,
      viewId,
      afterRevision: (value) => value === null || revision(value),
    });
  else if (type === 'session_terminal_close') valid = exact(object, { ...envelope, viewId });
  else if (type === 'session_terminal_closed') valid = exact(object, { ...response, viewId });
  else if (type === 'session_terminal_unchanged')
    valid = exact(object, { ...response, viewId, revision });
  else if (type === 'session_terminal_refused')
    valid = exact(object, {
      ...response,
      operation: (value) => TERMINAL_VIEW_OPERATIONS.some((operation) => operation === value),
      code: (value) => TERMINAL_VIEW_REFUSAL_CODES.some((code) => code === value),
    });
  else if (type === 'session_terminal_snapshot') {
    const columns = object['columns'];
    const rows = object['rows'];
    if (
      !integer(TERMINAL_VIEW_LIMITS.minimumColumns, TERMINAL_VIEW_LIMITS.columns)(columns) ||
      !integer(1, TERMINAL_VIEW_LIMITS.rows)(rows)
    )
      return null;
    valid = exact(object, {
      ...response,
      viewId,
      revision,
      columns: (value) => value === columns,
      rows: (value) => value === rows,
      lines: (value) => screenLines(value, columns as number, rows as number),
      cursor: (value) =>
        value === null ||
        exact(value, {
          row: integer(0, (rows as number) - 1),
          column: integer(0, (columns as number) - 1),
        }),
    });
  }
  return valid ? (object as unknown as TerminalViewMessage) : null;
}

/** Reject JSON coercions/accessors before validating or serializing an owned runtime value. */
function jsonSafe(value: unknown, ancestors = new Set<object>(), budget = { nodes: 0 }): boolean {
  if (++budget.nodes > 256 || ancestors.size > 8) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || 'toJSON' in value) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return false;
  if (Object.getOwnPropertySymbols(value).length || ancestors.has(value)) return false;
  const names = Object.getOwnPropertyNames(value);
  if (array && (value.length > TERMINAL_VIEW_LIMITS.rows || names.length !== value.length + 1))
    return false;
  ancestors.add(value);
  const valid = names.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return false;
    if (array && key === 'length') return true;
    if (array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) return false;
    return descriptor.enumerable === true && jsonSafe(descriptor.value, ancestors, budget);
  });
  ancestors.delete(value);
  return valid;
}

/** Strict original raw-frame decoding; no authority, revision freshness or lease admission. */
export function decodeTerminalViewFrame(input: string | Uint8Array): TerminalViewMessage | null {
  try {
    const value = imageWireValue(input);
    return scalarJson(value) ? validated(value) : null;
  } catch {
    return null;
  }
}

/** Invalid runtime values produce one payload-free error and invoke no accessors/toJSON. */
export function encodeTerminalViewFrame(message: TerminalViewMessage): string {
  try {
    if (!jsonSafe(message) || !validated(message)) throw new Error();
    const raw = JSON.stringify(message);
    if (!decodeTerminalViewFrame(raw)) throw new Error();
    return raw;
  } catch {
    throw new Error('Invalid terminal view frame');
  }
}
