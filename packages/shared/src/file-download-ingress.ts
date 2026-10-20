/** Strict request syntax and correlation only; the download service owns every effect. */
import {
  type FileDownloadMessage,
  type FileDownloadOperation,
  decodeFileDownloadFrame,
} from './file-download.ts';
import { date, encoded, imageWireValue, scalarJson, uuid, uuid4 } from './image-wire.ts';

export type FileDownloadIngressRequest = Extract<
  FileDownloadMessage,
  { type: FileDownloadOperation }
>;

/** These are lookup hints, never a grant, an attachment or transfer authority. */
export interface FileDownloadCorrelation {
  readonly operation: FileDownloadOperation;
  readonly requestId: string;
  readonly sessionId: string;
  readonly transferId: string | null;
  readonly beginId: string | null;
}

export type FileDownloadIngressResult =
  | { readonly kind: 'request'; readonly request: FileDownloadIngressRequest }
  | { readonly kind: 'malformed'; readonly correlation: FileDownloadCorrelation }
  | { readonly kind: 'uncorrelatable' };

function requestOperation(value: unknown): value is FileDownloadOperation {
  return (
    value === 'file_fetch_begin' ||
    value === 'file_fetch_read' ||
    value === 'file_fetch_complete' ||
    value === 'file_fetch_cancel'
  );
}

const transfer = encoded(16, 16);
function transferHint(value: unknown): string | null {
  try {
    return transfer(value) ? (value as string) : null;
  } catch {
    return null;
  }
}

/** Decode the original frame; ambiguous envelopes must not fall back to legacy dispatch. */
export function decodeFileDownloadIngress(input: string | Uint8Array): FileDownloadIngressResult {
  try {
    const value = imageWireValue(input);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !scalarJson(value))
      return { kind: 'uncorrelatable' };
    const object = value as Record<string, unknown>;
    const operation = object['type'];
    if (
      !['type', 'id', 'timestamp', 'sessionId'].every((key) => Object.hasOwn(object, key)) ||
      !requestOperation(operation) ||
      !uuid4(object['id']) ||
      !uuid(object['sessionId']) ||
      !date(object['timestamp'])
    )
      return { kind: 'uncorrelatable' };

    const request = decodeFileDownloadFrame(input);
    if (request && requestOperation(request.type))
      return { kind: 'request', request: request as FileDownloadIngressRequest };

    return {
      kind: 'malformed',
      correlation: {
        operation,
        requestId: object['id'] as string,
        sessionId: object['sessionId'] as string,
        transferId:
          operation === 'file_fetch_read' || operation === 'file_fetch_complete'
            ? transferHint(object['transferId'])
            : null,
        beginId:
          operation === 'file_fetch_cancel' && uuid4(object['beginId'])
            ? (object['beginId'] as string)
            : null,
      },
    };
  } catch {
    return { kind: 'uncorrelatable' };
  }
}
