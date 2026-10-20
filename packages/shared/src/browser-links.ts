/** ADR 0044 structural browser-link codecs; validity grants no delivery authority. */
import {
  IMAGE_WIRE_LIMITS,
  date,
  exact,
  imageWireValue,
  integer,
  scalarJson,
  uuid,
  uuid4,
} from './image-wire.ts';
import { utf8 } from './relay/bytes.ts';

export const BROWSER_LINKS_CAPABILITY = 'browser_links';
export const BROWSER_LINKS_LIMITS = {
  frameBytes: IMAGE_WIRE_LIMITS.frameBytes,
  urlBytes: 4096,
  lifetimeMs: 120000,
  maxSequence: 0xffffffff,
} as const;

export const BROWSER_LINK_RECEIVER_ACTIONS = ['select', 'release'] as const;
export type BrowserLinkReceiverAction = (typeof BROWSER_LINK_RECEIVER_ACTIONS)[number];

export const BROWSER_LINK_REFUSAL_CODES = [
  'unavailable',
  'unsupported',
  'binding_changed',
  'capacity',
  'sequence',
  'conflict',
  'stale_receiver',
] as const;
export type BrowserLinkRefusalCode = (typeof BROWSER_LINK_REFUSAL_CODES)[number];

export const BROWSER_LINK_ENDED_REASONS = [
  'released',
  'replaced',
  'session_changed',
  'disconnected',
] as const;
export type BrowserLinkEndedReason = (typeof BROWSER_LINK_ENDED_REASONS)[number];

export interface BrowserLinkBinding {
  readonly harness: 'claude';
  readonly harnessSessionId: string;
}

interface BrowserLinkEnvelope<T extends string> {
  readonly type: T;
  readonly id: string;
  readonly timestamp: string;
}

export interface BrowserLinkReceiverRequest
  extends BrowserLinkEnvelope<'browser_link_receiver_request'> {
  readonly sessionId: string;
  readonly binding: BrowserLinkBinding;
  readonly seq: number;
  readonly action: BrowserLinkReceiverAction;
}

interface BrowserLinkReceiverResultEnvelope
  extends BrowserLinkEnvelope<'browser_link_receiver_result'> {
  readonly sessionId: string;
  readonly seq: number;
  readonly requestId: string;
}

export type BrowserLinkReceiverResult =
  | (BrowserLinkReceiverResultEnvelope & {
      readonly outcome: 'selected';
      readonly leaseId: string;
    })
  | (BrowserLinkReceiverResultEnvelope & { readonly outcome: 'released' })
  | (BrowserLinkReceiverResultEnvelope & {
      readonly outcome: 'refused';
      readonly code: BrowserLinkRefusalCode;
    });

export interface BrowserLinkReceiverEnded
  extends BrowserLinkEnvelope<'browser_link_receiver_ended'> {
  readonly sessionId: string;
  readonly leaseId: string;
  readonly reason: BrowserLinkEndedReason;
}

export interface BrowserLinkCandidate extends BrowserLinkEnvelope<'browser_link_candidate'> {
  readonly sessionId: string;
  readonly binding: BrowserLinkBinding;
  readonly leaseId: string;
  readonly url: string;
  readonly lifetimeMs: 120000;
}

export type BrowserLinkMessage =
  | BrowserLinkReceiverRequest
  | BrowserLinkReceiverResult
  | BrowserLinkReceiverEnded
  | BrowserLinkCandidate;

const sequence = integer(1, BROWSER_LINKS_LIMITS.maxSequence);
const binding = (value: unknown): value is BrowserLinkBinding =>
  exact(value, {
    harness: (harness) => harness === 'claude',
    harnessSessionId: uuid,
  });

/**
 * Normalize an absolute HTTP(S) URL for the producer. This helper performs no
 * fetch, browser launch, or authorization check.
 */
