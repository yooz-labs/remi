/** ADR 0045 structural download codec; shape validity grants no access or transfer authority. */
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

export const FILE_DOWNLOAD_LIMITS = {
  frameBytes: IMAGE_WIRE_LIMITS.frameBytes,
  bindingBytes: IMAGE_WIRE_LIMITS.bindingBytes,
  relativePathBytes: 4096,
  pathComponents: 64,
  pathComponentBytes: 255,
  fileNameBytes: 255,
  fileBytes: 10485760,
  chunkBytes: 32768,
  maxSequence: 319,
} as const;

export const FILE_DOWNLOAD_OPERATIONS = [
  'file_fetch_begin',
  'file_fetch_read',
  'file_fetch_complete',
  'file_fetch_cancel',
] as const;
export type FileDownloadOperation = (typeof FILE_DOWNLOAD_OPERATIONS)[number];

export const FILE_DOWNLOAD_REFUSAL_CODES = [
  'malformed',
  'unavailable',
  'busy',
  'conflict',
  'sequence',
  'integrity',
  'empty_file',
  'expired',
  'binding_changed',
  'cleanup_failed',
] as const;
export type FileDownloadRefusalCode = (typeof FILE_DOWNLOAD_REFUSAL_CODES)[number];

export interface FileDownloadBinding {
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

export interface FileFetchBegin extends Envelope<'file_fetch_begin'> {
  readonly binding: FileDownloadBinding;
  readonly relativePath: string;
}

export interface FileFetchAccepted extends Response<'file_fetch_accepted'> {
  readonly transferId: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly mediaType: 'application/octet-stream';
  readonly digest: string;
  readonly expiresAt: string;
}

export interface FileFetchRead extends Envelope<'file_fetch_read'> {
  readonly transferId: string;
  readonly seq: number;
  readonly receivedBytes: number;
}

export interface FileFetchChunk extends Response<'file_fetch_chunk'> {
  readonly transferId: string;
  readonly seq: number;
  readonly data: string;
}

export interface FileFetchComplete extends Envelope<'file_fetch_complete'> {
  readonly transferId: string;
  readonly receivedBytes: number;
  readonly digest: string;
}

export interface FileFetchResult extends Response<'file_fetch_result'> {
  readonly transferId: string;
  readonly outcome: 'complete';
}

export interface FileFetchCancel extends Envelope<'file_fetch_cancel'> {
  readonly beginId: string;
}

export interface FileFetchCancelResult extends Response<'file_fetch_cancel_result'> {
  readonly beginId: string;
  readonly outcome: 'cancelled';
}

export interface FileFetchRefused extends Response<'file_fetch_refused'> {
  readonly operation: FileDownloadOperation;
  readonly code: FileDownloadRefusalCode;
}

export type FileDownloadMessage =
  | FileFetchBegin
  | FileFetchAccepted
  | FileFetchRead
  | FileFetchChunk
  | FileFetchComplete
  | FileFetchResult
  | FileFetchCancel
  | FileFetchCancelResult
  | FileFetchRefused;

const transferId = encoded(16, 16);
const digest = encoded(32, 32);
const fileLength = integer(1, FILE_DOWNLOAD_LIMITS.fileBytes);
const sequence = integer(0, FILE_DOWNLOAD_LIMITS.maxSequence);
const receivedBytes = integer(0, FILE_DOWNLOAD_LIMITS.fileBytes);
const chunkData = encoded(1, FILE_DOWNLOAD_LIMITS.chunkBytes);
const unsafeComponentText =
  /[/:\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const binding: Guard = (value) =>
  exact(value, {
    harness: (harness) => harness === 'claude' || harness === 'codex',
    harnessSessionId: (sessionId) =>
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      sessionId.length <= FILE_DOWNLOAD_LIMITS.bindingBytes &&
      scalar(sessionId) &&
      utf8(sessionId).length <= FILE_DOWNLOAD_LIMITS.bindingBytes &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(sessionId),
  });

/** Structural path syntax only; no denied-name, protected-root or filesystem check occurs here. */
function relativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > FILE_DOWNLOAD_LIMITS.relativePathBytes ||
    !scalar(value)
  )
    return false;
  const bytes = utf8(value);
  if (bytes.length > FILE_DOWNLOAD_LIMITS.relativePathBytes) return false;

