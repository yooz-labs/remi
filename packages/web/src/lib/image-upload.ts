import type { ImageUploadState } from '@/components/chat/ImageUpload';
import { type ProtocolMessage, generateId, hubSupport } from '@remi/shared';
import type { ImageInsertRequest, ImageInsertResult } from '../../../shared/src/image-insertion.ts';
import {
  IMAGE_STAGING_CAPABILITY,
  IMAGE_STAGING_LIMITS,
  type ImageStagingMediaType,
  type ImageStagingMessage,
  type ImageStagingOperation,
  type ImageStagingRequest,
} from '../../../shared/src/image-staging.ts';
import { ImageDraftController } from './image-draft';

const REQUEST_TIMEOUT_MS = 15_000;

export interface ImageUploadContext {
  readonly transport: 'direct';
  /** Opaque identity of the concrete connection owner. */
  readonly connection: object;
  /** Opaque per-WebSocket identity; changes on every reconnect. */
  readonly generation: object;
  readonly sessionId: string;
  readonly binding: { readonly harness: 'claude'; readonly harnessSessionId: string };
  readonly capabilities: readonly string[];
  readonly protocolVersion: unknown;
}

export interface ImageUploadTransport {
  /** True means the request was queued to the current direct WebSocket. */
  readonly send: (request: ImageStagingRequest) => boolean;
  readonly sendInsertion?: (request: ImageInsertRequest) => boolean;
  /** Null until the current direct connection is authenticated and attached. */
  readonly context: () => ImageUploadContext | null;
}

type ImageStagingResponse = Extract<
  ImageStagingMessage,
  {
    type:
      | 'image_upload_accepted'
      | 'image_upload_chunk_ack'
      | 'image_upload_result'
      | 'image_upload_cancel_result'
      | 'image_upload_refused';
  }
>;

type ExpectedResponseType = Exclude<ImageStagingResponse['type'], 'image_upload_refused'>;

interface CapturedContext {
  readonly connection: object;
  readonly generation: object;
  readonly sessionId: string;
  readonly harnessSessionId: string;
  readonly protocolVersion: unknown;
}

interface ActiveUpload {
  readonly filename: string;
  readonly mediaType: ImageStagingMediaType;
  readonly byteLength: number;
  readonly context: CapturedContext;
  cancelRequested: boolean;
  sentAny: boolean;
  completeSent: boolean;
  transferId: string | null;
  digest: string | null;
  stagedResult: Extract<ImageStagingMessage, { type: 'image_upload_result' }> | null;
  cancelTask: Promise<void> | null;
  currentOperation: ImageStagingOperation | null;
  done: Promise<void> | null;
}

interface PendingRequest {
  readonly active: ActiveUpload;
  readonly requestId: string;
  readonly operation: ImageStagingOperation;
  readonly expectedType: ExpectedResponseType;
  readonly transferId: string | null;
  readonly seq: number | null;
  readonly receivedBytes: number | null;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (message: ImageStagingResponse) => void;
  readonly reject: (error: UploadError) => void;
}

type UploadErrorKind = 'context_lost' | 'send_failed' | 'timeout' | 'bad_response' | 'refused';

class UploadError extends Error {
  readonly kind: UploadErrorKind;
  readonly refusalCode?: string;
  readonly operation?: ImageStagingOperation;

  constructor(
    kind: UploadErrorKind,
    message: string,
    refusalCode?: string,
    operation?: ImageStagingOperation,
  ) {
    super(message);
    this.kind = kind;
    this.refusalCode = refusalCode;
    this.operation = operation;
  }
}

const REFUSAL_MESSAGES: Record<string, string> = {
  malformed: 'The host rejected this image request. Choose the image again to retry.',
  unavailable: 'Image upload is no longer available for this session.',
  busy: 'The host is handling another image upload. Try again in a moment.',
  conflict: 'This upload could not be continued. Choose the image again to retry.',
  sequence: 'The host could not confirm upload progress. Choose the image again to retry.',
  integrity: 'The host could not verify this image. Choose it again to retry.',
  unsupported_media: 'Choose a PNG or JPEG image.',
  decode_failed: 'The host could not read this image. Choose another PNG or JPEG.',
  expired: 'The upload took too long. Choose the image again to retry.',
  binding_changed: 'The session changed during this upload. Choose the image again.',
  cleanup_failed: 'The host could not confirm upload cleanup. Check the session before retrying.',
};

