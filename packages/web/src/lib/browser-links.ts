/** Ephemeral, explicit browser receiver. No outbox, URL history, or automatic selection. */
import {
  BROWSER_LINKS_LIMITS,
  type BrowserLinkCandidate,
  type BrowserLinkMessage,
  type BrowserLinkReceiverRequest,
  generateId,
} from '@remi/shared';

export interface BrowserLinkContext {
  readonly connection: object;
  readonly generation: object;
  readonly attachment: object;
  readonly identityRevision: number;
  readonly identityKey: string;
  readonly sessionId: string;
  readonly bindingId: string;
}
export interface BrowserLinksState {
  readonly phase:
    | 'unavailable'
    | 'ready'
    | 'pending'
    | 'receiving'
    | 'replaced'
    | 'uncertain'
    | 'expired';
  readonly candidates: readonly { readonly id: string; readonly url: string }[];
  readonly error?: string;
}
interface Transport {
  context(): BrowserLinkContext | null;
  send(request: BrowserLinkReceiverRequest, generation: object): boolean;
}
interface Pending {
  readonly request: BrowserLinkReceiverRequest;
  readonly context: BrowserLinkContext;
  readonly timer: ReturnType<typeof setTimeout>;
}
const same = (a: BrowserLinkContext, b: BrowserLinkContext | null) =>
  !!b &&
  a.connection === b.connection &&
  a.generation === b.generation &&
  a.attachment === b.attachment &&
  a.identityRevision === b.identityRevision &&
  a.identityKey === b.identityKey &&
  a.sessionId === b.sessionId &&
  a.bindingId === b.bindingId;

