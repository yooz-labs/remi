/** Browser receiver core; CLI owns production composition/readiness. No URL history. */
import { createHash, randomUUID } from 'node:crypto';
import type { UUID } from '@remi/shared';
import {
  type BrowserLinkEndedReason,
  type BrowserLinkReceiverRequest,
  type BrowserLinkReceiverResult,
  type BrowserLinkRefusalCode,
  decodeBrowserLinkFrame,
  encodeBrowserLinkFrame,
  normalizeBrowserLinkURL,
} from '@remi/shared';
import { WebSocketAdapter } from '../adapters/websocket-adapter.ts';
import type { IdentityStore } from '../auth/identity-store.ts';
import {
  type ConnectionDeviceIdentity,
  connectionDeviceIdentityInsideLock,
  connectionDeviceKey,
} from '../auth/relay-chat-authority.ts';
import type { SecurePushStore } from '../notifications/secure-push-store.ts';
import type { Connection } from '../server/connection.ts';
import type { SessionBindingStore } from '../session/session-binding-store.ts';
import type { ManagedSession, SessionRegistry } from '../session/session-registry.ts';
import type { BrowserLinkProducerContext } from './browser-link-producer.ts';

export interface BrowserLinkServiceHost {
  readonly identityStore: IdentityStore;
  readonly sessions: SessionRegistry;
  readonly bindings: SessionBindingStore;
  readonly directAdapter: () => WebSocketAdapter | undefined;
  readonly relayAuthority?: SecurePushStore;
  readonly producerContextFor: (sessionId: UUID) => BrowserLinkProducerContext | null;
}
interface Actor extends ConnectionDeviceIdentity {
  readonly connection: Connection;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly grant: string;
}
interface Authority extends Actor {
  readonly session: ManagedSession;
  readonly pty: ManagedSession['pty'];
  readonly attachment: object;
  readonly binding: string;
  readonly runtime: object;
}
interface Lease {
  readonly id: string;
  readonly authority: Authority;
  active: boolean;
}
interface SessionState {
  readonly session: ManagedSession;
  revision: object;
  lease: Lease | null;
  readonly attempts: number[];
}
interface Receipt {
  readonly requestId: string;
  readonly digest: string;
  readonly result: BrowserLinkReceiverResult;
  readonly actor: Actor;
  readonly authority: Authority | null;
  readonly revision: object | null;
  readonly lease: Lease | null;
}
interface Pair {
  highWater: number;
  readonly receipts: Map<number, Receipt>;
}
const sameActor = (a: Actor, b: Actor) =>
  a.connection === b.connection &&
  a.publicKey === b.publicKey &&
  a.fingerprint === b.fingerprint &&
  a.grant === b.grant &&
  a.proxy === b.proxy;
const same = (a: Authority | null, b: Authority | null): boolean =>
  a === b ||
  !!(
    a &&
    b &&
    sameActor(a, b) &&
    a.session === b.session &&
    a.pty === b.pty &&
    a.attachment === b.attachment &&
    a.binding === b.binding &&
    a.runtime === b.runtime
  );
function capture(input: BrowserLinkReceiverRequest): BrowserLinkReceiverRequest {
  const value = decodeBrowserLinkFrame(encodeBrowserLinkFrame(input));
  if (value?.type !== 'browser_link_receiver_request') throw new Error('Invalid browser request');
  return Object.freeze({
    type: value.type,
    id: value.id,
    timestamp: value.timestamp,
    sessionId: value.sessionId,
    binding: Object.freeze({
      harness: value.binding.harness,
      harnessSessionId: value.binding.harnessSessionId,
    }),
    seq: value.seq,
    action: value.action,
  });
}
function response(
  request: BrowserLinkReceiverRequest,
  outcome:
    | { outcome: 'selected'; leaseId: string }
    | { outcome: 'released' }
    | { outcome: 'refused'; code: BrowserLinkRefusalCode },
): BrowserLinkReceiverResult {
  return Object.freeze({
    type: 'browser_link_receiver_result',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: request.sessionId,
    requestId: request.id,
    seq: request.seq,
    ...outcome,
  });
}

