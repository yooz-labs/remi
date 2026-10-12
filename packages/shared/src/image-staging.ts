/** Dormant ADR 0041 wire codec; no authority, transfer, image decode or storage effects. */
import { fromB64u, fromUtf8, utf8 } from './relay/bytes.ts';
import { parseStrictJson } from './relay/strict-json.ts';

export const IMAGE_STAGING_CAPABILITY = 'image_staging';
export const IMAGE_STAGING_LIMITS = {
  frameBytes: 65536,
  imageBytes: 10485760,
  chunkBytes: 32768,
  maxSequence: 319,
  bindingBytes: 200,
} as const;
export const IMAGE_STAGING_REFUSAL_CODES = [
  'malformed',
  'unavailable',
  'busy',
  'conflict',
  'sequence',
  'integrity',
  'unsupported_media',
  'decode_failed',
  'expired',
  'binding_changed',
  'cleanup_failed',
] as const;
export type ImageStagingRefusalCode = (typeof IMAGE_STAGING_REFUSAL_CODES)[number];
export type ImageStagingMediaType = 'image/png' | 'image/jpeg';
export type ImageStagingOperation =
  | 'image_upload_begin'
  | 'image_upload_chunk'
  | 'image_upload_complete'
  | 'image_upload_cancel';
export interface ImageStagingBinding {
  harness: 'claude';
  harnessSessionId: string;
}
interface Envelope<T extends string> {
  type: T;
  id: string;
  timestamp: string;
  sessionId: string;
}
interface Response<T extends string> extends Envelope<T> {
  requestId: string;
}
export interface ImageUploadBegin extends Envelope<'image_upload_begin'> {
  binding: ImageStagingBinding;
  mediaType: ImageStagingMediaType;
  byteLength: number;
  digest: string;
}
export interface ImageUploadAccepted extends Response<'image_upload_accepted'> {
  transferId: string;
  expiresAt: string;
}
export interface ImageUploadChunk extends Envelope<'image_upload_chunk'> {
  transferId: string;
  seq: number;
  data: string;
}
export interface ImageUploadChunkAck extends Response<'image_upload_chunk_ack'> {
  transferId: string;
  seq: number;
  receivedBytes: number;
}
export interface ImageUploadComplete extends Envelope<'image_upload_complete'> {
  transferId: string;
}
export interface ImageUploadResult extends Response<'image_upload_result'> {
  transferId: string;
  outcome: 'staged';
  artifactId: string;
  artifactExpiresAt: string;
  byteLength: number;
  mediaType: ImageStagingMediaType;
  digest: string;
}
export interface ImageUploadCancel extends Envelope<'image_upload_cancel'> {
  transferId: string;
}
export interface ImageUploadCancelResult extends Response<'image_upload_cancel_result'> {
  transferId: string;
  outcome: 'cancelled';
}
export interface ImageUploadRefused extends Response<'image_upload_refused'> {
  operation: ImageStagingOperation;
  code: ImageStagingRefusalCode;
}
export type ImageStagingMessage =
  | ImageUploadBegin
  | ImageUploadAccepted
  | ImageUploadChunk
  | ImageUploadChunkAck
  | ImageUploadComplete
  | ImageUploadResult
  | ImageUploadCancel
  | ImageUploadCancelResult
  | ImageUploadRefused;

type Guard = (value: unknown) => boolean;
const scalar = (value: string): boolean => fromUtf8(utf8(value)) === value;
const uuid: Guard = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const uuid4: Guard = (v) =>
  uuid(v) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v as string);
const date: Guard = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  new Date(v).toISOString() === v;
const integer =
  (min: number, max: number): Guard =>
  (v) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const encoded =
  (min: number, max: number): Guard =>
  (value) => {
    if (typeof value !== 'string' || value.length > Math.ceil((max * 4) / 3)) return false;
    const bytes = fromB64u(value);
    return bytes.length >= min && bytes.length <= max;
  };
