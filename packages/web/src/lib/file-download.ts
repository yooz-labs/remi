import { hubSupport } from '@remi/shared';
import {
  FILE_DOWNLOAD_LIMITS,
  type FileDownloadBinding,
  type FileDownloadMessage,
  decodeFileDownloadFrame,
  encodeFileDownloadFrame,
} from '../../../shared/src/file-download.ts';

const TOTAL_MS = 300_000;
const REPLY_MS = 15_000;

export type FileDownloadRequest = Extract<
  FileDownloadMessage,
  { type: 'file_fetch_begin' | 'file_fetch_read' | 'file_fetch_complete' | 'file_fetch_cancel' }
>;

/** Supplied only by the owner of the actual authenticated socket or encrypted relay channel. */
interface FileDownloadContextFields {
  readonly connection: object;
  readonly generation: object;
  readonly attachment: object;
  readonly identityRevision: number;
  readonly identityKey: string;
  readonly authenticated: true;
  readonly webSocketUrl: string;
  readonly sessionId: string;
  readonly binding: FileDownloadBinding;
  readonly protocolVersion: unknown;
  readonly capabilities: readonly string[];
}

export type FileDownloadContext = FileDownloadContextFields &
  (
    | { readonly transport?: 'direct'; readonly relayChannel?: never }
    | { readonly transport: 'relay'; readonly relayChannel: object }
  );

export interface FileDownloadTransport {
  readonly context: () => FileDownloadContext | null;
  /** One attempt only if this exact socket generation still matches. False may be uncertain. */
  readonly send: (request: FileDownloadRequest, generation: object) => boolean;
}

export type FileDownloadState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'preparing'; readonly relativePath: string }
  | {
      readonly phase: 'receiving' | 'verifying' | 'finishing';
      readonly fileName: string;
      readonly receivedBytes: number;
      readonly byteLength: number;
    }
  | { readonly phase: 'cancelling' }
  | {
      readonly phase: 'ready';
      readonly fileName: string;
      readonly byteLength: number;
      readonly hostCleanup: 'complete' | 'uncertain';
      readonly message: string;
    }
  | { readonly phase: 'failed'; readonly message: string }
  | {
      readonly phase: 'cancelled';
      readonly hostCleanup: 'complete' | 'uncertain';
      readonly message: string;
    };

interface Download {
  readonly context: FileDownloadContext;
  readonly beginId: string;
  readonly relativePath: string;
  deadline: number;
  transferId: string | null;
  fileName: string | null;
  digest: string | null;
  bytes: Uint8Array<ArrayBuffer> | null;
  received: number;
  nextSeq: number;
  verified: boolean;
  cancelling: boolean;
}

interface Pending {
  readonly download: Download;
  readonly request: FileDownloadRequest;
  readonly expected:
    | 'file_fetch_accepted'
    | 'file_fetch_chunk'
    | 'file_fetch_result'
    | 'file_fetch_cancel_result';
  readonly timer: ReturnType<typeof setTimeout>;
}

const REFUSALS: Readonly<Record<string, string>> = {
  malformed: 'The host could not accept this download request.',
  unavailable: 'This file download is unavailable.',
  busy: 'The host is busy. Try Download again in a moment.',
  conflict: 'This download could not continue. Start a new Download to retry.',
  sequence: 'Download progress could not be confirmed. Start a new Download to retry.',
  integrity: 'The file could not be verified. Start a new Download to retry.',
  empty_file: 'Empty files are not supported yet.',
  expired: 'The download expired. Start a new Download to retry.',
  binding_changed: 'The session changed. Start a new Download to retry.',
  cleanup_failed: 'The host could not confirm cleanup. Check the session before retrying.',
};

function requestId(): string {
  return crypto.randomUUID().toLowerCase();
}

function stamp(): string {
  return new Date().toISOString();
}

function secureUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'wss:' && !!url.hostname && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function secureTransport(context: FileDownloadContext): boolean {
  if (context.transport !== 'relay') return secureUrl(context.webSocketUrl);
  // The channel owner supplies this opaque, verified crypto generation. The carrier URL
  // is not evidence of encryption; source Worker fixtures also use ws:// locally.
  if (!context.relayChannel || context.relayChannel !== context.generation) return false;
  try {
    const url = new URL(context.webSocketUrl);
    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function captureFileDownloadContext(
  context: FileDownloadContext | null,
): FileDownloadContext | null {
  if (
    !context ||
    !context.connection ||
    !context.generation ||
    !context.attachment ||
    context.authenticated !== true ||
    !secureTransport(context) ||
    !Number.isSafeInteger(context.identityRevision) ||
    context.identityRevision < 0 ||
    typeof context.identityKey !== 'string' ||
    context.identityKey.length === 0 ||
    !hubSupport(context, ['file_download']).supported
  )
    return null;
  const saved = {
    ...context,
    binding: { ...context.binding },
    capabilities: [...context.capabilities],
  };
  // Reuse the frozen binding/session guards; there is no second permissive syntax here.
  try {
    encodeFileDownloadFrame({
      type: 'file_fetch_begin',
      id: '00000000-0000-4000-8000-000000000000',
      timestamp: '2000-01-01T00:00:00.000Z',
      sessionId: saved.sessionId,
      binding: saved.binding,
      relativePath: 'file',
    });
    return saved;
  } catch {
    return null;
  }
}

function sameContext(current: FileDownloadContext | null, saved: FileDownloadContext): boolean {
  return (
    !!current &&
    current.authenticated === true &&
    secureTransport(current) &&
    (current.transport ?? 'direct') === (saved.transport ?? 'direct') &&
    current.relayChannel === saved.relayChannel &&
    current.connection === saved.connection &&
    current.generation === saved.generation &&
    current.attachment === saved.attachment &&
    current.identityRevision === saved.identityRevision &&
    current.identityKey === saved.identityKey &&
    current.webSocketUrl === saved.webSocketUrl &&
    current.sessionId === saved.sessionId &&
    current.binding.harness === saved.binding.harness &&
    current.binding.harnessSessionId === saved.binding.harnessSessionId &&
    current.protocolVersion === saved.protocolVersion &&
    hubSupport(current, ['file_download']).supported
  );
}

function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function digestText(bytes: ArrayBuffer): string {
  let binary = '';
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** ADR 0045 pull client; the actual connection owner supplies context and explicit actions. */
export class FileDownloadController {
  private readonly transport: FileDownloadTransport;
  private readonly onState: (state: FileDownloadState) => void;
  private download: Download | null = null;
  private pending: Pending | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private currentState: FileDownloadState = { phase: 'idle' };

  constructor(transport: FileDownloadTransport, onState: (state: FileDownloadState) => void) {
    this.transport = transport;
    this.onState = onState;
  }

  get state(): FileDownloadState {
    return this.currentState;
  }

  get canDownload(): boolean {
    return (
      !this.disposed &&
      (!this.download ||
        this.currentState.phase === 'failed' ||
        this.currentState.phase === 'cancelled') &&
      captureFileDownloadContext(this.transport.context()) !== null
    );
  }

  get available(): boolean {
    return !this.disposed && captureFileDownloadContext(this.transport.context()) !== null;
  }

  /** Keeps an explicit cancellation available after uncertain delivery too. */
  get canCancel(): boolean {
    return !this.disposed && this.download !== null && !this.download.cancelling;
  }

  /** A fresh operation is started only by an explicit Download action. */
  start(relativePath: string): void {
    if (!this.canDownload) return;
    const context = captureFileDownloadContext(this.transport.context());
    if (!context) return;
    const request: FileDownloadRequest = {
      type: 'file_fetch_begin',
      id: requestId(),
      timestamp: stamp(),
      sessionId: context.sessionId,
      binding: { ...context.binding },
      relativePath,
    };
    try {
      encodeFileDownloadFrame(request);
    } catch {
      this.publish({ phase: 'failed', message: 'Enter one project-relative file path.' });
      return;
    }
    this.clear();
    const active: Download = {
      context,
      beginId: request.id,
      relativePath,
      deadline: performance.now() + TOTAL_MS,
      transferId: null,
      fileName: null,
      digest: null,
      bytes: null,
      received: 0,
      nextSeq: 0,
      verified: false,
      cancelling: false,
    };
    this.download = active;
    this.armTotal(active);
    this.publish({ phase: 'preparing', relativePath });
    this.issue(active, request, 'file_fetch_accepted');
  }

  /** Direct originals, or canonical frames already strictly decoded on the encrypted channel. */
  receive(raw: string | Uint8Array): void {
    const active = this.download;
    const pending = this.pending;
    if (this.disposed || !active || !pending || pending.download !== active) return;
    const message = decodeFileDownloadFrame(raw);
    if (!message || !('requestId' in message)) {
      this.fail(active, 'The download response was invalid. Start a new Download to retry.');
      return;
    }
    // Late responses for a cancelled/replaced operation do not consume a current request.
    if (message.requestId !== pending.request.id) return;
    if (!this.current(active)) return;
    if (
      message.sessionId !== active.context.sessionId ||
      (message.type === 'file_fetch_refused' && message.operation !== pending.request.type)
    ) {
      this.fail(active, 'The download response did not match this request.');
      return;
    }
    this.clearPending();
    if (message.type === 'file_fetch_refused') {
      if (active.cancelling) this.cancelled(false);
      else if (active.verified) this.ready(active, false);
      else this.fail(active, REFUSALS[message.code] ?? 'The host refused this download.');
      return;
    }
    if (message.type !== pending.expected) {
      this.fail(active, 'The download response arrived out of order.');
      return;
    }
    if (message.type === 'file_fetch_cancel_result') {
      if (message.beginId !== active.beginId)
        this.fail(active, 'Cancellation could not be confirmed.');
      else this.cancelled(true);
      return;
    }
    if (active.cancelling) return;
    if (message.type === 'file_fetch_accepted') {
      const remaining = Date.parse(message.expiresAt) - Date.now();
      if (message.fileName !== active.relativePath.split('/').at(-1) || remaining <= 0) {
        this.fail(active, 'The accepted file or download deadline was invalid.');
        return;
      }
      active.transferId = message.transferId;
      active.fileName = message.fileName;
      active.digest = message.digest;
      active.deadline = Math.min(active.deadline, performance.now() + remaining);
      try {
        active.bytes = new Uint8Array(message.byteLength);
      } catch {
        this.fail(active, 'There is not enough memory for this download.');
        return;
      }
      this.armTotal(active);
      this.progress(active, 'receiving');
      this.pull(active);
    } else if (message.type === 'file_fetch_chunk') {
      if (
        !active.bytes ||
        !active.transferId ||
        pending.request.type !== 'file_fetch_read' ||
        message.transferId !== active.transferId ||
        message.seq !== pending.request.seq ||
        message.seq !== active.nextSeq
      ) {
        this.fail(active, 'The file chunk did not match this download.');
        return;
      }
      const bytes = decodeBytes(message.data);
      const expected = Math.min(
        FILE_DOWNLOAD_LIMITS.chunkBytes,
        active.bytes.length - active.received,
      );
      if (bytes.length !== expected || expected < 1) {
        this.fail(active, 'The file chunk had an unexpected length.');
        return;
      }
      active.bytes.set(bytes, active.received);
      active.received += bytes.length;
      active.nextSeq++;
      if (active.received === active.bytes.length) {
        this.progress(active, 'verifying');
        void this.verify(active);
      } else {
        this.progress(active, 'receiving');
        this.pull(active);
      }
    } else if (message.type === 'file_fetch_result') {
      if (message.transferId !== active.transferId || !active.verified) {
        this.fail(active, 'Completion did not match this download.');
      } else this.ready(active, true);
    }
  }

  /** Discards local bytes immediately, including during preparation or hashing. */
  cancel(): void {
    const active = this.download;
    if (this.disposed || !active || active.cancelling) return;
    if (this.currentState.phase === 'ready' && this.currentState.hostCleanup === 'complete') {
      this.cancelled(true);
      return;
    }
    active.cancelling = true;
    active.bytes = null;
    active.verified = false;
    this.clearPending();
    this.clearTotal();
    this.publish({ phase: 'cancelling' });
    if (!sameContext(this.transport.context(), active.context)) {
      this.cancelled(false);
      return;
    }
    this.issue(
      active,
      {
        type: 'file_fetch_cancel',
        id: requestId(),
        timestamp: stamp(),
        sessionId: active.context.sessionId,
        beginId: active.beginId,
      },
      'file_fetch_cancel_result',
    );
  }

  /** Called on socket, identity or attachment loss. Nothing resumes automatically. */
  contextChanged(): void {
    const active = this.download;
    if (active && !sameContext(this.transport.context(), active.context)) {
      this.fail(active, 'The connection or session changed. Start a new Download to retry.', true);
    }
  }

  /** The owner observed a lifetime boundary, even if metadata happens to look equal. */
  disconnect(): void {
    if (this.download)
      this.fail(
        this.download,
        'The connection or session changed. Start a new Download to retry.',
        true,
      );
  }

  /** A later explicit Save action may take a copy; the controller never opens or saves it. */
  copyVerifiedFile(): {
    readonly fileName: string;
    readonly bytes: Uint8Array<ArrayBuffer>;
  } | null {
    const active = this.download;
    if (
      this.disposed ||
      this.currentState.phase !== 'ready' ||
      !active?.verified ||
      !active.bytes ||
      !active.fileName
    )
      return null;
    if (!sameContext(this.transport.context(), active.context)) {
      this.contextChanged();
      return null;
    }
    // Do not expose the verified backing buffer for mutation by a Save consumer.
    return { fileName: active.fileName, bytes: active.bytes.slice() };
  }

  dismiss(): void {
    if (
      this.pending ||
      ['preparing', 'receiving', 'verifying', 'finishing', 'cancelling'].includes(
        this.currentState.phase,
      )
    )
      return;
    this.clear();
    this.publish({ phase: 'idle' });
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.currentState = { phase: 'idle' };
  }

  private async verify(active: Download): Promise<void> {
    if (!this.current(active) || !active.bytes || active.cancelling) return;
    const bytes = active.bytes;
    let digest: string;
    try {
      digest = digestText(await crypto.subtle.digest('SHA-256', bytes));
    } catch {
      if (this.download === active && !active.cancelling)
        this.fail(active, 'The downloaded file could not be verified.');
      return;
    }
    if (
      this.download !== active ||
      active.cancelling ||
      active.bytes !== bytes ||
      !this.current(active)
    )
      return;
    if (digest !== active.digest || active.received !== bytes.length || !active.transferId) {
      this.fail(active, 'The downloaded file failed its size or integrity check.');
      return;
    }
    active.verified = true;
    this.progress(active, 'finishing');
    this.issue(
      active,
      {
        type: 'file_fetch_complete',
        id: requestId(),
        timestamp: stamp(),
        sessionId: active.context.sessionId,
        transferId: active.transferId,
        receivedBytes: active.received,
        digest,
      },
      'file_fetch_result',
    );
  }

  private pull(active: Download): void {
    if (!this.current(active) || active.cancelling || !active.bytes || !active.transferId) return;
    this.issue(
      active,
      {
        type: 'file_fetch_read',
        id: requestId(),
        timestamp: stamp(),
        sessionId: active.context.sessionId,
        transferId: active.transferId,
        seq: active.nextSeq,
        receivedBytes: active.received,
      },
      'file_fetch_chunk',
    );
  }

  private issue(
    active: Download,
    request: FileDownloadRequest,
    expected: Pending['expected'],
  ): void {
    if (this.disposed || this.download !== active || this.pending) return;
    if (!sameContext(this.transport.context(), active.context)) {
      if (active.cancelling) this.cancelled(false);
      else
        this.fail(
          active,
          'The connection or session changed. Start a new Download to retry.',
          true,
        );
      return;
    }
    const remaining = active.deadline - performance.now();
    if (!active.cancelling && remaining <= 0) {
      this.expired(active);
      return;
    }
    try {
      encodeFileDownloadFrame(request);
    } catch {
      this.fail(active, 'The download request could not be encoded.');
      return;
    }
    const delay = active.cancelling
      ? REPLY_MS
      : Math.min(remaining, request.type === 'file_fetch_begin' ? TOTAL_MS : REPLY_MS);
    const pending: Pending = {
      download: active,
      request,
      expected,
      timer: setTimeout(() => {
        if (this.pending !== pending || this.download !== active) return;
        this.clearPending();
        if (active.cancelling) this.cancelled(false);
        else if (active.verified) this.ready(active, false);
        else this.fail(active, 'No confirmation arrived. Start a new Download to retry.');
      }, delay),
    };
    this.pending = pending;
    let sent = false;
    try {
      sent = this.transport.send(request, active.context.generation);
    } catch {
      // A thrown send is also uncertain; it never permits an automatic retry.
    }
    if (!sent && this.pending === pending && this.download === active) {
      this.clearPending();
      if (active.cancelling) this.cancelled(false);
      else if (active.verified) this.ready(active, false);
      else this.fail(active, 'Delivery could not be confirmed. Start a new Download to retry.');
    }
  }

  private current(active: Download): boolean {
    if (this.disposed || this.download !== active) return false;
    if (!sameContext(this.transport.context(), active.context)) {
      this.fail(active, 'The connection or session changed. Start a new Download to retry.', true);
      return false;
    }
    if (!active.cancelling && performance.now() >= active.deadline) {
      this.expired(active);
      return false;
    }
    return true;
  }

  private progress(active: Download, phase: 'receiving' | 'verifying' | 'finishing'): void {
    if (this.download !== active || !active.fileName || !active.bytes || active.cancelling) return;
    this.publish({
      phase,
      fileName: active.fileName,
      receivedBytes: active.received,
      byteLength: active.bytes.length,
    });
  }

  private ready(active: Download, confirmed: boolean): void {
    if (
      this.download !== active ||
      !active.verified ||
      !active.bytes ||
      !active.fileName ||
      active.cancelling
    )
      return;
    this.clearPending();
    this.clearTotal();
    this.publish({
      phase: 'ready',
      fileName: active.fileName,
      byteLength: active.bytes.length,
      hostCleanup: confirmed ? 'complete' : 'uncertain',
      message: confirmed
        ? 'File verified. Ready to save.'
        : 'File verified. Host cleanup was not confirmed.',
    });
  }

  private cancelled(confirmed: boolean): void {
    this.clear();
    this.publish({
      phase: 'cancelled',
      hostCleanup: confirmed ? 'complete' : 'uncertain',
      message: confirmed
        ? 'Download cancelled and discarded.'
        : 'Download discarded. Host cleanup was not confirmed.',
    });
  }

  private expired(active: Download): void {
    if (this.download !== active) return;
    if (active.verified) this.ready(active, false);
    else this.fail(active, 'The download expired. Start a new Download to retry.');
  }

  private fail(active: Download, message: string, discardVerified = false): void {
    if (this.download !== active) return;
    if (active.verified && !discardVerified) {
      this.ready(active, false);
      return;
    }
    this.clearPending();
    this.clearTotal();
    active.bytes = null;
    active.verified = false;
    this.publish({ phase: 'failed', message });
  }

  private armTotal(active: Download): void {
    this.clearTotal();
    this.totalTimer = setTimeout(
      () => {
        this.totalTimer = null;
        this.expired(active);
      },
      Math.max(0, active.deadline - performance.now()),
    );
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private clearTotal(): void {
    if (this.totalTimer) clearTimeout(this.totalTimer);
    this.totalTimer = null;
  }

  private clear(): void {
    this.clearPending();
    this.clearTotal();
    if (this.download) this.download.bytes = null;
    this.download = null;
  }

  private publish(state: FileDownloadState): void {
    this.currentState = state;
    this.onState(state);
  }
}
