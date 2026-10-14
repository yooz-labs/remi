/** Signed direct structured chat; transport receipts confer no model-write authority (#1207). */
import { randomUUID } from 'node:crypto';
import type { UUID } from '@remi/shared';
import type {
  ChatSubmitOutcome,
  ChatSubmitRequest,
  ChatSubmitResult,
} from '@remi/shared/structured-chat.ts';
import { WebSocketAdapter } from '../../adapters/websocket-adapter';
import type { IdentityStore } from '../../auth/identity-store';
import { SubmissionSequence } from '../../harness/submission-sequence';
import type { HarnessSession, HarnessStructuredChat } from '../../harness/types';
import type { Connection } from '../../server/connection';
import type { SessionBindingStore } from '../../session/session-binding-store';
import type { ManagedSession, SessionRegistry } from '../../session/session-registry';

interface Host {
  readonly identityStore: IdentityStore;
  readonly sessions: SessionRegistry;
  readonly bindings: SessionBindingStore;
  readonly harnessFor: (sessionId: UUID) => HarnessSession | undefined;
  readonly directAdapter: () => WebSocketAdapter | undefined;
}
interface Authority {
  readonly connection: Connection;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly grant: string;
  readonly session: ManagedSession;
  readonly pty: ManagedSession['pty'];
  readonly attachment: object;
  readonly writer: HarnessStructuredChat;
  readonly runtime: object;
  readonly threadId: string;
}
interface Pair {
  readonly sequence: SubmissionSequence;
  authority: Authority | null;
}
const refused = (): ChatSubmitOutcome => ({ outcome: 'refused', code: 'unavailable' });
function same(a: Authority | null, b: Authority | null): boolean {
  return (
    a === b ||
    !!(
      a &&
      b &&
      a.connection === b.connection &&
      a.publicKey === b.publicKey &&
      a.fingerprint === b.fingerprint &&
      a.grant === b.grant &&
      a.session === b.session &&
      a.pty === b.pty &&
      a.attachment === b.attachment &&
      a.writer === b.writer &&
      a.runtime === b.runtime &&
      a.threadId === b.threadId
    )
  );
}
function response(request: ChatSubmitRequest, outcome: ChatSubmitOutcome): ChatSubmitResult {
  return {
    ...outcome,
    type: 'chat_submit_result',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: request.sessionId,
    requestId: request.id,
    seq: request.seq,
  };
}

export class StructuredChatService {
  // Never evict a live pair: forgetting its high-water mark would permit old input again.
  private readonly connections = new Map<UUID, Map<UUID, Pair>>();
  private closed = false;
  constructor(private readonly host: Host) {}

  private direct(id: UUID): Connection | null {
    const adapter = this.host.directAdapter();
    const connection = adapter instanceof WebSocketAdapter ? adapter.getDirectConnection(id) : null;
    return connection?.isConnected &&
      connection.connectionClientPublicKey &&
      connection.connectionClientFingerprint
      ? connection
      : null;
  }

  /** Must run inside the grant lock. It never re-enters that lock. */
  private authority(id: UUID, sessionId: UUID, grant: string | null): Authority | null {
    if (this.closed || !grant) return null;
    const connection = this.direct(id);
    const session = this.host.sessions.getSessionForConnection(id);
    const attachment = this.host.sessions.getAttachmentToken(id);
    const identity = this.host.bindings.getIdentity(sessionId);
    const writer = this.host.harnessFor(sessionId)?.structuredChat;
    const runtime = writer?.context();
    const publicKey = connection?.connectionClientPublicKey;
    const fingerprint = connection?.connectionClientFingerprint;
    if (
      !connection ||
      !publicKey ||
      !fingerprint ||
      !session ||
      session.sessionId !== sessionId ||
      !session.pty.isRunning ||
      !attachment ||
      identity?.harness !== 'codex' ||
      !identity.harnessSessionId ||
      !writer ||
      !runtime
    )
      return null;
    return {
      connection,
      publicKey,
      fingerprint,
      grant,
      session,
      pty: session.pty,
      attachment,
      writer,
      runtime,
      threadId: identity.harnessSessionId,
    };
  }

