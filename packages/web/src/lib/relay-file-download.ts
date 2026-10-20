/** One explicit download on a verified child attachment of an encrypted machine channel. */
import type { HelloAckMessage, ProtocolMessage } from '@remi/shared';
import { encodeFileDownloadFrame } from '../../../shared/src/file-download.ts';
import {
  type FileDownloadContext,
  FileDownloadController,
  type FileDownloadRequest,
  captureFileDownloadContext,
} from './file-download';
import type { RelayBrowserIdentity } from './relay-browser-links';

interface Transport {
  context(): RelayBrowserIdentity | null;
  /** Objects come only from the manager's bounded, verified child-hello map. */
  proof(sessionId: string): object | undefined;
  proofs(): Iterable<readonly [string, object]>;
  readonly webSocketUrl: string;
  send(request: FileDownloadRequest, generation: object): boolean;
}

const sameIdentity = (a: RelayBrowserIdentity | null, b: RelayBrowserIdentity | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.connection === b.connection &&
    a.generation === b.generation &&
    a.identityRevision === b.identityRevision &&
    a.identityKey === b.identityKey);

export class RelayFileDownloads {
  readonly controller: FileDownloadController;
  private contexts = new WeakMap<object, FileDownloadContext | null>();
  private retired = new WeakSet<object>();
  private channel: RelayBrowserIdentity | null = null;
  private active: { readonly sessionId: string; readonly proof: object } | null = null;
  private disposed = false;
  private readonly transport: Transport;
  private readonly changed: () => void;
  constructor(transport: Transport, changed: () => void) {
    this.transport = transport;
    this.changed = changed;
    this.controller = new FileDownloadController(
      {
        context: () => this.current(),
        send: (request, generation) => {
          const context = this.current();
          return (
            !!context &&
            request.sessionId === context.sessionId &&
            generation === context.generation &&
            this.transport.send(request, generation)
          );
        },
      },
      changed,
    );
  }

  private synchronize(): void {
    const next = this.transport.context();
    if (sameIdentity(this.channel, next)) return;
    // Publish the new scope before callbacks can ask for availability again.
    this.channel = next ? { ...next } : null;
    this.contexts = new WeakMap();
    this.retired = new WeakSet();
    this.controller.disconnect();
  }
  private context(
    sessionId: string,
    proof = this.transport.proof(sessionId),
  ): FileDownloadContext | null {
    if (
      this.disposed ||
      !proof ||
      this.retired.has(proof) ||
      this.transport.proof(sessionId) !== proof
    )
      return null;
    const context = this.contexts.get(proof);
    return context && sameIdentity(context, this.transport.context()) ? context : null;
  }
  private current(): FileDownloadContext | null {
    return this.active ? this.context(this.active.sessionId, this.active.proof) : null;
  }
  private invalidate(sessionId: string): void {
    const proof = this.transport.proof(sessionId);
    if (proof) this.retired.add(proof);
    if (this.active?.sessionId === sessionId) this.controller.disconnect();
  }
  private hello(message: HelloAckMessage): void {
    if (!message.sessionId) return;
    const proof = this.transport.proof(message.sessionId);
    if (!proof) return;
    const identity = this.transport.context();
    const harness = message.harness ?? 'claude';
    const binding =
      message.harnessSessionId ?? (harness === 'claude' ? message.claudeSessionId : null);
    if (this.contexts.has(proof)) {
      const saved = this.contexts.get(proof);
      if (
        !this.retired.has(proof) &&
        saved &&
        sameIdentity(saved, identity) &&
        saved.sessionId === message.sessionId &&
        saved.binding.harness === harness &&
        saved.binding.harnessSessionId === binding &&
        message.attachState === 'attached' &&
        saved.protocolVersion === message.protocolVersion &&
        JSON.stringify(saved.capabilities) === JSON.stringify(message.capabilities ?? [])
      )
        return;
      // Replaying the same cached hello cannot restore a retired or changed attachment.
      this.retired.add(proof);
      if (this.active?.sessionId === message.sessionId) this.controller.disconnect();
      return;
    }
    if (this.active?.sessionId === message.sessionId) this.controller.disconnect();
    this.contexts.set(proof, null);
    if (
      !identity ||
      (harness !== 'claude' && harness !== 'codex') ||
      !binding ||
      message.attachState !== 'attached'
    )
      return;
    const context = captureFileDownloadContext({
      ...identity,
      attachment: proof,
      transport: 'relay',
      relayChannel: identity.generation,
      authenticated: true,
      webSocketUrl: this.transport.webSocketUrl,
      sessionId: message.sessionId,
      binding: { harness, harnessSessionId: binding },
      protocolVersion: message.protocolVersion,
      capabilities: message.capabilities ?? [],
    });
    if (context) this.contexts.set(proof, context);
  }