function isResponse(message: ImageStagingMessage): message is ImageStagingResponse {
  return 'requestId' in message;
}

function newRequestId(): string {
  return generateId().toLowerCase();
}

function timestamp(): string {
  return new Date().toISOString();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function sameContext(current: ImageUploadContext | null, captured: CapturedContext): boolean {
  return (
    current !== null &&
    current.transport === 'direct' &&
    current.connection === captured.connection &&
    current.generation === captured.generation &&
    current.sessionId === captured.sessionId &&
    current.protocolVersion === captured.protocolVersion &&
    current.binding.harness === 'claude' &&
    current.binding.harnessSessionId === captured.harnessSessionId &&
    hubSupport({ protocolVersion: current.protocolVersion, capabilities: current.capabilities }, [
      IMAGE_STAGING_CAPABILITY,
    ]).supported
  );
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function captureContext(context: ImageUploadContext | null): CapturedContext | null {
  if (
    context === null ||
    context.transport !== 'direct' ||
    !context.connection ||
    !context.generation ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(context.sessionId) ||
    context.binding.harness !== 'claude' ||
    context.binding.harnessSessionId.length === 0 ||
    !hubSupport({ protocolVersion: context.protocolVersion, capabilities: context.capabilities }, [
      IMAGE_STAGING_CAPABILITY,
    ]).supported
  ) {
    return null;
  }

  const bindingText = context.binding.harnessSessionId;
  const encodedBinding = new TextEncoder().encode(bindingText);
  if (
    encodedBinding.length > IMAGE_STAGING_LIMITS.bindingBytes ||
    new TextDecoder('utf-8', { fatal: true }).decode(encodedBinding) !== bindingText ||
    hasControlCharacters(bindingText)
  ) {
    return null;
  }

  return {
    connection: context.connection,
    generation: context.generation,
    sessionId: context.sessionId,
    harnessSessionId: bindingText,
    protocolVersion: context.protocolVersion,
  };
}

function supportedFile(file: File): ImageStagingMediaType | null {
  if (file.size < 1 || file.size > IMAGE_STAGING_LIMITS.imageBytes) return null;
  if (file.type === 'image/png') return 'image/png';
  if (file.type === 'image/jpeg') return 'image/jpeg';
  return null;
}

function failureMessage(error: unknown): { phase: 'failed' | 'uncertain'; message: string } {
  if (error instanceof UploadError) {
    if (error.kind === 'refused') {
      return {
        phase: 'failed',
        message:
          REFUSAL_MESSAGES[error.refusalCode ?? ''] ??
          'The host refused this image upload. Choose the image again to retry.',
      };
    }
    if (error.kind === 'context_lost') {
      return {
        phase: error.message.includes('before upload began') ? 'failed' : 'uncertain',
        message: error.message,
      };
    }
    if (error.kind === 'send_failed') {
      return { phase: 'failed', message: 'Could not start the image upload. Try again.' };
    }
    if (error.kind === 'timeout') {
      return {
        phase: 'uncertain',
        message: 'The host did not confirm the upload. Check the session before retrying.',
      };
    }
  }
  return {
    phase: 'uncertain',
    message: 'The upload response was invalid. Check the session before retrying.',
  };
}

/** Direct-only stop-and-wait client for the ADR 0041 image staging operation. */
export class ImageUploadController {
  private readonly transport: ImageUploadTransport;
  private readonly onState: (state: ImageUploadState) => void;
  private active: ActiveUpload | null = null;
  private blockedContext: CapturedContext | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;
  private readonly draft: ImageDraftController;

  constructor(transport: ImageUploadTransport, onState: (state: ImageUploadState) => void) {
    this.transport = transport;
    this.draft = new ImageDraftController(transport, onState);
    this.onState = onState;
  }

  /** Whether a new upload can start in the controller's current direct context. */
  get canUpload(): boolean {
    if (this.disposed || this.active || !this.draft.canReplace) return false;
    const context = this.captureCurrentContext();
    return context !== null && !sameCapturedContext(this.blockedContext, context);
  }

  /** Dismiss a terminal status without changing any server-side staged state. */
  dismiss(): void {
    if (this.disposed || this.active || !this.draft.canDismiss) return;
    this.draft.clear();
    this.onState({ phase: 'idle' });
  }

  async upload(file: File): Promise<void> {
    if (this.disposed || this.active || !this.draft.canReplace) return;
    this.draft.clear();
    const mediaType = supportedFile(file);
    if (!mediaType) {
      this.onState({
        phase: 'failed',
        filename: file.name,
        message:
          file.size > IMAGE_STAGING_LIMITS.imageBytes
            ? 'Images must be 10 MiB or smaller.'
            : file.size === 0
              ? 'This image is empty. Choose a different file.'
              : 'Choose a PNG or JPEG image.',
      });
      return;
    }

    const captured = this.captureCurrentContext();
    if (!captured) {
      this.onState({
        phase: 'failed',
        filename: file.name,
        message: 'Image upload is unavailable for this session.',
      });
      return;
    }
    if (sameCapturedContext(this.blockedContext, captured)) {
      this.onState({
        phase: 'uncertain',
        filename: file.name,
        message: 'Reconnect before retrying this image upload.',
      });
      return;
    }
    this.blockedContext = null;

    const active: ActiveUpload = {
      filename: file.name,
      mediaType,
      byteLength: file.size,
      context: captured,
      cancelRequested: false,
      sentAny: false,
      completeSent: false,
      transferId: null,
      digest: null,
      stagedResult: null,
      cancelTask: null,
      currentOperation: null,
      done: null,
    };
    this.active = active;
    const done = this.performUpload(active, file);
    active.done = done;
    await done;
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active || this.disposed) return;
    if (active.completeSent) {
      active.cancelRequested = true;
      if (!active.cancelTask) {
        this.emitActive(active, { phase: 'cancelling', filename: active.filename });
        active.cancelTask = this.cancelDuringCompletion(active);
      }
      await active.cancelTask;
      await active.done;
      return;
    }
    active.cancelRequested = true;
    this.emitActive(active, { phase: 'cancelling', filename: active.filename });
    await active.done;
  }

  /** Route strictly decoded staging responses; unrelated or late responses never advance state. */
  receive(message: ImageStagingMessage): void {
    if (this.disposed || !isResponse(message)) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;

    if (!this.isCurrent(pending.active)) {
      this.stopForContextLoss(pending.active);
      return;
    }
    if (message.sessionId !== pending.active.context.sessionId) {
      this.rejectPending(
        pending,
        new UploadError(
          'bad_response',
          'Mismatched image upload session',
          undefined,
          pending.operation,
        ),
      );
      return;
    }
    if (message.type === 'image_upload_refused') {
      if (message.operation !== pending.operation) {
        this.rejectPending(
          pending,
          new UploadError(
            'bad_response',
            'Mismatched image upload refusal',
            undefined,
            pending.operation,
          ),
        );
      } else {
        this.rejectPending(
          pending,
          new UploadError('refused', 'Image upload was refused', message.code, pending.operation),
        );
      }
      return;
    }
    if (message.type !== pending.expectedType) {
      this.rejectPending(
        pending,
        new UploadError(
          'bad_response',
          'Unexpected image upload response',
          undefined,
          pending.operation,
        ),
      );
      return;
    }
    if (
      pending.transferId &&
      'transferId' in message &&
      message.transferId !== pending.transferId
    ) {
      this.rejectPending(
        pending,
        new UploadError(
          'bad_response',
          'Mismatched image upload transfer',
          undefined,
          pending.operation,
        ),
      );
      return;
    }
    if (
      message.type === 'image_upload_chunk_ack' &&
      (message.seq !== pending.seq || message.receivedBytes !== pending.receivedBytes)
    ) {
      this.rejectPending(
        pending,
        new UploadError(
          'bad_response',
          'Mismatched image upload acknowledgment',
          undefined,
          pending.operation,
        ),
      );
      return;
    }
    if (
      message.type === 'image_upload_result' &&
      (message.outcome !== 'staged' ||
        message.byteLength !== pending.active.byteLength ||
        message.mediaType !== pending.active.mediaType ||
        message.digest !== pending.active.digest)
    ) {
      this.rejectPending(
        pending,
        new UploadError(
          'bad_response',
          'Image upload result did not match the selected image',
          undefined,
          pending.operation,
        ),
      );
      return;
    }

    if (message.type === 'image_upload_result') {
      pending.active.stagedResult = message;
      this.resolvePending(pending, message);
      this.finishActive(pending.active, { phase: 'staged', filename: pending.active.filename });
      return;
    }
    if (
      message.type === 'image_upload_cancel_result' &&
      pending.operation === 'image_upload_cancel' &&
      pending.active.completeSent
    ) {
      const state: ImageUploadState = pending.active.stagedResult
        ? { phase: 'staged', filename: pending.active.filename }
        : { phase: 'idle' };
      this.resolvePending(pending, message);
      this.finishActive(pending.active, state);
      return;
    }
    this.resolvePending(pending, message);
  }

  /** Abort the current client attempt on connection/session lifecycle change. */
  disconnect(): void {
    this.draft.disconnect();
    const active = this.active;
    if (active)
      this.finishActive(
        active,
        this.uncertainOrFailed(active, 'The connection changed during upload.'),
      );
  }

  /** Clear all request deadlines and prevent later state callbacks. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.draft.clear();
    for (const pending of this.pending.values()) {
      this.clearPending(pending);
      pending.reject(new UploadError('context_lost', 'Image upload controller was disposed'));
    }
    this.active = null;
    this.blockedContext = null;
  }

  addToDraft(): void {
    if (!this.disposed && !this.active) this.draft.addToDraft();
  }

  receiveInsertion(result: ImageInsertResult): void {
    if (!this.disposed) this.draft.receive(result);
  }

  takeImageDraftForSend(messageId: string): boolean {
    return !this.disposed && !this.active && this.draft.takeForSend(messageId);
  }

  receiveInputReceipt(message: ProtocolMessage): void {
    if (!this.disposed) this.draft.receiveInputReceipt(message);
  }

  endSession(sessionId: string): void {
    if (!this.disposed) this.draft.endSession(sessionId);
  }

  private async performUpload(active: ActiveUpload, file: File): Promise<void> {
    this.emitActive(active, { phase: 'preparing', filename: active.filename });
    try {
      const buffer = await file.arrayBuffer();
      this.ensureCurrent(active);
      if (active.cancelRequested) {
        this.finishActive(active, { phase: 'idle' });
        return;
      }
      if (buffer.byteLength !== active.byteLength) {
        throw new UploadError('bad_response', 'Image byte length changed while reading');
      }

      const bytes = new Uint8Array(buffer);
      const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      this.ensureCurrent(active);
      if (active.cancelRequested) {
        this.finishActive(active, { phase: 'idle' });
        return;
      }
      const digest = encodeBase64Url(digestBytes);
      active.digest = digest;

      const begin: ImageStagingRequest = {
        type: 'image_upload_begin',
        id: newRequestId(),
        timestamp: timestamp(),
        sessionId: active.context.sessionId,
        binding: { harness: 'claude', harnessSessionId: active.context.harnessSessionId },
        mediaType: active.mediaType,
        byteLength: active.byteLength,
        digest,
      };
      const accepted = await this.sendAndWait(active, begin, 'image_upload_accepted');
      this.ensureCurrent(active);
      if (accepted.type !== 'image_upload_accepted') {
        throw new UploadError('bad_response', 'Unexpected image upload acceptance');
      }
      active.transferId = accepted.transferId;
      if (active.cancelRequested) {
        await this.cancelKnownTransfer(active);
        this.finishActive(active, { phase: 'idle' });
        return;
      }
      this.emitActive(active, {
        phase: 'uploading',
        filename: active.filename,
        uploadedBytes: 0,
        totalBytes: active.byteLength,
      });

      let receivedBytes = 0;
      const totalChunks = Math.ceil(bytes.byteLength / IMAGE_STAGING_LIMITS.chunkBytes);
      for (let seq = 0; seq < totalChunks; seq++) {
        if (active.cancelRequested) {
          await this.cancelKnownTransfer(active);
          this.finishActive(active, { phase: 'idle' });
          return;
        }
        this.ensureCurrent(active);
        const offset = seq * IMAGE_STAGING_LIMITS.chunkBytes;
        const chunk = bytes.subarray(
          offset,
          Math.min(offset + IMAGE_STAGING_LIMITS.chunkBytes, bytes.byteLength),
        );
        const expectedReceived = receivedBytes + chunk.byteLength;
        const request: ImageStagingRequest = {
          type: 'image_upload_chunk',
          id: newRequestId(),
          timestamp: timestamp(),
          sessionId: active.context.sessionId,
          transferId: active.transferId,
          seq,
          data: encodeBase64Url(chunk),
        };
        const ack = await this.sendAndWait(
          active,
          request,
          'image_upload_chunk_ack',
          active.transferId,
          seq,
          expectedReceived,
        );
        this.ensureCurrent(active);
        if (ack.type !== 'image_upload_chunk_ack') {
          throw new UploadError('bad_response', 'Unexpected image upload acknowledgment');
        }
        receivedBytes = ack.receivedBytes;
        if (active.cancelRequested) {
          await this.cancelKnownTransfer(active);
          this.finishActive(active, { phase: 'idle' });
          return;
        }
        this.emitActive(active, {
          phase: 'uploading',
          filename: active.filename,
          uploadedBytes: receivedBytes,
          totalBytes: active.byteLength,
        });
      }

      if (active.cancelRequested) {
        await this.cancelKnownTransfer(active);
        this.finishActive(active, { phase: 'idle' });
        return;
      }

      this.ensureCurrent(active);
      active.completeSent = true;
      const complete: ImageStagingRequest = {
        type: 'image_upload_complete',
        id: newRequestId(),
        timestamp: timestamp(),
        sessionId: active.context.sessionId,
        transferId: active.transferId,
      };
      const completion = this.sendAndWait(
        active,
        complete,
        'image_upload_result',
        active.transferId,
      );
      this.emitActive(active, { phase: 'checking', filename: active.filename });
      const result = await completion;
      this.ensureCurrent(active);
      if (
        result.type !== 'image_upload_result' ||
        result.outcome !== 'staged' ||
        result.transferId !== active.transferId ||
        result.byteLength !== active.byteLength ||
        result.mediaType !== active.mediaType ||
        result.digest !== digest
      ) {
        throw new UploadError(
          'bad_response',
          'Image upload result did not match the selected image',
        );
      }
      this.finishActive(active, { phase: 'staged', filename: active.filename });
    } catch (error) {
      if (this.active !== active) return;
      if (!this.isCurrent(active) && active.sentAny) {
        this.finishActive(
          active,
          this.uncertainOrFailed(
            active,
            'The connection changed during upload. Check the session before retrying.',
          ),
        );
        return;
      }
      if (
        error instanceof UploadError &&
        error.kind === 'timeout' &&
        error.operation === 'image_upload_chunk' &&
        active.transferId
      ) {
        await this.recoverLostChunkAck(active);
        return;
      }
      if (error instanceof UploadError && error.kind === 'context_lost') {
        this.finishActive(active, this.uncertainOrFailed(active, error.message));
        return;
      }
      if (active.currentOperation === 'image_upload_cancel' && !active.completeSent) {
        this.finishActive(active, {
          phase: 'uncertain',
          filename: active.filename,
          message: 'Upload cancellation was not confirmed. Check the session before retrying.',
        });
        return;
      }
      if (!active.sentAny) {
        const message =
          error instanceof UploadError && error.kind === 'send_failed'
            ? 'Could not start the image upload. Try again.'
            : 'Could not prepare the image. Choose it again to retry.';
        this.finishActive(active, { phase: 'failed', filename: active.filename, message });
        return;
      }
      if (error instanceof UploadError && error.kind === 'send_failed') {
        this.finishActive(active, {
          phase: 'uncertain',
          filename: active.filename,
          message:
            'The connection stopped accepting image upload requests. Check the session before retrying.',
        });
        return;
      }
      const failure = failureMessage(error);
      this.finishActive(active, {
        phase: failure.phase,
        filename: active.filename,
        message: failure.message,
      });
    }
  }

  private async recoverLostChunkAck(active: ActiveUpload): Promise<void> {
    if (!active.transferId || !this.isCurrent(active)) {
      this.finishActive(
        active,
        this.uncertainOrFailed(
          active,
          'The chunk response was lost. Check the session before retrying.',
        ),
      );
      return;
    }

    this.emitActive(active, { phase: 'cancelling', filename: active.filename });
    try {
      await this.cancelKnownTransfer(active);
      this.finishActive(active, {
        phase: 'failed',
        filename: active.filename,
        message: 'The unconfirmed upload was cancelled. Choose the image again to retry.',
      });
    } catch {
      this.finishActive(active, {
        phase: 'uncertain',
        filename: active.filename,
        message:
          'The chunk response was lost and cancellation was not confirmed. Check the session before retrying.',
      });
    }
  }

  private async cancelDuringCompletion(active: ActiveUpload): Promise<void> {
    try {
      await this.cancelKnownTransfer(active);
      if (this.active !== active) return;
      this.finishActive(
        active,
        active.stagedResult ? { phase: 'staged', filename: active.filename } : { phase: 'idle' },
      );
    } catch (error) {
      if (this.active !== active) return;
      if (error instanceof UploadError && error.kind === 'context_lost') {
        this.finishActive(
          active,
          this.uncertainOrFailed(
            active,
            'The connection changed during upload. Check the session before retrying.',
          ),
        );
      }
      // A cancel refusal or timeout does not decide whether completion staged.
      // Keep its pending request and let the completion result/deadline win.
    }
  }

  private async cancelKnownTransfer(active: ActiveUpload): Promise<void> {
    if (!active.transferId) throw new UploadError('bad_response', 'No accepted transfer to cancel');
    this.ensureCurrent(active);
    const cancel: ImageStagingRequest = {
      type: 'image_upload_cancel',
      id: newRequestId(),
      timestamp: timestamp(),
      sessionId: active.context.sessionId,
      transferId: active.transferId,
    };
    const result = await this.sendAndWait(
      active,
      cancel,
      'image_upload_cancel_result',
      active.transferId,
    );
    this.ensureCurrent(active);
    if (result.type !== 'image_upload_cancel_result' || result.outcome !== 'cancelled') {
      throw new UploadError('bad_response', 'Upload cancellation was not confirmed');
    }
  }

  private sendAndWait(
    active: ActiveUpload,
    request: ImageStagingRequest,
    expectedType: ExpectedResponseType,
    transferId: string | null = null,
    seq: number | null = null,
    receivedBytes: number | null = null,
  ): Promise<ImageStagingResponse> {
    this.ensureCurrent(active);
    const activePending = [...this.pending.values()].filter((pending) => pending.active === active);
    const completionCancellationRace =
      request.type === 'image_upload_cancel' &&
      active.completeSent &&
      activePending.length === 1 &&
      activePending[0]?.operation === 'image_upload_complete' &&
      activePending[0]?.expectedType === 'image_upload_result';
    if ((activePending.length > 0 && !completionCancellationRace) || this.pending.size >= 2) {
      throw new UploadError(
        'bad_response',
        'Another image upload request is pending',
        undefined,
        request.type,
      );
    }

    let resolve!: (message: ImageStagingResponse) => void;
    let reject!: (error: UploadError) => void;
    const response = new Promise<ImageStagingResponse>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timer = setTimeout(() => {
      const pending = this.pending.get(request.id);
      if (pending) {
        this.rejectPending(
          pending,
          new UploadError('timeout', 'Image upload response timed out', undefined, request.type),
        );
      }
    }, REQUEST_TIMEOUT_MS);
    const pending: PendingRequest = {
      active,
      requestId: request.id,
      operation: request.type,
      expectedType,
      transferId,
      seq,
      receivedBytes,
      timer,
      resolve,
      reject,
    };
    this.pending.set(request.id, pending);
    active.currentOperation = request.type;

    let queued = false;
    try {
      queued = this.transport.send(request);
    } catch {
      queued = false;
    }
    if (!queued) {
      this.rejectPending(
        pending,
        new UploadError(
          'send_failed',
          'Image upload request was not queued',
          undefined,
          request.type,
        ),
      );
    } else {
      active.sentAny = true;
    }
    return response;
  }

  private captureCurrentContext(): CapturedContext | null {
    try {
      return captureContext(this.transport.context());
    } catch {
      return null;
    }
  }

  private isCurrent(active: ActiveUpload): boolean {
    try {
      return sameContext(this.transport.context(), active.context);
    } catch {
      return false;
    }
  }

  private ensureCurrent(active: ActiveUpload): void {
    if (this.disposed || this.active !== active) {
      throw new UploadError(
        'context_lost',
        active.sentAny
          ? 'The connection changed during upload. Check the session before retrying.'
          : 'The connection changed before upload began. Choose the image again.',
      );
    }
    if (this.isCurrent(active)) return;
    throw new UploadError(
      'context_lost',
      active.sentAny
        ? 'The connection changed during upload. Check the session before retrying.'
        : 'The connection changed before upload began. Choose the image again.',
    );
  }

  private emitActive(active: ActiveUpload, state: ImageUploadState): void {
    if (this.active === active && !this.disposed && this.isCurrent(active)) this.onState(state);
  }

  private resolvePending(pending: PendingRequest, message: ImageStagingResponse): void {
    if (this.pending.get(pending.requestId) !== pending) return;
    this.clearPending(pending);
    pending.resolve(message);
  }

  private rejectPending(pending: PendingRequest, error: UploadError): void {
    if (this.pending.get(pending.requestId) !== pending) return;
    this.clearPending(pending);
    pending.reject(error);
  }

  private clearPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (this.pending.get(pending.requestId) === pending) this.pending.delete(pending.requestId);
  }

  private stopForContextLoss(active: ActiveUpload): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.active === active) {
        this.rejectPending(
          pending,
          new UploadError(
            'context_lost',
            'The connection changed during upload. Check the session before retrying.',
            undefined,
            pending.operation,
          ),
        );
      }
    }
    this.finishActive(
      active,
      this.uncertainOrFailed(
        active,
        'The connection changed during upload. Check the session before retrying.',
      ),
    );
  }

  private uncertainOrFailed(active: ActiveUpload, message: string): ImageUploadState {
    return active.sentAny
      ? { phase: 'uncertain', filename: active.filename, message }
      : { phase: 'failed', filename: active.filename, message };
  }

  private finishActive(active: ActiveUpload, state: ImageUploadState): void {
    if (this.active !== active) return;
    if (state.phase === 'uncertain' && active.sentAny) {
      this.blockedContext = active.context;
    }
    for (const pending of [...this.pending.values()]) {
      if (pending.active === active) {
        this.clearPending(pending);
        pending.reject(
          new UploadError('context_lost', 'Image upload stopped', undefined, pending.operation),
        );
      }
    }
    this.active = null;
    if (!this.disposed) {
      if (state.phase === 'staged' && active.stagedResult) {
        const draft = this.draft.stage(
          active.filename,
          active.stagedResult.artifactId,
          active.stagedResult.artifactExpiresAt,
        );
        this.onState(draft ? { ...state, draft } : state);
      } else this.onState(state);
    }
  }
}

function sameCapturedContext(left: CapturedContext | null, right: CapturedContext): boolean {
  return (
    left !== null &&
    left.connection === right.connection &&
    left.generation === right.generation &&
    left.sessionId === right.sessionId &&
    left.harnessSessionId === right.harnessSessionId
  );
}
