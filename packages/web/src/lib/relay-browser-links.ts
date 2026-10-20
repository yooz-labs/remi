/** Browser leases belong to a verified child attachment on one encrypted machine channel. */
import {
  type BrowserLinkReceiverRequest,
  type HelloAckMessage,
  type ProtocolMessage,
  hubSupport,
} from '@remi/shared';
import {
  type BrowserLinkContext,
  BrowserLinkController,
  type BrowserLinksState,
} from './browser-links';

export interface RelayBrowserIdentity {
  readonly connection: object;
  readonly generation: object;
  readonly identityRevision: number;
  readonly identityKey: string;
}
interface Transport {
  context(): RelayBrowserIdentity | null;
  send(request: BrowserLinkReceiverRequest, generation: object): boolean;
}
interface Attachment {
  context: BrowserLinkContext | null;
  ended: boolean;
}
interface Entry {
  readonly attachment: Attachment;
  readonly controller: BrowserLinkController;
}
const sameIdentity = (a: RelayBrowserIdentity, b: RelayBrowserIdentity | null) =>
  !!b &&
  a.connection === b.connection &&
  a.generation === b.generation &&
  a.identityRevision === b.identityRevision &&
  a.identityKey === b.identityKey;

export class RelayBrowserLinks {
  private readonly sessions = new Map<string, Entry>();
  private readonly stops = new Map<string, { sessionId: string; identity: RelayBrowserIdentity }>();
  private channel: RelayBrowserIdentity | null = null;
  private disposed = false;
  private readonly transport: Transport;
  private readonly changed: () => void;
  constructor(transport: Transport, changed: () => void) {
    this.transport = transport;
    this.changed = changed;
  }

  private synchronizeChannel(): void {
    const current = this.transport.context();
    if (!current) return;
    if (
      this.channel &&
      (this.channel.connection !== current.connection ||
        this.channel.generation !== current.generation)
    ) {
      for (const entry of this.sessions.values()) entry.controller.dispose();
      this.sessions.clear();
      this.stops.clear();
    }
    this.channel = current;
  }