export class BrowserLinkService {
  private readonly connections = new Map<
    UUID,
    { connection: Connection; pairs: Map<UUID, Pair> }
  >();
  private readonly frozen = new WeakSet<Connection>();
  private readonly sessions = new Map<UUID, SessionState>();
  private pairCount = 0;
  private closed = false;
  private grantHeld = false;
  private flushing = false;
  private readonly ended: { lease: Lease; reason: BrowserLinkEndedReason }[] = [];
  constructor(private readonly host: BrowserLinkServiceHost) {}

  private connection(id: UUID): Connection | null {
    const adapter = this.host.directAdapter();
    const connection = adapter instanceof WebSocketAdapter ? adapter.getDirectConnection(id) : null;
    return connection?.isConnected ? connection : null;
  }
  private actor(connection: Connection, grant: string | null): Actor | null {
    const identity = connectionDeviceIdentityInsideLock(
      connection,
      grant,
      this.host.relayAuthority,
    );
    return grant && identity && this.connection(connection.id) === connection
      ? { connection, ...identity, grant }
      : null;
  }
  /** Runs only inside the existing original-grant lock; never acquires another one. */
  private authority(actor: Actor, sessionId: UUID): Authority | null {
    if (
      this.closed ||
      (!actor.proxy && actor.connection.connectionListenerTransport !== 'public-tls')
    )
      return null;
    const session = this.host.sessions.getSessionForConnection(actor.connection.id);
    const attachment = this.host.sessions.getAttachmentToken(actor.connection.id);
    const binding = this.host.bindings.getIdentity(sessionId);
    const producer = this.host.producerContextFor(sessionId);
    if (
      !session ||
      session.sessionId !== sessionId ||
      !session.pty.isRunning ||
      !attachment ||
      binding?.harness !== 'claude' ||
      !binding.harnessSessionId ||
      !producer ||
      producer.sessionId !== sessionId ||
      producer.binding.harness !== 'claude' ||
      producer.binding.harnessSessionId !== binding.harnessSessionId ||
      !producer.runtime ||
      typeof producer.runtime !== 'object'
    )
      return null;
    return {
      ...actor,
      session,
      pty: session.pty,
      attachment,
      binding: binding.harnessSessionId,
      runtime: producer.runtime,
    };
  }
  private withGrant<T>(key: string, operation: (grant: string | null) => T, migrate = false): T {
    if (this.grantHeld) throw new Error('Browser grant unavailable');
    return this.host.identityStore.withAuthorizationEpochNonblocking(
      key,
      (grant) => {
        this.grantHeld = true;
        try {
          return operation(grant);
        } finally {
          this.grantHeld = false;
        }
      },
      migrate,
    );
  }
  /** Full for URLs/selected receipts; limited for URL-free refusals and ended notices only. */
  private guard(authority: Actor, full: boolean, effect: () => void): boolean {
    try {
      return this.withGrant(authority.publicKey, (grant) => {
        const actor = this.actor(authority.connection, grant);
        if (!actor || !sameActor(authority, actor)) return false;
        if (
          full &&
          !same(
            authority as Authority,
            this.authority(actor, (authority as Authority).session.sessionId),
          )
        )
          return false;
        effect();
        return true;
      });
    } catch {
      return false;
    }
  }
  private retire(state: SessionState, reason: BrowserLinkEndedReason): void {
    const lease = state.lease;
    if (!lease) return;
    lease.active = false;
    state.lease = null;
    state.revision = {};
    this.ended.push({ lease, reason });
  }
  private flushEnded(): void {
    if (this.grantHeld || this.flushing) return;
    this.flushing = true;
    try {
      for (let notice = this.ended.shift(); notice; notice = this.ended.shift()) {
        const { lease, reason } = notice;
        // Runtime/binding/attachment loss may be why it ended. Never use this guard for a URL.
        this.guard(lease.authority, false, () =>
          lease.authority.connection.sendBrowserLinkFrame({
            type: 'browser_link_receiver_ended',
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            sessionId: lease.authority.session.sessionId,
            leaseId: lease.id,
            reason,
          }),
        );
      }
    } finally {
      this.flushing = false;
    }
  }
  private state(session: ManagedSession): SessionState {
    for (const [id, state] of this.sessions) {
      if (this.host.sessions.getSession(id) !== state.session) {
        this.retire(state, 'session_changed');
        this.sessions.delete(id);
      }
    }
    const old = this.sessions.get(session.sessionId);
    if (old?.session === session) return old;
    if (old) this.retire(old, 'session_changed');
    const state: SessionState = { session, revision: {}, lease: null, attempts: [] };
    this.sessions.set(session.sessionId, state);
    return state;
  }
  isAvailable(id: UUID): boolean {
    try {
      const connection = this.connection(id);
      const key = connection ? connectionDeviceKey(connection) : null;
      if (this.closed || !connection || !key) return false;
      return this.withGrant(
        key,
        (grant) => {
          const actor = this.actor(connection, grant);
          const session = this.host.sessions.getSessionForConnection(id);
          return !!(actor && session && this.authority(actor, session.sessionId));
        },
        true,
      );
    } catch {
      return false;
    }
  }
  handleReceiver(id: UUID, input: BrowserLinkReceiverRequest): void {
    const connection = this.connection(id);
    const key = connection ? connectionDeviceKey(connection) : null;
    if (!connection) return;
    if (this.closed || !key) {
      connection.close('Browser links unavailable');
      return;
    }
    try {
      const request = capture(input);
      this.withGrant(
        key,
        (grant) => {
          const actor = this.actor(connection, grant);
          if (!actor) {
            connection.close('Browser links unavailable');
            return;
          }
          const refuse = (code: BrowserLinkRefusalCode) =>
            response(request, { outcome: 'refused', code });
          const send = (result: BrowserLinkReceiverResult) =>
            connection.sendBrowserLinkFrame(result);
          const authority = this.authority(actor, request.sessionId);
          let state = authority
            ? this.state(authority.session)
            : this.sessions.get(request.sessionId);
          if (
            state?.lease?.authority.connection === connection &&
            !same(state.lease.authority, authority)
          )
            this.retire(state, 'session_changed');
          let owner = this.connections.get(id);
          if (owner && owner.connection !== connection) {
            send(refuse('unavailable'));
            return;
          }
          let pair = owner?.pairs.get(request.sessionId);
          if (!pair) {
            if (this.frozen.has(connection) || this.pairCount >= 64) {
              this.frozen.add(connection);
              send(refuse('capacity'));
              return;
            }
            if (!owner) {
              owner = { connection, pairs: new Map() };
              this.connections.set(id, owner);
            }
            pair = { highWater: 0, receipts: new Map() };
            owner.pairs.set(request.sessionId, pair);
            this.pairCount++;
          }
          const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
          if (request.seq <= pair.highWater) {
            const old = pair.receipts.get(request.seq);
            if (!old) {
              send(refuse('sequence'));
              return;
            }
            if (old.digest !== digest) {
              send(refuse('conflict'));
              return;
            }
            const current =
              sameActor(old.actor, actor) &&
              same(old.authority, authority) &&
              old.revision === (state?.revision ?? null);
            if (
              !current ||
              (old.result.outcome === 'selected' &&
                (!old.lease?.active || state?.lease !== old.lease))
            ) {
              send(refuse('stale_receiver'));
              return;
            }
            // Full context remains current for selected receipts. Refusals contain no URLs/lease.
            send(old.result);
            return;
          }
          const skipped = request.seq !== pair.highWater + 1;
          pair.highWater = request.seq; // Consumed even when the following operation refuses.
          let result: BrowserLinkReceiverResult;
          if (skipped) result = refuse('sequence');
          else if ([...pair.receipts.values()].some((old) => old.requestId === request.id))
            result = refuse('conflict');
          else if (!authority) result = refuse('unavailable');
          else if (authority.binding !== request.binding.harnessSessionId)
            result = refuse('binding_changed');
          else {
            state = this.state(authority.session);
            if (request.action === 'release') {
              if (state.lease?.authority.connection !== connection)
                result = refuse('stale_receiver');
              else {
                this.retire(state, 'released');
                result = response(request, { outcome: 'released' });
              }
            } else {
              this.retire(state, 'replaced');
              const lease: Lease = { id: randomUUID(), authority, active: true };
              state.revision = {};
              state.lease = lease;
              result = response(request, { outcome: 'selected', leaseId: lease.id });
            }
          }
          pair.receipts.set(request.seq, {
            requestId: request.id,
            digest,
            result,
            actor,
            authority,
            revision: state?.revision ?? null,
            lease: result.outcome === 'selected' ? (state?.lease ?? null) : null,
          });
          while (pair.receipts.size > 32) {
            const oldest = pair.receipts.keys().next().value;
            if (oldest !== undefined) pair.receipts.delete(oldest);
          }
          send(result); // Same grant lock as the synchronous effect. Never roll back on send failure.
        },
        true,
      );
    } catch {
      connection.close('Browser links unavailable');
    } finally {
      this.flushEnded();
    }
  }
  offer(context: BrowserLinkProducerContext, input: string): boolean {
    try {
      const url = normalizeBrowserLinkURL(input);
      const session = this.host.sessions.getSession(context.sessionId);
      const producer = this.host.producerContextFor(context.sessionId);
      const binding = this.host.bindings.getIdentity(context.sessionId);
      if (
        this.closed ||
        !url ||
        !session?.pty.isRunning ||
        !producer ||
        context.binding.harness !== 'claude' ||
        producer.binding.harness !== 'claude' ||
        producer.runtime !== context.runtime ||
        producer.sessionId !== context.sessionId ||
        producer.binding.harnessSessionId !== context.binding.harnessSessionId ||
        binding?.harness !== 'claude' ||
        binding.harnessSessionId !== context.binding.harnessSessionId
      )
        return false;
      const state = this.state(session);
      const now = performance.now();
      while (state.attempts.length && now - (state.attempts[0] as number) >= 60000)
        state.attempts.shift();
      if (state.attempts.length >= 10) return false;
      state.attempts.push(now);
      const lease = state.lease;
      if (!lease?.active) return false;
      if (
        lease.authority.runtime !== context.runtime ||
        lease.authority.binding !== context.binding.harnessSessionId
      ) {
        this.retire(state, 'session_changed');
        return false;
      }
      let sent = false;
      if (
        !this.guard(lease.authority, true, () => {
          sent = lease.authority.connection.sendBrowserLinkFrame({
            type: 'browser_link_candidate',
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            sessionId: context.sessionId,
            binding: { ...context.binding },
            leaseId: lease.id,
            url,
            lifetimeMs: 120000,
          });
        })
      )
        this.retire(state, 'session_changed');
      return sent;
    } catch {
      return false;
    } finally {
      this.flushEnded();
    }
  }
  maintainSession(id: UUID): void {
    const state = this.sessions.get(id);
    const lease = state?.lease;
    if (state && lease && !this.guard(lease.authority, true, () => {}))
      this.retire(state, 'session_changed');
    this.flushEnded();
  }
  invalidateSession(id: UUID): void {
    const state = this.sessions.get(id);
    if (state) {
      this.retire(state, 'session_changed');
      state.revision = {};
      if (this.host.sessions.getSession(id) !== state.session) this.sessions.delete(id);
    }
    this.flushEnded();
  }
  forgetConnection(id: UUID): void {
    const owner = this.connections.get(id);
    if (owner) {
      this.pairCount -= owner.pairs.size;
      this.connections.delete(id);
      this.frozen.delete(owner.connection);
    }
    for (const state of this.sessions.values()) {
      if (state.lease?.authority.connection.id === id) this.retire(state, 'disconnected');
    }
    this.flushEnded();
  }
  close(): void {
    this.closed = true;
    for (const state of this.sessions.values()) this.retire(state, 'disconnected');
    this.connections.clear();
    this.pairCount = 0;
    this.sessions.clear();
    this.flushEnded();
  }
}