  get sessionId(): string | null {
    return this.active?.sessionId ?? null;
  }
  get busySessionId(): string | null {
    return ['idle', 'failed', 'cancelled'].includes(this.controller.state.phase)
      ? null
      : (this.active?.sessionId ?? null);
  }
  get availableSessions(): readonly string[] {
    if (this.disposed) return [];
    this.synchronize();
    const busy = this.busySessionId;
    return [...this.transport.proofs()]
      .filter(([id, proof]) => (!busy || busy === id) && !!this.context(id, proof))
      .map(([id]) => id);
  }
  start(sessionId: string, relativePath: string): boolean {
    if (this.disposed) return false;
    this.synchronize();
    const proof = this.transport.proof(sessionId);
    if (!proof || !this.context(sessionId, proof)) return false;
    // A second explicit click cannot steal an in-flight or verified operation.
    if (!['idle', 'failed', 'cancelled'].includes(this.controller.state.phase)) return false;
    this.active = { sessionId, proof };
    this.controller.start(relativePath);
    return true;
  }
  beforeSend(message: ProtocolMessage): void {
    if (this.disposed || message.type !== 'kill_session_request') return;
    this.synchronize();
    // A possible stop ends the captured lifetime even if its response is lost.
    this.invalidate(message.sessionId);
    this.changed();
  }
  /** RelayMachineChannel already strictly decoded the ORIGINAL plaintext before this callback. */
  receive(message: ProtocolMessage): boolean {
    if (this.disposed) return false;
    this.synchronize();
    if (message.type === 'hello_ack') this.hello(message);
    else if (
      message.type === 'file_fetch_accepted' ||
      message.type === 'file_fetch_chunk' ||
      message.type === 'file_fetch_result' ||
      message.type === 'file_fetch_cancel_result' ||
      message.type === 'file_fetch_refused'
    ) {
      this.controller.receive(encodeFileDownloadFrame(message));
      return true;
    } else if (
      message.type === 'session_rotated' ||
      (message.type === 'detach_session_ack' && message.success)
    )
      this.invalidate(message.sessionId);
    else if (message.type === 'session_update' && message.session.endedAt !== undefined)
      this.invalidate(message.session.id);
    else if (message.type === 'error' && message.code === 'SESSION_ENDED') {
      const sessionId = message.details?.['sessionId'];
      if (typeof sessionId === 'string') this.invalidate(sessionId);
      else for (const [id] of this.transport.proofs()) this.invalidate(id);
    } else if (message.type === 'session_list_response') {
      for (const entry of message.sessions) {
        if (entry.source !== 'daemon') continue;
        const context = this.context(entry.sessionId);
        if (!context) continue;
        const harness = entry.harness ?? 'claude';
        const binding =
          entry.harnessSessionId ?? (harness === 'claude' ? entry.claudeSessionId : null);
        if (
          harness !== context.binding.harness ||
          binding !== context.binding.harnessSessionId ||
          entry.status === 'orphaned'
        )
          this.invalidate(entry.sessionId);
      }
    }
    this.controller.contextChanged();
    this.changed();
    return false;
  }
  disconnect(): void {
    this.contexts = new WeakMap();
    this.retired = new WeakSet();
    this.channel = null;
    this.controller.disconnect();
    this.changed();
  }
  dispose(): void {
    this.disposed = true;
    this.contexts = new WeakMap();
    this.retired = new WeakSet();
    this.active = null;
    this.controller.dispose();
  }
}