  private context(attachment: Attachment): BrowserLinkContext | null {
    const context = attachment.context;
    if (this.disposed || attachment.ended || !context) return null;
    if (!sameIdentity(context, this.transport.context())) {
      attachment.context = null;
      return null;
    }
    return context;
  }
  private entry(sessionId: string): Entry | undefined {
    const known = this.sessions.get(sessionId);
    if (known || this.disposed || this.sessions.size >= 64) return known;
    const attachment: Attachment = { context: null, ended: false };
    const controller = new BrowserLinkController(
      {
        context: () => this.context(attachment),
        send: (request, generation) => {
          const current = this.context(attachment);
          return (
            !!current &&
            current.generation === generation &&
            request.sessionId === current.sessionId &&
            this.transport.send(request, generation)
          );
        },
      },
      this.changed,
    );
    const entry = { attachment, controller };
    this.sessions.set(sessionId, entry);
    return entry;
  }
  private invalidate(sessionId: string, ended = false): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.attachment.context = null;
    entry.attachment.ended ||= ended;
    // Keep the controller's consumed sequence on this same channel; never evict/recreate it.
    entry.controller.disconnect();
  }
  private hello(message: HelloAckMessage): void {
    if (!message.sessionId) return;
    const identity = this.transport.context();
    const binding = message.harnessSessionId ?? message.claudeSessionId;
    const eligible =
      identity &&
      (message.harness ?? 'claude') === 'claude' &&
      typeof binding === 'string' &&
      binding.length > 0 &&
      message.attachState === 'attached' &&
      hubSupport(message, ['browser_links']).supported;
    const entry = eligible ? this.entry(message.sessionId) : this.sessions.get(message.sessionId);
    if (!entry) return;
    this.invalidate(message.sessionId);
    if (eligible && !entry.attachment.ended) {
      entry.attachment.context = {
        ...identity,
        attachment: {},
        sessionId: message.sessionId,
        bindingId: binding,
      };
    }
    this.changed();
  }

  /** Capture before the possible send. A forgotten successful stop must not leave URLs usable. */
  beforeSend(message: ProtocolMessage): void {
    if (this.disposed || message.type !== 'kill_session_request') return;
    this.synchronizeChannel();
    const identity = this.transport.context();
    if (!identity || !this.entry(message.sessionId)) return;
    if (!this.stops.has(message.id) && this.stops.size >= 8) {
      for (const stop of this.stops.values()) this.invalidate(stop.sessionId, true);
      this.invalidate(message.sessionId, true);
      this.stops.clear();
      this.changed();
      return;
    }
    this.stops.set(message.id, { sessionId: message.sessionId, identity });
  }

  /** Input has already passed the channel's original-plaintext strict decoder. */
  receive(message: ProtocolMessage): boolean {
    if (this.disposed) return false;
    this.synchronizeChannel();
    if (message.type === 'hello_ack') this.hello(message);
    else if (
      message.type === 'browser_link_candidate' ||
      message.type === 'browser_link_receiver_result' ||
      message.type === 'browser_link_receiver_ended'
    ) {
      this.sessions.get(message.sessionId)?.controller.receive(message);
      this.changed();
      return true;
    } else if (message.type === 'kill_session_response') {
      const stop = this.stops.get(message.requestId);
      this.stops.delete(message.requestId);
      if (stop && message.success && sameIdentity(stop.identity, this.transport.context())) {
        this.invalidate(stop.sessionId, true);
        this.changed();
      }
    } else if (message.type === 'session_rotated') {
      this.invalidate(message.sessionId);
      this.changed();
    } else if (message.type === 'detach_session_ack' && message.success) {
      this.invalidate(message.sessionId);
      this.changed();
    } else if (message.type === 'session_update' && message.session.endedAt !== undefined) {
      this.invalidate(message.session.id, true);
      this.changed();
    } else if (message.type === 'error' && message.code === 'SESSION_ENDED') {
      // Legacy child notices carry no session id. Retire URLs without inventing their scope.
      const sessionId = message.details?.['sessionId'];
      if (typeof sessionId === 'string') this.invalidate(sessionId, true);
      else for (const id of this.sessions.keys()) this.invalidate(id);
      this.changed();
    } else if (message.type === 'session_list_response') {
      for (const session of message.sessions) {
        if (session.source !== 'daemon') continue;
        const entry = this.sessions.get(session.sessionId);
        const context = entry?.attachment.context;
        if (!context) continue;
        const binding = session.harnessSessionId ?? session.claudeSessionId;
        if (
          (session.harness ?? 'claude') !== 'claude' ||
          context.bindingId !== binding ||
          session.status === 'orphaned'
        )
          this.invalidate(session.sessionId);
      }
      this.changed();
    }
    return false;
  }
  get states(): readonly { readonly sessionId: string; readonly state: BrowserLinksState }[] {
    if (!this.disposed) this.synchronizeChannel();
    return [...this.sessions].map(([sessionId, entry]) => ({
      sessionId,
      state: entry.controller.state,
    }));
  }
  receiveHere(sessionId: string): void {
    if (!this.disposed) this.synchronizeChannel();
    this.sessions.get(sessionId)?.controller.receiveHere();
  }
  stop(sessionId: string): void {
    if (!this.disposed) this.synchronizeChannel();
    this.sessions.get(sessionId)?.controller.stop();
  }
  open(sessionId: string, candidateId: string): void {
    if (!this.disposed) this.synchronizeChannel();
    this.sessions.get(sessionId)?.controller.open(candidateId);
  }
  disconnect(): void {
    this.stops.clear();
    for (const sessionId of this.sessions.keys()) this.invalidate(sessionId);
    this.changed();
  }
  dispose(): void {
    this.disposed = true;
    this.stops.clear();
    for (const entry of this.sessions.values()) entry.controller.dispose();
    this.sessions.clear();
    this.channel = null;
  }
}