const exact = (value: unknown, fields: Record<string, Guard>): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== Object.keys(fields).length) return false;
  return Object.entries(fields).every(
    ([key, guard]) => Object.hasOwn(object, key) && guard(object[key]),
  );
};
const binding: Guard = (v) =>
  exact(v, {
    harness: (h) => h === 'claude',
    harnessSessionId: (s) =>
      typeof s === 'string' &&
      s.length > 0 &&
      scalar(s) &&
      utf8(s).length <= IMAGE_STAGING_LIMITS.bindingBytes &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(s),
  });
const transfer = encoded(16, 16);
const length = integer(1, IMAGE_STAGING_LIMITS.imageBytes);
const sequence = integer(0, IMAGE_STAGING_LIMITS.maxSequence);
const media: Guard = (v) => v === 'image/png' || v === 'image/jpeg';
const digest = encoded(32, 32);
const shapes: Record<ImageStagingMessage['type'], Record<string, Guard>> = {
  image_upload_begin: { binding, mediaType: media, byteLength: length, digest },
  image_upload_accepted: { requestId: uuid4, transferId: transfer, expiresAt: date },
  image_upload_chunk: {
    transferId: transfer,
    seq: sequence,
    data: encoded(1, IMAGE_STAGING_LIMITS.chunkBytes),
  },
  image_upload_chunk_ack: {
    requestId: uuid4,
    transferId: transfer,
    seq: sequence,
    receivedBytes: length,
  },
  image_upload_complete: { transferId: transfer },
  image_upload_result: {
    requestId: uuid4,
    transferId: transfer,
    outcome: (v) => v === 'staged',
    artifactId: transfer,
    artifactExpiresAt: date,
    byteLength: length,
    mediaType: media,
    digest,
  },
  image_upload_cancel: { transferId: transfer },
  image_upload_cancel_result: {
    requestId: uuid4,
    transferId: transfer,
    outcome: (v) => v === 'cancelled',
  },
  image_upload_refused: {
    requestId: uuid4,
    operation: (v) =>
      typeof v === 'string' &&
      [
        'image_upload_begin',
        'image_upload_chunk',
        'image_upload_complete',
        'image_upload_cancel',
      ].includes(v),
    code: (v) => IMAGE_STAGING_REFUSAL_CODES.some((code) => code === v),
  },
};
function validated(value: unknown): ImageStagingMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const type = object['type'];
  if (typeof type !== 'string' || !Object.hasOwn(shapes, type)) return null;
  if (
    !exact(object, {
      type: (v) => v === type,
      id: uuid4,
      timestamp: date,
      sessionId: uuid,
      ...shapes[type as ImageStagingMessage['type']],
    })
  )
    return null;
  if (type === 'image_upload_result' && object['artifactId'] === object['transferId']) return null;
  return object as unknown as ImageStagingMessage;
}
/** Bounds raw input before JSON parsing. Shape validity grants no transfer authority. */
export function decodeImageStagingFrame(input: string | Uint8Array): ImageStagingMessage | null {
  try {
    if (typeof input !== 'string' && !(input instanceof Uint8Array)) return null;
    if (input.length > IMAGE_STAGING_LIMITS.frameBytes) return null;
    const text = typeof input === 'string' ? input : fromUtf8(input);
    if (!scalar(text) || utf8(text).length > IMAGE_STAGING_LIMITS.frameBytes) return null;
    return validated(parseStrictJson(text, IMAGE_STAGING_LIMITS.frameBytes));
  } catch {
    return null;
  }
}
/** Invalid runtime values always produce the same error, without payload details. */
export function encodeImageStagingFrame(message: ImageStagingMessage): string {
  try {
    if (!validated(message)) throw new Error();
    const text = JSON.stringify(message);
    if (!decodeImageStagingFrame(text)) throw new Error();
    return text;
  } catch {
    throw new Error('Invalid image staging frame');
  }
}