  const components = value.split('/');
  return (
    components.length <= FILE_DOWNLOAD_LIMITS.pathComponents &&
    components.every((component) => {
      if (
        component.length === 0 ||
        component.length > FILE_DOWNLOAD_LIMITS.pathComponentBytes ||
        unsafeComponentText.test(component)
      )
        return false;
      return utf8(component).length <= FILE_DOWNLOAD_LIMITS.pathComponentBytes;
    })
  );
}

/** Inert basename syntax only; admission and equality with the request path are later checks. */
function fileName(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > FILE_DOWNLOAD_LIMITS.fileNameBytes ||
    !scalar(value) ||
    unsafeComponentText.test(value)
  )
    return false;
  return utf8(value).length <= FILE_DOWNLOAD_LIMITS.fileNameBytes;
}

function validated(value: unknown): FileDownloadMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const type = object['type'];
  const envelope = {
    type: (candidate: unknown) => candidate === type,
    id: uuid4,
    timestamp: date,
    sessionId: uuid,
  };

  if (type === 'file_fetch_begin') {
    return exact(object, { ...envelope, binding, relativePath })
      ? (object as unknown as FileFetchBegin)
      : null;
  }

  if (type === 'file_fetch_accepted') {
    return exact(object, {
      ...envelope,
      requestId: uuid4,
      transferId,
      fileName,
      byteLength: fileLength,
      mediaType: (mediaType) => mediaType === 'application/octet-stream',
      digest,
      expiresAt: date,
    })
      ? (object as unknown as FileFetchAccepted)
      : null;
  }

  if (type === 'file_fetch_read') {
    return exact(object, {
      ...envelope,
      transferId,
      seq: sequence,
      receivedBytes,
    })
      ? (object as unknown as FileFetchRead)
      : null;
  }

  if (type === 'file_fetch_chunk') {
    return exact(object, {
      ...envelope,
      requestId: uuid4,
      transferId,
      seq: sequence,
      data: chunkData,
    })
      ? (object as unknown as FileFetchChunk)
      : null;
  }

  if (type === 'file_fetch_complete') {
    return exact(object, {
      ...envelope,
      transferId,
      receivedBytes,
      digest,
    })
      ? (object as unknown as FileFetchComplete)
      : null;
  }

  if (type === 'file_fetch_result') {
    return exact(object, {
      ...envelope,
      requestId: uuid4,
      transferId,
      outcome: (outcome) => outcome === 'complete',
    })
      ? (object as unknown as FileFetchResult)
      : null;
  }

  if (type === 'file_fetch_cancel') {
    return exact(object, { ...envelope, beginId: uuid4 })
      ? (object as unknown as FileFetchCancel)
      : null;
  }

  if (type === 'file_fetch_cancel_result') {
    return exact(object, {
      ...envelope,
      requestId: uuid4,
      beginId: uuid4,
      outcome: (outcome) => outcome === 'cancelled',
    })
      ? (object as unknown as FileFetchCancelResult)
      : null;
  }

  if (type === 'file_fetch_refused') {
    return exact(object, {
      ...envelope,
      requestId: uuid4,
      operation: (operation) =>
        FILE_DOWNLOAD_OPERATIONS.some((candidate) => candidate === operation),
      code: (code) => FILE_DOWNLOAD_REFUSAL_CODES.some((candidate) => candidate === code),
    })
      ? (object as unknown as FileFetchRefused)
      : null;
  }

  return null;
}

/** Reject values JSON would discard/coerce before the original runtime message is validated. */
function jsonSafe(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean') return true;
  // Field guards check scalar strings after applying each field's cheap length bound.
  if (typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || 'toJSON' in value) return false;
  if (Object.getOwnPropertySymbols(value).length > 0 || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.getOwnPropertyNames(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor?.enumerable === true &&
      'value' in descriptor &&
      jsonSafe(descriptor.value, ancestors)
    );
  });
  ancestors.delete(value);
  return valid;
}

/** Strict bounded raw JSON/UTF-8 decoding; shape validity grants no admission or transfer state. */
export function decodeFileDownloadFrame(input: string | Uint8Array): FileDownloadMessage | null {
  try {
    const value = imageWireValue(input);
    return scalarJson(value) ? validated(value) : null;
  } catch {
    return null;
  }
}

/** Invalid runtime values produce one payload-free error. */
export function encodeFileDownloadFrame(message: FileDownloadMessage): string {
  try {
    if (!jsonSafe(message) || !validated(message)) throw new Error();
    const text = JSON.stringify(message);
    if (typeof text !== 'string' || !decodeFileDownloadFrame(text)) throw new Error();
    return text;
  } catch {
    throw new Error('Invalid file download frame');
  }
}
