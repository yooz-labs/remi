/** One explicit submit, one concrete socket generation; never an outbox or automatic retry. */
import {
  type ChatSubmitOutcome,
  type ChatSubmitRequest,
  type ChatSubmitResult,
  STRUCTURED_CHAT_LIMITS,
  generateId,
  validChatSubmitText,
} from '@remi/shared';

export interface StructuredChatContext {
  readonly generation: object;
  readonly sessionId: string;
  readonly threadId: string;
}
interface Transport {
  context(sessionId: string, threadId: string): StructuredChatContext | null;
  send(request: ChatSubmitRequest): boolean;
}
interface Pending {
  readonly request: ChatSubmitRequest;
  readonly context: StructuredChatContext;
  readonly resolve: (outcome: ChatSubmitOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
const unknown = (): ChatSubmitOutcome => ({ outcome: 'uncertain', code: 'delivery_unknown' });
const same = (a: StructuredChatContext, b: StructuredChatContext | null) =>
  !!b && a.generation === b.generation && a.sessionId === b.sessionId && a.threadId === b.threadId;

export class StructuredChatController {
  private generation: object | null = null;
  private blockedGeneration: object | null = null;
  private readonly sequences = new Map<string, number>();
  private pending: Pending | null = null;
  private closed = false;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  constructor(transport: Transport, timeoutMs = 15000) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  private context(sessionId: string, threadId: string): StructuredChatContext | null {
    if (this.closed) return null;
    const current = this.transport.context(sessionId, threadId);
    if (current && current.generation !== this.generation) {
      this.disconnect();
      this.generation = current.generation;
      this.sequences.clear();
      this.blockedGeneration = null;
    }
    return current;
  }
  canSubmit(sessionId: string, threadId: string): boolean {
    const current = this.context(sessionId, threadId);
    return (
      !!current &&
      current.sessionId === sessionId &&
      current.threadId === threadId &&
      !this.pending &&
      this.blockedGeneration !== current.generation
    );
  }
  async submit(
    sessionId: string,
    threadId: string,
    content: string,
    id = generateId(),
  ): Promise<ChatSubmitOutcome> {
    if (!validChatSubmitText(content)) return { outcome: 'refused', code: 'malformed' };
    const context = this.context(sessionId, threadId);
    if (!context || context.sessionId !== sessionId || context.threadId !== threadId)
      return { outcome: 'refused', code: 'unavailable' };
    if (this.pending || this.blockedGeneration === context.generation)
      return { outcome: 'refused', code: 'busy' };
    if (!this.sequences.has(sessionId) && this.sequences.size >= 64)
      return { outcome: 'refused', code: 'unavailable' };
    const seq = (this.sequences.get(sessionId) ?? 0) + 1;
    if (seq > STRUCTURED_CHAT_LIMITS.maxSequence) return { outcome: 'refused', code: 'sequence' };
    const request: ChatSubmitRequest = Object.freeze({
      type: 'chat_submit_request',
      id,
      timestamp: new Date().toISOString(),
      sessionId,
      seq,
      binding: Object.freeze({ harness: 'codex', harnessSessionId: threadId }),
      content,
    });
    this.sequences.set(sessionId, seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(unknown()), this.timeoutMs);
      this.pending = { request, context: { ...context }, resolve, timer };
      // Once send is invoked, a thrown/false transport result cannot establish non-delivery.
      try {
        if (
          !same(context, this.transport.context(sessionId, threadId)) ||
          !this.transport.send(request)
        )
          this.finish(unknown());
      } catch {
        this.finish(unknown());
      }
    });
  }
  receive(result: ChatSubmitResult): void {
    const pending = this.pending;
    if (
      !pending ||
      result.requestId !== pending.request.id ||
      result.seq !== pending.request.seq ||
      result.sessionId !== pending.request.sessionId
    )
      return;
    this.finish(
      same(
        pending.context,
        this.transport.context(pending.request.sessionId, pending.request.binding.harnessSessionId),
      )
        ? result
        : unknown(),
    );
  }
  private finish(outcome: ChatSubmitOutcome): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (outcome.outcome === 'uncertain') this.blockedGeneration = pending.context.generation;
    pending.resolve(outcome);
  }
  disconnect(): void {
    this.finish(unknown());
  }
  invalidateSession(sessionId: string): void {
    if (this.pending?.request.sessionId === sessionId) this.finish(unknown());
  }
  dispose(): void {
    this.closed = true;
    this.disconnect();
    this.sequences.clear();
  }
}

export function chatSubmissionLabel(outcome: ChatSubmitOutcome): string {
  if (outcome.outcome === 'accepted')
    return outcome.method === 'turn/steer' ? 'Added to current turn' : 'Accepted by Codex';
  if (outcome.outcome === 'uncertain')
    return 'Delivery unknown. Check the session, then reconnect before sending again.';
  switch (outcome.code) {
    case 'prompt_up':
      return 'Not sent. Answer the pending prompt first.';
    case 'binding_changed':
      return 'Not sent. The session moved to another thread.';
    case 'malformed':
      return 'Not sent. Use nonblank text up to 16 KiB.';
    case 'busy':
      return 'Not sent. Wait for the pending submission or reconnect after an uncertain delivery.';
    case 'sequence':
    case 'conflict':
      return 'Not sent. Reconnect before sending again.';
    default:
      return 'Not sent. Reconnect to a machine that supports Codex chat.';
  }
}
