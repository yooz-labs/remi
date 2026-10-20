/**
 * #1207 structured submission shapes, used by the dedicated direct ingress.
 * Shape validity grants no session/device authority and performs no RPC.
 */
import { fromUtf8, utf8 } from './relay/bytes.ts';
import { parseStrictJson } from './relay/strict-json.ts';

export const STRUCTURED_CHAT_CAPABILITY = 'structured_chat';
export const STRUCTURED_CHAT_LIMITS = {
  textBytes: 16 * 1024,
  // JSON escaping can expand a valid text byte to six frame bytes.
  frameBytes: 128 * 1024,
  maxSequence: 0xffffffff,
} as const;
export const CHAT_SUBMIT_REFUSAL_CODES = [
  'malformed',
  'unavailable',
  'binding_changed',
  'prompt_up',
  'busy',
  'conflict',
  'sequence',
  'unsupported',
] as const;
export type ChatSubmitRefusalCode = (typeof CHAT_SUBMIT_REFUSAL_CODES)[number];
export const CHAT_SUBMIT_UNCERTAIN_CODES = [
  'delivery_unknown',
  'receipt_expired',
  'conflict',
] as const;
export type ChatSubmitUncertainCode = (typeof CHAT_SUBMIT_UNCERTAIN_CODES)[number];

interface Envelope<T extends string> {
  readonly type: T;
  readonly id: string;
  readonly timestamp: string;
  readonly sessionId: string;
  /** Starts at one per concrete connection/Remi session; not reset by binding or attachment. */
  readonly seq: number;
}
export interface ChatSubmitRequest extends Envelope<'chat_submit_request'> {
  readonly binding: { readonly harness: 'codex'; readonly harnessSessionId: string };
  readonly content: string;
}
interface ResultEnvelope extends Envelope<'chat_submit_result'> {
  readonly requestId: string;
}
export type ChatSubmitOutcome =
  | {
      readonly outcome: 'accepted';
      readonly method: 'turn/start' | 'turn/steer';
      readonly turnId: string;
    }
  | { readonly outcome: 'refused'; readonly code: ChatSubmitRefusalCode }
  | { readonly outcome: 'uncertain'; readonly code: ChatSubmitUncertainCode };
export type ChatSubmitResult = ResultEnvelope & ChatSubmitOutcome;
export type StructuredChatMessage = ChatSubmitRequest | ChatSubmitResult;

type Guard = (value: unknown) => boolean;
const uuid: Guard = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const uuid4: Guard = (v) =>
  uuid(v) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v as string);
const date: Guard = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  new Date(v).toISOString() === v;
const sequence: Guard = (v) =>
  typeof v === 'number' &&
  Number.isSafeInteger(v) &&
  v >= 1 &&
  v <= STRUCTURED_CHAT_LIMITS.maxSequence;
const exact = (value: unknown, fields: Record<string, Guard>): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    Object.keys(object).length === Object.keys(fields).length &&
    Object.entries(fields).every(
      ([key, guard]) => Object.prototype.hasOwnProperty.call(object, key) && guard(object[key]),
    )
  );
};

/** Unicode scalar text, retaining a leading BOM as content. No content normalization. */
export function validChatSubmitText(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > STRUCTURED_CHAT_LIMITS.textBytes ||
    value.trim().length === 0 ||
    value.includes('\0')
  )
    return false;
  const bytes = utf8(value);
  return bytes.length <= STRUCTURED_CHAT_LIMITS.textBytes && fromUtf8(bytes) === value;
}

function validated(value: unknown): StructuredChatMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const type = object['type'];
  const envelope = {
    type: (v: unknown) => v === type,
    id: uuid4,
    timestamp: date,
    sessionId: uuid,
    seq: sequence,
  };
  if (type === 'chat_submit_request') {
    return exact(object, {
      ...envelope,
      binding: (v) => exact(v, { harness: (h) => h === 'codex', harnessSessionId: uuid }),
      content: validChatSubmitText,
    })
      ? (object as unknown as ChatSubmitRequest)
      : null;
  }
  if (type !== 'chat_submit_result') return null;
  const result = { ...envelope, requestId: uuid4 };
  let fields: Record<string, Guard>;
  switch (object['outcome']) {
    case 'accepted':
      fields = {
        ...result,
        outcome: (v) => v === 'accepted',
        method: (v) => v === 'turn/start' || v === 'turn/steer',
        turnId: uuid,
      };
      break;
    case 'refused':
      fields = {
        ...result,
        outcome: (v) => v === 'refused',
        code: (v) => CHAT_SUBMIT_REFUSAL_CODES.some((code) => code === v),
      };
      break;
    case 'uncertain':
      fields = {
        ...result,
        outcome: (v) => v === 'uncertain',
        code: (v) => CHAT_SUBMIT_UNCERTAIN_CODES.some((code) => code === v),
      };
      break;
    default:
      return null;
  }
  return exact(object, fields) ? (object as unknown as ChatSubmitResult) : null;
}

/** Strict bounded raw JSON/UTF-8 decoding; no duplicate decoded member names. */
export function decodeStructuredChatFrame(
  input: string | Uint8Array,
): StructuredChatMessage | null {
  try {
    if (typeof input !== 'string' && !(input instanceof Uint8Array)) return null;
    if (input.length > STRUCTURED_CHAT_LIMITS.frameBytes) return null;
    const text = typeof input === 'string' ? input : fromUtf8(input);
    if (fromUtf8(utf8(text)) !== text || utf8(text).length > STRUCTURED_CHAT_LIMITS.frameBytes)
      return null;
    return validated(parseStrictJson(text, STRUCTURED_CHAT_LIMITS.frameBytes));
  } catch {
    return null;
  }
}

/** Invalid values produce no frame; error text never includes a message's content. */
export function encodeStructuredChatFrame(message: StructuredChatMessage): string {
  try {
    if (!validated(message)) throw new Error();
    const text = JSON.stringify(message);
    if (!decodeStructuredChatFrame(text)) throw new Error();
    return text;
  } catch {
    throw new Error('Invalid structured chat frame');
  }
}