export function normalizeBrowserLinkURL(input: unknown): string | null {
  try {
    if (
      typeof input !== 'string' ||
      input.length > BROWSER_LINKS_LIMITS.urlBytes ||
      !scalarJson(input) ||
      input.trim() !== input ||
      /[\\\u0000-\u001f\u007f-\u009f]/.test(input)
    )
      return null;
    if (utf8(input).length > BROWSER_LINKS_LIMITS.urlBytes) return null;

    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username !== '' || url.password !== '' || hasAuthorityAtSign(input))
      return null;

    const normalized = url.href;
    if (
      normalized.length > BROWSER_LINKS_LIMITS.urlBytes ||
      !/^[\x00-\x7f]*$/.test(normalized) ||
      utf8(normalized).length > BROWSER_LINKS_LIMITS.urlBytes
    )
      return null;
    return normalized;
  } catch {
    return null;
  }
}

/** URL.username/password cannot retain an empty `@`; inspect only its authority span. */
function hasAuthorityAtSign(input: string): boolean {
  const colon = input.indexOf(':');
  if (colon < 0) return false;
  let start = colon + 1;
  while (input[start] === '/') start++;
  let end = start;
  while (end < input.length && !/[/?#]/.test(input[end] ?? '')) end++;
  return input.slice(start, end).includes('@');
}

function canonicalBrowserLinkURL(value: unknown): value is string {
  return typeof value === 'string' && normalizeBrowserLinkURL(value) === value;
}

function validated(value: unknown): BrowserLinkMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !scalarJson(value))
    return null;
  const object = value as Record<string, unknown>;
  const type = object['type'];
  const envelope = {
    type: (candidate: unknown) => candidate === type,
    id: uuid4,
    timestamp: date,
  };

  if (type === 'browser_link_receiver_request') {
    return exact(object, {
      ...envelope,
      sessionId: uuid,
      binding,
      seq: sequence,
      action: (action) => BROWSER_LINK_RECEIVER_ACTIONS.some((candidate) => candidate === action),
    })
      ? (object as unknown as BrowserLinkReceiverRequest)
      : null;
  }

  if (type === 'browser_link_receiver_result') {
    const resultEnvelope = {
      ...envelope,
      sessionId: uuid,
      seq: sequence,
      requestId: uuid4,
    };
    let fields: Record<string, (candidate: unknown) => boolean>;
    switch (object['outcome']) {
      case 'selected':
        fields = {
          ...resultEnvelope,
          outcome: (outcome) => outcome === 'selected',
          leaseId: uuid4,
        };
        break;
      case 'released':
        fields = {
          ...resultEnvelope,
          outcome: (outcome) => outcome === 'released',
        };
        break;
      case 'refused':
        fields = {
          ...resultEnvelope,
          outcome: (outcome) => outcome === 'refused',
          code: (code) => BROWSER_LINK_REFUSAL_CODES.some((candidate) => candidate === code),
        };
        break;
      default:
        return null;
    }
    return exact(object, fields) ? (object as unknown as BrowserLinkReceiverResult) : null;
  }

  if (type === 'browser_link_receiver_ended') {
    return exact(object, {
      ...envelope,
      sessionId: uuid,
      leaseId: uuid4,
      reason: (reason) => BROWSER_LINK_ENDED_REASONS.some((candidate) => candidate === reason),
    })
      ? (object as unknown as BrowserLinkReceiverEnded)
      : null;
  }

  if (type === 'browser_link_candidate') {
    return exact(object, {
      ...envelope,
      sessionId: uuid,
      binding,
      leaseId: uuid4,
      url: canonicalBrowserLinkURL,
      lifetimeMs: (lifetimeMs) => lifetimeMs === BROWSER_LINKS_LIMITS.lifetimeMs,
    })
      ? (object as unknown as BrowserLinkCandidate)
      : null;
  }

  return null;
}

/** Strict bounded raw JSON/UTF-8 decoding; shape validity grants no authority. */
export function decodeBrowserLinkFrame(input: string | Uint8Array): BrowserLinkMessage | null {
  try {
    return validated(imageWireValue(input));
  } catch {
    return null;
  }
}

/** Invalid runtime values produce one payload-free error. */
export function encodeBrowserLinkFrame(message: BrowserLinkMessage): string {
  try {
    if (!validated(message)) throw new Error();
    const text = JSON.stringify(message);
    if (typeof text !== 'string' || !decodeBrowserLinkFrame(text)) throw new Error();
    return text;
  } catch {
    throw new Error('Invalid browser link frame');
  }
}
