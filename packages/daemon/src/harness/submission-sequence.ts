/**
 * Internal connection-lifetime sequencing for the proposed #1207 contract.
 * The host handler owns device/session/binding authority
 * before calling and before returning a receipt, including cached receipts.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  ChatSubmitOutcome,
  ChatSubmitRequest,
  ChatSubmitResult,
} from '@remi/shared/structured-chat.ts';
import {
  decodeStructuredChatFrame,
  encodeStructuredChatFrame,
} from '@remi/shared/structured-chat.ts';

const RECENT_RECEIPTS = 32;
type Effect = (request: ChatSubmitRequest) => Promise<ChatSubmitOutcome>;
interface Receipt {
  readonly requestId: string;
  readonly digest: string;
  readonly promise: Promise<ChatSubmitResult>;
  result: ChatSubmitResult | null;
}

function capture(request: ChatSubmitRequest): ChatSubmitRequest {
  const decoded = decodeStructuredChatFrame(encodeStructuredChatFrame(request));
  if (decoded?.type !== 'chat_submit_request') throw new Error('Invalid structured chat request');
  // Explicit order makes equivalent property order irrelevant to the digest.
  const value: ChatSubmitRequest = Object.freeze({
    type: decoded.type,
    id: decoded.id,
    timestamp: decoded.timestamp,
    sessionId: decoded.sessionId,
    seq: decoded.seq,
    binding: Object.freeze({
      harness: decoded.binding.harness,
      harnessSessionId: decoded.binding.harnessSessionId,
    }),
    content: decoded.content,
  });
  return value;
}

function result(request: ChatSubmitRequest, outcome: ChatSubmitOutcome): ChatSubmitResult {
  const message: ChatSubmitResult = Object.freeze({
    ...outcome,
    type: 'chat_submit_result',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: request.sessionId,
    seq: request.seq,
    requestId: request.id,
  });
  if (decodeStructuredChatFrame(encodeStructuredChatFrame(message))?.type !== 'chat_submit_result')
    throw new Error('Invalid structured chat outcome');
  return message;
}

/** One instance per concrete connection/Remi session; never reset on binding or reattachment. */
export class SubmissionSequence {
  private highWater = 0;
  private closed = false;
  private active: number | null = null;
  private readonly receipts = new Map<number, Receipt>();

  /** Drop stale results without giving old input another sequence/effect window. */
  invalidateReceipts(): void {
    this.receipts.clear();
  }

  close(): void {
    this.closed = true;
    this.receipts.clear();
    // The actual writer's guard must cancel any not-yet-attempted effect.
    // Closing cannot undo input already accepted by a model.
  }

  async submit(request: ChatSubmitRequest, effect: Effect): Promise<ChatSubmitResult> {
    const value = capture(request);
    if (this.closed) return result(value, { outcome: 'refused', code: 'unavailable' });
    const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    if (value.seq <= this.highWater) {
      const old = this.receipts.get(value.seq);
      if (!old) return result(value, { outcome: 'uncertain', code: 'receipt_expired' });
      if (old.digest === digest) return old.promise;
      return result(
        value,
        old.result?.outcome === 'refused'
          ? { outcome: 'refused', code: 'conflict' }
          : { outcome: 'uncertain', code: 'conflict' },
      );
    }
    if (value.seq !== this.highWater + 1)
      return result(value, { outcome: 'refused', code: 'sequence' });
    this.highWater = value.seq;
    const collision = [...this.receipts.values()].find((old) => old.requestId === value.id);
    if (collision) {
      const conflict = result(
        value,
        collision.result?.outcome === 'refused'
          ? { outcome: 'refused', code: 'conflict' }
          : { outcome: 'uncertain', code: 'conflict' },
      );
      this.receipts.set(value.seq, {
        requestId: value.id,
        digest,
        promise: Promise.resolve(conflict),
        result: conflict,
      });
      this.trim();
      return conflict;
    }
    if (this.active !== null) {
      const refused = result(value, { outcome: 'refused', code: 'busy' });
      this.receipts.set(value.seq, {
        requestId: value.id,
        digest,
        promise: Promise.resolve(refused),
        result: refused,
      });
      this.trim();
      return refused;
    }
    this.active = value.seq;
    const receipt: Receipt = {
      requestId: value.id,
      digest,
      result: null,
      promise: Promise.resolve().then(async () => {
        let response: ChatSubmitResult;
        try {
          if (this.closed) response = result(value, { outcome: 'refused', code: 'unavailable' });
          else {
            const outcome = await effect(value);
            response = result(
              value,
              this.closed ? { outcome: 'uncertain', code: 'delivery_unknown' } : outcome,
            );
          }
        } catch {
          // The effect may have happened before throwing, including a malformed outcome.
          response = result(value, { outcome: 'uncertain', code: 'delivery_unknown' });
        } finally {
          this.active = null;
        }
        receipt.result = response;
        this.trim();
        return response;
      }),
    };
    this.receipts.set(value.seq, receipt);
    this.trim();
    return receipt.promise;
  }

  private trim(): void {
    // Keep one pending record pinned even if many later requests are refused busy.
    // The high-water mark prevents an evicted old sequence from executing again.
    for (const sequence of this.receipts.keys()) {
      if (this.receipts.size <= RECENT_RECEIPTS) break;
      if (sequence !== this.active) this.receipts.delete(sequence);
    }
  }
}
