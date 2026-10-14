import type { ImageDraftState, ImageUploadState } from '@/components/chat/ImageUpload';
import { type ProtocolMessage, generateId, hubSupport } from '@remi/shared';
import {
  IMAGE_INSERTION_CAPABILITY,
  type ImageInsertRequest,
  type ImageInsertResult,
} from '../../../shared/src/image-insertion.ts';
import type { ImageUploadContext, ImageUploadTransport } from './image-upload';

const INSERTION_TIMEOUT_MS = 15_000;

interface Draft {
  readonly filename: string;
  readonly context: ImageUploadContext;
  readonly artifactId: string;
  readonly expiresAt: string;
  state: ImageDraftState;
  request: ImageInsertRequest | null;
  sendId: string | null;
}

/** One staged image's explicit draft action; never submits a turn or extends retention. */
export class ImageDraftController {
  private draft: Draft | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly transport: ImageUploadTransport;
  private readonly onState: (state: ImageUploadState) => void;

  constructor(transport: ImageUploadTransport, onState: (state: ImageUploadState) => void) {
    this.transport = transport;
    this.onState = onState;
  }

  get canReplace(): boolean {
    return (
      !this.draft ||
      !['inserting', 'inserted', 'uncertain', 'submitting', 'send_uncertain'].includes(
        this.draft.state.phase,
      )
    );
  }

  get canDismiss(): boolean {
    return !this.draft || !['inserting', 'inserted', 'submitting'].includes(this.draft.state.phase);
  }

  stage(filename: string, artifactId: string, expiresAt: string): ImageDraftState | undefined {
    this.clear();
    const context = this.transport.context();
    if (!context || !this.transport.sendInsertion || !this.supported(context)) return undefined;
    this.draft = {
      filename,
      // Keep values and opaque owner identities, never a mutable capabilities array or File.
      context: {
        ...context,
        binding: { ...context.binding },
        capabilities: [...context.capabilities],
      },
      artifactId,
      expiresAt,
      state: {
        phase: 'available',
        expiresAt,
        message: 'Ready to add to your draft.',
        action: 'insert',
      },
      request: null,
      sendId: null,
    };
    const delay = Date.parse(expiresAt) - Date.now();
    if (delay <= 0) this.expire();
    else this.expiryTimer = setTimeout(() => this.expire(), delay);
    return this.draft.state;
  }