export class BrowserLinkController {
  private generation: object | null = null;
  private readonly sequences = new Map<string, number>();
  private context: BrowserLinkContext | null = null;
  private pending: Pending | null = null;
  private lease: string | null = null;
  private candidates: { readonly frame: BrowserLinkCandidate; readonly deadline: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private phase: BrowserLinksState['phase'] = 'unavailable';
  private error: string | undefined;
  private disposed = false;
  private readonly transport: Transport;
  private readonly changed: () => void;
  constructor(transport: Transport, changed: () => void) {
    this.transport = transport;
    this.changed = changed;
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', this.foreground);
  }
  private readonly foreground = () => {
    if (document.visibilityState === 'visible') {
      this.refresh();
      this.changed();
    }
  };
  private clear(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.lease = null;
    this.candidates = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  refresh(): void {
    const current = this.disposed ? null : this.transport.context();
    if (!current || (this.context && !same(this.context, current))) {
      this.clear();
      this.context = current;
      this.phase = current ? 'ready' : 'unavailable';
      this.error = undefined;
    } else if (!this.context && current) {
      this.context = current;
      this.phase = 'ready';
    }
    if (current && current.generation !== this.generation) {
      this.generation = current.generation;
      this.sequences.clear();
    }
    const before = this.candidates.length;
    const now = performance.now();
    this.candidates = this.candidates.filter((candidate) => candidate.deadline > now);
    if (before && !this.candidates.length && this.lease) this.phase = 'expired';
    this.scheduleExpiry();
  }
  get state(): BrowserLinksState {
    this.refresh();
    return {
      phase: this.phase,
      candidates: this.candidates.map(({ frame }) => ({ id: frame.id, url: frame.url })),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  private scheduleExpiry(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.candidates.length) {
      const deadline = Math.min(...this.candidates.map((candidate) => candidate.deadline));
      this.timer = setTimeout(
        () => {
          this.timer = null;
          this.refresh();
          this.changed();
        },
        Math.max(1, deadline - performance.now()),
      );
    }
  }
  receiveHere(): void {
    this.request('select');
  }
  stop(): void {
    this.refresh();
    // A user Stop supersedes the old local correlation with one new release, never a retry.
    if (this.pending) this.clear();
    this.request('release');
  }
  private request(action: BrowserLinkReceiverRequest['action']): void {
    this.refresh();
    const context = this.context;
    if (!context || this.pending) return;
    if (!this.sequences.has(context.sessionId) && this.sequences.size >= 64) {
      this.phase = 'unavailable';
      this.changed();
      return;
    }
    const seq = (this.sequences.get(context.sessionId) ?? 0) + 1;
    if (seq > BROWSER_LINKS_LIMITS.maxSequence) {
      this.phase = 'unavailable';
      this.changed();
      return;
    }
    const request: BrowserLinkReceiverRequest = {
      type: 'browser_link_receiver_request',
      id: generateId(),
      timestamp: new Date().toISOString(),
      sessionId: context.sessionId,
      binding: { harness: 'claude', harnessSessionId: context.bindingId },
      seq,
      action,
    };
    this.clear();
    this.context = context;
    this.phase = 'pending';
    this.error = undefined;
    this.sequences.set(context.sessionId, seq); // Consumed before send, even if its outcome is unknown.
    const timer = setTimeout(() => {
      this.clear();
      this.phase = 'uncertain';
      this.changed();
    }, 15000);
    this.pending = { request, context, timer };
    try {
      if (
        !same(context, this.transport.context()) ||
        !this.transport.send(request, context.generation)
      ) {
        this.clear();
        this.phase = 'uncertain';
      }
    } catch {
      this.clear();
      this.phase = 'uncertain';
    }
    this.changed();
  }
  receive(message: Exclude<BrowserLinkMessage, BrowserLinkReceiverRequest>): void {
    this.refresh();
    const context = this.context;
    if (!context || message.sessionId !== context.sessionId) return;
    if (message.type === 'browser_link_receiver_result') {
      const pending = this.pending;
      if (
        !pending ||
        message.requestId !== pending.request.id ||
        message.seq !== pending.request.seq ||
        !same(pending.context, this.transport.context())
      )
        return;
      clearTimeout(pending.timer);
      this.pending = null;
      if (message.outcome === 'selected' && pending.request.action === 'select') {
        this.lease = message.leaseId;
        this.phase = 'receiving';
      } else if (message.outcome === 'released' && pending.request.action === 'release') {
        this.clear();
        this.phase = 'ready';
      } else {
        this.clear();
        this.phase = pending.request.action === 'release' ? 'uncertain' : 'ready';
        this.error =
          pending.request.action === 'release'
            ? 'Release not confirmed. Choose Stop receiving to make a new request.'
            : 'Receiver request refused. Choose Receive again to make a new request.';
      }
    } else if (message.type === 'browser_link_receiver_ended') {
      if (message.leaseId !== this.lease) return;
      this.clear();
      this.phase = message.reason === 'replaced' ? 'replaced' : 'ready';
    } else {
      if (
        !this.lease ||
        message.leaseId !== this.lease ||
        message.binding.harnessSessionId !== context.bindingId
      )
        return;
      if (this.candidates.some(({ frame }) => frame.id === message.id)) return;
      this.candidates.push({
        frame: message,
        deadline: performance.now() + BROWSER_LINKS_LIMITS.lifetimeMs,
      });
      this.candidates = this.candidates.slice(-8);
      this.phase = 'receiving';
      this.scheduleExpiry();
    }
    this.changed();
  }
  open(id: string): void {
    this.refresh();
    const candidate = this.candidates.find(({ frame }) => frame.id === id);
    if (
      !this.context ||
      !this.lease ||
      !candidate ||
      candidate.deadline <= performance.now() ||
      !same(this.context, this.transport.context()) ||
      candidate.frame.leaseId !== this.lease
    )
      return;
    try {
      window.open(candidate.frame.url, '_blank', 'noopener,noreferrer');
    } catch {
      this.error = 'Unable to open the destination.';
      this.changed();
    }
  }
  disconnect(): void {
    this.clear();
    this.context = null;
    this.phase = 'unavailable';
  }
  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.sequences.clear();
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.foreground);
  }
}