  private capture(id: UUID, sessionId: UUID): Authority | null {
    try {
      const publicKey = this.direct(id)?.connectionClientPublicKey;
      if (!publicKey) return null;
      return this.host.identityStore.withAuthorizationEpochNonblocking(
        publicKey,
        (grant) => this.authority(id, sessionId, grant),
        true,
      );
    } catch {
      return null;
    }
  }

  /** Hold the original grant through the operation's synchronous effect/delivery. */
  private own(authority: Authority, operation: () => void): boolean {
    try {
      return this.host.identityStore.withAuthorizationEpochNonblocking(
        authority.publicKey,
        (grant) => {
          if (
            !same(
              authority,
              this.authority(authority.connection.id, authority.session.sessionId, grant),
            )
          )
            return false;
          operation();
          return true;
        },
      );
    } catch {
      return false;
    }
  }

  isAvailable(id: UUID): boolean {
    // Availability describes this actual handler/writer; first-turn binding can
    // arrive after hello. Admission still requires a live exact bound context.
    try {
      const connection = this.direct(id);
      const publicKey = connection?.connectionClientPublicKey;
      if (this.closed || !publicKey) return false;
      return this.host.identityStore.withAuthorizationEpochNonblocking(
        publicKey,
        (grant) => {
          const session = this.host.sessions.getSessionForConnection(id);
          return !!(
            grant &&
            connection === this.direct(id) &&
            session?.pty.isRunning &&
            this.host.harnessFor(session.sessionId)?.structuredChat &&
            this.host.sessions.getAttachmentToken(id)
          );
        },
        true,
      );
    } catch {
      return false;
    }
  }

  async handle(
    id: UUID,
    request: ChatSubmitRequest,
    deliver: (result: ChatSubmitResult) => void,
  ): Promise<void> {
    const connection = this.direct(id);
    if (this.closed || !connection) {
      deliver(response(request, refused()));
      return;
    }
    let pairs = this.connections.get(id);
    if (!pairs) {
      if (this.connections.size >= 128) {
        deliver(response(request, refused()));
        return;
      }
      pairs = new Map();
      this.connections.set(id, pairs);
    }
    let pair = pairs.get(request.sessionId);
    const authority = this.capture(id, request.sessionId);
    if (!pair) {
      if (pairs.size >= 64) {
        deliver(response(request, refused()));
        return;
      }
      pair = { sequence: new SubmissionSequence(), authority };
      pairs.set(request.sessionId, pair);
    } else if (!same(pair.authority, authority)) {
      pair.sequence.invalidateReceipts();
      pair.authority = authority;
    }
    const result = await pair.sequence.submit(request, async (value) => {
      if (!authority || !this.own(authority, () => {})) return refused();
      if (authority.threadId !== value.binding.harnessSessionId)
        return { outcome: 'refused', code: 'binding_changed' };
      return authority.writer.submit(
        value,
        () => this.own(authority, () => {}),
        (send) => this.own(authority, send),
      );
    });
    // Receipt reuse and fresh writes have the same delivery authority. A changed
    // owner may not receive an old accepted result/turn id, even on this socket.
    if (authority && this.own(authority, () => deliver(result))) return;
    if (connection !== this.direct(id)) return;
    deliver(
      response(
        request,
        result.outcome === 'refused'
          ? refused()
          : { outcome: 'uncertain', code: 'delivery_unknown' },
      ),
    );
  }

  forgetConnection(id: UUID): void {
    for (const pair of this.connections.get(id)?.values() ?? []) pair.sequence.close();
    this.connections.delete(id);
  }
  close(): void {
    this.closed = true;
    for (const id of this.connections.keys()) this.forgetConnection(id);
  }
}