  /** A fresh attempt or an exact status retry occurs only after a person's click. */
  addToDraft(): void {
    const draft = this.draft;
    if (!draft || !draft.state.action || !this.ensureCurrent(draft)) return;
    if (draft.state.action === 'insert') {
      draft.request = {
        type: 'image_insert_request',
        id: generateId().toLowerCase(),
        timestamp: new Date().toISOString(),
        sessionId: draft.context.sessionId,
        binding: { ...draft.context.binding },
        artifactId: draft.artifactId,
      };
    }
    if (!draft.request) return;
    this.clearReplyTimer();
    this.publish(draft, { phase: 'inserting', message: 'Adding image to draft…', action: null });
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      if (this.draft !== draft || !this.ensureCurrent(draft)) return;
      this.publish(draft, {
        phase: 'uncertain',
        message: 'No confirmation yet. Check status before adding another image.',
        action: 'check',
      });
    }, INSERTION_TIMEOUT_MS);
    // Even a send failure keeps this ID: it never justifies a second possible write.
    if (
      !this.transport.sendInsertion?.(draft.request) &&
      this.draft === draft &&
      this.ensureCurrent(draft)
    ) {
      this.clearReplyTimer();
      this.publish(draft, {
        phase: 'uncertain',
        message: 'Could not confirm delivery. Check status before adding another image.',
        action: 'check',
      });
    }
  }

  receive(result: ImageInsertResult): void {
    const draft = this.draft;
    if (
      !draft?.request ||
      ['submitted', 'submitting', 'send_uncertain'].includes(draft.state.phase) ||
      result.requestId !== draft.request.id ||
      result.sessionId !== draft.context.sessionId ||
      !this.ensureCurrent(draft)
    )
      return;
    this.clearReplyTimer();
    if (result.outcome === 'inserted') {
      this.publish(draft, { phase: 'inserted', message: 'Added to draft.', action: null });
    } else if (result.outcome === 'uncertain') {
      this.publish(draft, {
        phase: 'uncertain',
        message:
          'The image reference may be in your draft. Check the session before uploading again.',
        action: null,
      });
    } else if (result.code === 'expired') {
      this.expire();
    } else {
      const messages = {
        busy: 'The host is busy. Try Add to draft again in a moment.',
        prompt_up: 'Answer the current question before adding this image.',
        conflict:
          'This image may already be in the draft. Check the session before uploading again.',
        unavailable: 'This image can no longer be added from this connection. Upload it again.',
        binding_changed: 'The session changed. Upload this image again.',
        malformed: 'The host could not accept this draft request. Upload the image again.',
      };
      this.publish(draft, {
        phase: 'refused',
        message: messages[result.code],
        action: result.code === 'busy' || result.code === 'prompt_up' ? 'insert' : null,
      });
    }
  }

  disconnect(): void {
    const draft = this.draft;
    if (!draft) return;
    this.clearReplyTimer();
    // Preserve confirmed reference information and deadline without reviving its Send affordance.
    if (draft.state.phase === 'inserted') {
      this.publish(draft, {
        phase: 'unavailable',
        message: 'Added to draft, but the connection changed. Check the session before sending.',
        action: null,
      });
      return;
    }
    if (draft.state.phase === 'submitted' || draft.state.phase === 'expired') return;
    this.publish(draft, {
      phase: draft.request ? 'uncertain' : 'unavailable',
      message: draft.request
        ? 'The connection changed. Check the session for a possible image reference before uploading again.'
        : 'The connection changed. Upload this image again to add it to a draft.',
      action: null,
    });
  }

  /** Consume one explicit Send; ordinary input ACK/retry keeps its existing ID and semantics. */
  takeForSend(messageId: string): boolean {
    const draft = this.draft;
    if (!draft || draft.state.phase !== 'inserted' || !this.ensureCurrent(draft)) return false;
    draft.sendId = messageId;
    this.publish(draft, { phase: 'submitting', message: 'Sending image draft…', action: null });
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      if (this.draft === draft && this.ensureCurrent(draft)) this.sendUncertain(draft);
    }, INSERTION_TIMEOUT_MS);
    return true;
  }

  receiveInputReceipt(message: ProtocolMessage): void {
    const draft = this.draft;
    if (!draft?.sendId || !['submitting', 'send_uncertain'].includes(draft.state.phase)) return;
    const accepted =
      message.type === 'ack' &&
      message.ack.messageId === draft.sendId &&
      message.ack.state === 'delivered';
    const refused = message.type === 'error' && message.details?.['messageId'] === draft.sendId;
    if ((!accepted && !refused) || !this.ensureCurrent(draft)) return;
    this.clearReplyTimer();
    if (accepted)
      this.publish(draft, {
        phase: 'submitted',
        message: 'Image draft submitted. Check the session for its response.',
        action: null,
      });
    else this.sendUncertain(draft);
  }

  private sendUncertain(draft: Draft): void {
    this.publish(draft, {
      phase: 'send_uncertain',
      message:
        'Send was not confirmed. Check the session and message status before retrying; the original image deadline still applies.',
      action: null,
    });
  }

  endSession(sessionId: string): void {
    if (this.draft?.context.sessionId === sessionId) this.expire();
  }

  clear(): void {
    this.clearReplyTimer();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.draft = null;
  }

  private supported(context: ImageUploadContext): boolean {
    return hubSupport(
      { protocolVersion: context.protocolVersion, capabilities: context.capabilities },
      [IMAGE_INSERTION_CAPABILITY],
    ).supported;
  }

  private ensureCurrent(draft: Draft): boolean {
    if (this.draft !== draft || draft.state.phase === 'expired') return false;
    if (Date.now() >= Date.parse(draft.expiresAt)) {
      this.expire();
      return false;
    }
    const current = this.transport.context();
    const original = draft.context;
    if (
      !current ||
      !this.supported(current) ||
      current.transport !== 'direct' ||
      current.connection !== original.connection ||
      current.generation !== original.generation ||
      current.sessionId !== original.sessionId ||
      current.protocolVersion !== original.protocolVersion ||
      current.binding.harness !== 'claude' ||
      current.binding.harnessSessionId !== original.binding.harnessSessionId ||
      draft.state.phase === 'unavailable' ||
      (draft.state.phase === 'uncertain' && draft.state.action === null)
    ) {
      this.disconnect();
      return false;
    }
    return true;
  }

  private expire(): void {
    const draft = this.draft;
    if (!draft) return;
    this.clearReplyTimer();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.publish(draft, {
      phase: 'expired',
      message:
        'Image reference expired. If you have not sent it, remove it from the draft and upload again.',
      action: null,
    });
  }

  private publish(draft: Draft, state: Omit<ImageDraftState, 'expiresAt'>): void {
    draft.state = { ...state, expiresAt: draft.expiresAt };
    this.onState({ phase: 'staged', filename: draft.filename, draft: draft.state });
  }

  private clearReplyTimer(): void {
    if (this.replyTimer) clearTimeout(this.replyTimer);
    this.replyTimer = null;
  }
}
