/** Original-frame correlation only; no authority, legacy normalization or retained raw body. */
import {
  TERMINAL_VIEW_LIMITS,
  TERMINAL_VIEW_OPERATIONS,
  type TerminalViewOperation,
  type TerminalViewRequest,
  decodeTerminalViewFrame,
} from '@remi/shared';
import { parseStrictJson } from '@remi/shared/relay/strict-json';

export interface TerminalCorrelation {
  readonly id: string;
  readonly sessionId: string;
  readonly operation: TerminalViewOperation;
}
export type TerminalIngress =
  | { readonly kind: 'request'; readonly request: TerminalViewRequest }
  | { readonly kind: 'malformed'; readonly correlation: TerminalCorrelation };

export function terminalIngress(raw: string | Uint8Array): TerminalIngress | null {
  if (
    typeof raw === 'string'
      ? raw.length > TERMINAL_VIEW_LIMITS.frameBytes ||
        Buffer.byteLength(raw) > TERMINAL_VIEW_LIMITS.frameBytes
      : raw.byteLength > TERMINAL_VIEW_LIMITS.frameBytes
  )
    return null;
  const request = decodeTerminalViewFrame(raw);
  if (request && TERMINAL_VIEW_OPERATIONS.some((type) => type === request.type))
    return { kind: 'request', request: request as TerminalViewRequest };
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    const value = parseStrictJson(text, 65536) as Record<string, unknown> | null;
    if (
      !value ||
      Array.isArray(value) ||
      typeof value['id'] !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value['id']) ||
      typeof value['sessionId'] !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value['sessionId'])
    )
      return null;
    const operation = TERMINAL_VIEW_OPERATIONS.find((type) => type === value['type']);
    return operation
      ? {
          kind: 'malformed',
          correlation: { id: value['id'], sessionId: value['sessionId'], operation },
        }
      : null;
  } catch {
    return null;
  }
}
