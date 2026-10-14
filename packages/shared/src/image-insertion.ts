/** ADR0042 strict structural codec. Effect authority remains with the original host lease. */
import type { ImageStagingBinding } from './image-staging';
import {
  type Guard,
  binding,
  date,
  encoded,
  exact,
  imageWireValue,
  scalarJson,
  uuid,
  uuid4,
} from './image-wire';

export const IMAGE_INSERTION_CAPABILITY = 'image_insertion';
export const IMAGE_INSERTION_REFUSAL_CODES = [
  'malformed',
  'unavailable',
  'busy',
  'conflict',
  'expired',
  'binding_changed',
  'prompt_up',
] as const;
export type ImageInsertionRefusalCode = (typeof IMAGE_INSERTION_REFUSAL_CODES)[number];

interface Envelope {
  id: string;
  timestamp: string;
  sessionId: string;
}
export interface ImageInsertRequest extends Envelope {
  type: 'image_insert_request';
  binding: ImageStagingBinding;
  artifactId: string;
}
export type ImageInsertResult = Envelope & { type: 'image_insert_result'; requestId: string } & (
    | { outcome: 'inserted'; code: 'none' }
    | { outcome: 'refused'; code: ImageInsertionRefusalCode }
    | { outcome: 'uncertain'; code: 'delivery_unknown' }
  );
export type ImageInsertionMessage = ImageInsertRequest | ImageInsertResult;

export interface ImageInsertionCorrelation {
  requestId: string;
  sessionId: string;
  artifactId: string | null;
}
export type ImageInsertionIngressResult =
  | { kind: 'request'; request: ImageInsertRequest }
  | { kind: 'malformed'; correlation: ImageInsertionCorrelation }
  | { kind: 'uncorrelatable' };

function validated(value: unknown): ImageInsertionMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const type = object['type'];
  const fields: Record<string, Guard> = {
    type: (v) => v === type,
    id: uuid4,
    timestamp: date,
    sessionId: uuid,
  };
  if (type === 'image_insert_request') {
    if (!exact(object, { ...fields, binding, artifactId: encoded(16, 16) })) return null;
  } else if (type === 'image_insert_result') {
    if (
      !exact(object, {
        ...fields,
        requestId: uuid4,
        outcome: (v) => v === 'inserted' || v === 'refused' || v === 'uncertain',
        code: (v) =>
          v === 'none' ||
          v === 'delivery_unknown' ||
          IMAGE_INSERTION_REFUSAL_CODES.some((c) => c === v),
      })
    )
      return null;
    const outcome = object['outcome'];
    const code = object['code'];
    if (
      !(
        (outcome === 'inserted' && code === 'none') ||
        (outcome === 'uncertain' && code === 'delivery_unknown') ||
        (outcome === 'refused' && IMAGE_INSERTION_REFUSAL_CODES.some((c) => c === code))
      )
    )
      return null;
  } else return null;
  return object as unknown as ImageInsertionMessage;
}

/** Bound original bytes before strict JSON and semantic validation. */
export function decodeImageInsertionFrame(
  input: string | Uint8Array,
): ImageInsertionMessage | null {
  try {
    return validated(imageWireValue(input));
  } catch {
    return null;
  }
}

/** A guarded envelope can locate an existing owner for refusal; it grants no authority. */
export function decodeImageInsertionIngress(
  input: string | Uint8Array,
): ImageInsertionIngressResult {
  try {
    const value = imageWireValue(input);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !scalarJson(value))
      return { kind: 'uncorrelatable' };
    const object = value as Record<string, unknown>;
    if (
      object['type'] !== 'image_insert_request' ||
      !uuid4(object['id']) ||
      !uuid(object['sessionId']) ||
      !date(object['timestamp'])
    )
      return { kind: 'uncorrelatable' };
    try {
      const request = validated(value);
      if (request?.type === 'image_insert_request') return { kind: 'request', request };
    } catch {
      // Invalid body encodings still have the independently guarded envelope.
    }
    let artifactId: string | null = null;
    try {
      if (encoded(16, 16)(object['artifactId'])) artifactId = object['artifactId'] as string;
    } catch {
      // A noncanonical artifact hint does not identify a retained artifact.
    }
    return {
      kind: 'malformed',
      correlation: {
        requestId: object['id'] as string,
        sessionId: object['sessionId'] as string,
        artifactId,
      },
    };
  } catch {
    return { kind: 'uncorrelatable' };
  }
}

/** Runtime invalid fields/pairs produce one payload-free error. */
export function encodeImageInsertionFrame(message: ImageInsertionMessage): string {
  try {
    if (!validated(message)) throw new Error();
    const text = JSON.stringify(message);
    if (!decodeImageInsertionFrame(text)) throw new Error();
    return text;
  } catch {
    throw new Error('Invalid image insertion frame');
  }
}
