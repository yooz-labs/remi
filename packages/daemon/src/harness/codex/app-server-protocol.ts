/**
 * JSON-RPC framing for Codex's app-server (epic #1175, phase 1 #1181).
 *
 * Codex speaks JSON-RPC 2.0 with the `jsonrpc` member optional on the wire:
 * its responses and notifications carry none, and a request id is a string or
 * a number (`RequestId`, ts/RequestId.ts in the generated schema). This file
 * only tells the four message shapes apart; what a method's params mean is for
 * the narrow parsers of later phases, which fail closed on anything unknown.
 */

export type RequestId = string | number;

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export type InboundMessage =
  | { kind: 'response'; id: RequestId; result?: unknown; error?: RpcErrorBody }
  | { kind: 'request'; id: RequestId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isRequestId = (v: unknown): v is RequestId =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

function errorBody(v: unknown): RpcErrorBody | null {
  if (!isRecord(v) || typeof v['code'] !== 'number' || typeof v['message'] !== 'string')
    return null;
  return v['data'] === undefined
    ? { code: v['code'], message: v['message'] }
    : { code: v['code'], message: v['message'], data: v['data'] };
}

/**
 * Classify one decoded frame: a `method` with an `id` is a server request, a
 * `method` alone a notification, an `id` with `result` or `error` a response.
 * Anything else, a bad id, or a response carrying both or a malformed error
 * is null (the caller drops and logs it).
 */
export function classifyInbound(raw: unknown): InboundMessage | null {
  if (!isRecord(raw)) return null;
  const hasId = 'id' in raw;
  if (hasId && !isRequestId(raw['id'])) return null;
  const method = raw['method'];
  if (method !== undefined) {
    if (typeof method !== 'string' || method === '') return null;
    return hasId
      ? { kind: 'request', id: raw['id'] as RequestId, method, params: raw['params'] }
      : { kind: 'notification', method, params: raw['params'] };
  }
  if (!hasId) return null;
  const id = raw['id'] as RequestId;
  const hasResult = 'result' in raw;
  const hasError = 'error' in raw;
  if (hasResult === hasError) return null;
  if (hasResult) return { kind: 'response', id, result: raw['result'] };
  const error = errorBody(raw['error']);
  return error ? { kind: 'response', id, error } : null;
}
