/** Signed direct WSS only (#1643); no capability, relay, input or automatic replay. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  TerminalViewBinding,
  TerminalViewMessage,
  TerminalViewRefusalCode,
  TerminalViewRequest,
} from '@remi/shared';
import { WebSocketAdapter } from '../adapters/websocket-adapter.ts';
import type { IdentityStore } from '../auth/identity-store.ts';
import {
  connectionDeviceIdentityInsideLock,
  connectionDeviceKey,
} from '../auth/relay-chat-authority.ts';
import type { Connection } from '../server/connection.ts';
import type { SessionBindingStore } from '../session/session-binding-store.ts';
import type { ManagedSession, SessionRegistry } from '../session/session-registry.ts';
import type {
  TerminalCaptureContext,
  TerminalCaptureHost,
  TerminalCaptureView,
} from './capture-host.ts';
import type { TerminalCorrelation, TerminalIngress } from './ingress.ts';
import { TerminalSendSlot } from './send-slot.ts';

export interface TerminalViewServiceHost {
  readonly identityStore: IdentityStore;
  readonly sessions: SessionRegistry;
  readonly bindings: SessionBindingStore;
  readonly capture: TerminalCaptureHost;
  readonly directAdapter: () => WebSocketAdapter | undefined;
  readonly runtimeFor: (sessionId: string) => object | undefined;
}
interface Authority {
  readonly connection: Connection;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly epoch: string;
  readonly session: ManagedSession;
  readonly pty: ManagedSession['pty'];
  readonly attachment: object;
  readonly runtime: object;
  readonly context: TerminalCaptureContext;
  readonly binding: TerminalViewBinding;
}
interface Record {
  authority: Authority;
  readonly view: TerminalCaptureView;
  readonly slot: TerminalSendSlot;
  unsubscribe: () => void;
  viewId: string;
  until: number;
  expiresAt: string;
  lastRead: number;
  intent: TerminalIngress | null;
  borrowing: boolean;
  state: 'open' | 'receipt' | 'retired';
  reason: TerminalViewRefusalCode | 'closed';
}
type Response = Exclude<TerminalViewMessage, TerminalViewRequest>;
const sameBinding = (a: TerminalViewBinding, b: TerminalViewBinding) =>
  a.harness === b.harness && a.harnessSessionId === b.harnessSessionId;
const sameActor = (a: Authority, b: Authority) =>
  a.connection === b.connection &&
  a.publicKey === b.publicKey &&
  a.fingerprint === b.fingerprint &&
  a.epoch === b.epoch &&
  a.session === b.session &&
  a.pty === b.pty &&
  a.attachment === b.attachment &&
  a.runtime === b.runtime &&
  a.context === b.context;
const correlation = (ingress: TerminalIngress): TerminalCorrelation =>
  ingress.kind === 'request'
    ? {
        id: ingress.request.id,
        sessionId: ingress.request.sessionId,
        operation: ingress.request.type,
      }
    : ingress.correlation;
const envelope = (request: TerminalCorrelation) => ({
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  sessionId: request.sessionId,
  requestId: request.id,
});

export class TerminalViewService {
  // Only real ledger-admitted views enter this map, including short-lived receipts.
  private readonly records = new Map<Connection, Record>();
  private readonly timer: ReturnType<typeof setInterval>;
  private grantHeld = false;
  private closed = false;

  constructor(private readonly host: TerminalViewServiceHost) {
    this.timer = setInterval(() => this.maintain(), 250);
    this.timer.unref();
  }

  private direct(id: string): Connection | undefined {
    const adapter = this.host.directAdapter();
    return adapter instanceof WebSocketAdapter ? adapter.getDirectConnection(id) : undefined;
  }

  private grant<T>(key: string, effect: (epoch: string | null) => T, migrate = false): T {
    if (this.grantHeld) throw new Error('Terminal authority unavailable');
    // Optional work fails immediately on contention; neither acquisition nor effects retry.
    return this.host.identityStore.withAuthorizationEpochNonblocking(
      key,
      (epoch) => {
        this.grantHeld = true;
        try {
          return effect(epoch);
        } finally {
          this.grantHeld = false;
        }
      },
      migrate,
    );
  }

  /** Caller holds the original grant lock; this does not acquire it recursively. */
  private actor(connection: Connection, sessionId: string, epoch: string | null): Authority | null {
    const identity = connectionDeviceIdentityInsideLock(connection, epoch);
    const session = this.host.sessions.getSessionForConnection(connection.id);
    const attachment = this.host.sessions.getAttachmentToken(connection.id);
    const runtime = this.host.runtimeFor(sessionId);
    const context = this.host.capture.contextFor(sessionId);
    const binding = this.host.bindings.getIdentity(sessionId);
    if (
      this.closed ||
      !epoch ||
      !identity ||
      identity.proxy ||
      !connection.isConnected ||
      connection.connectionListenerTransport !== 'public-tls' ||
      this.direct(connection.id) !== connection ||
      !session ||
      session.sessionId !== sessionId ||
      !session.pty.isRunning ||
      !attachment ||
      !runtime ||
      !context ||
      !binding?.harnessSessionId ||
      (binding.harness !== 'claude' && binding.harness !== 'codex')
    )
      return null;
    return {
      connection,
      ...identity,
      epoch,
      session,
      pty: session.pty,
      attachment,
      runtime,
      context,
      binding: { harness: binding.harness, harnessSessionId: binding.harnessSessionId },
    };
  }

  private current(record: Record, epoch: string | null): TerminalViewRefusalCode | null {
    const a = record.authority;
    const next = this.actor(a.connection, a.session.sessionId, epoch);
    if (!next || !sameActor(a, next)) return 'unavailable';
    return sameBinding(a.binding, next.binding) ? null : 'binding_changed';
  }

  private admit(authority: Authority): Record | null {
    const device = createHash('sha256')
      .update(Buffer.from(authority.publicKey, 'base64'))
      .digest('hex');
    const view = authority.context.reserveView(device, authority.connection.id);
    const transport = authority.connection.terminalTransport();
    if (!transport) {
      view.retire();
      return null;
    }
    const record: Record = {
      authority,
      view,
      slot: new TerminalSendSlot(transport, 'tls-receipt'),
      unsubscribe: () => {},
      viewId: '',
      // Admission already owns a control record while its first native job is queued.
      // Maintenance may run before that job; the original one-second lifetime starts here.
      until: performance.now() + 1000,
      expiresAt: '',
      lastRead: Number.NEGATIVE_INFINITY,
      intent: null,
      borrowing: false,
      state: 'receipt',
      reason: 'unavailable',
    };
    const unsubscribe = authority.connection.observeNativeSocket({
      drain: () => {
        record.slot.nativeDrained();
        this.wake(record.authority.context);
      },
      pong: (data) => {
        record.slot.nativePong(data);
        this.wake(record.authority.context);
      },
      closed: () => {
        record.slot.nativeClosed();
        this.retire(record);
      },
      retire: () => this.retire(record),
    });
    if (!unsubscribe) {
      view.retire();
      return null;
    }
    record.unsubscribe = unsubscribe;
    this.records.set(authority.connection, record);
    return record;
  }

  handle(connectionId: string, ingress: TerminalIngress): void {
    const request = correlation(ingress);
    const connection = this.direct(connectionId);
    const key = connection && connectionDeviceKey(connection);
    if (!connection || !key || this.closed) return;
    let record = this.records.get(connection);
    try {
      this.grant(
        key,
        (epoch) => {
          const authority = this.actor(connection, request.sessionId, epoch);
          if (!authority) {
            if (record) this.retire(record);
            return;
          }
          if (record && (record.state === 'retired' || !sameActor(record.authority, authority))) {
            this.retire(record);
            return; // Never attach old ownership to a fresh grant/runtime/attachment.
          }
          if (!record) record = this.admit(authority) ?? undefined;
          if (!record) return;
          if (
            ingress.kind === 'request' &&
            ingress.request.type === 'session_terminal_close' &&
            ingress.request.viewId === record.viewId &&
            record.viewId !== ''
          ) {
            // Closing cancels a held read even when its reply cannot yet be sent.
            // An already scheduled read also sees this state before any native effect.
            record.intent = null;
            if (record.state === 'open') this.receipt(record, 'closed');
          }
          if (record.slot.busy || record.intent !== null || this.modelBorrowed(record)) {
            this.hold(record, ingress);
            return;
          }
          this.schedule(record, ingress);
        },
        true,
      );
    } catch {
      if (record) this.retire(record);
      // No view/native capacity means no optional reply, ACK, generic queue or connection close.
    }
  }

  private hold(record: Record, ingress: TerminalIngress): void {
    if (
      record.intent === null &&
      ingress.kind === 'request' &&
      ingress.request.type !== 'session_terminal_open' &&
      ingress.request.viewId === record.viewId &&
      record.viewId !== ''
    )
      record.intent = ingress;
  }

  private modelBorrowed(record: Record): boolean {
    for (const other of this.records.values())
      if (other.authority.context === record.authority.context && other.borrowing) return true;
    return false;
  }

  private wake(context: TerminalCaptureContext): void {
    for (const record of this.records.values())
      if (record.authority.context === context) this.advance(record);
  }

  private schedule(owned: Record, ingress: TerminalIngress): void {
    // Only bounded request metadata survives until this first scheduling attempt.
    owned.slot.schedule((deliver) => {
      try {
        this.grant(owned.authority.publicKey, (currentEpoch) => {
          const fault = this.current(owned, currentEpoch);
          if (owned.state === 'retired' || fault === 'unavailable') {
            this.retire(owned);
            return;
          }
          const frame = owned.view.borrow();
          if (!frame) {
            if (owned.view.available) this.hold(owned, ingress);
            else this.retire(owned);
            return;
          }
          owned.borrowing = true;
          let finished = false;
          const finish = (uncertain: boolean) => {
            if (finished) return;
            finished = true;
            owned.borrowing = false;
            if (uncertain) frame.quarantine();
            else frame.release();
            this.wake(owned.authority.context);
          };
          let entered = false;
          try {
            const response = this.response(owned, ingress, frame.revision, frame.snapshot, fault);
            entered = true;
            deliver({
              message: response,
              release: () => finish(false),
              quarantine: () => finish(true),
            });
          } finally {
            if (!entered) finish(false);
          }
        });
      } catch {
        this.retire(owned); // No retry after callback/native entry or uncertain lock release.
      }
      return undefined;
    });
  }

  private advance(record: Record): void {
    this.cleanup(record);
    if (
      record.state === 'retired' ||
      record.slot.busy ||
      !record.intent ||
      this.modelBorrowed(record)
    )
      return;
    const intent = record.intent;
    record.intent = null;
    this.schedule(record, intent);
  }

  private response(
    record: Record,
    ingress: TerminalIngress,
    revision: number,
    snapshot: {
      columns: number;
      rows: number;
      lines: readonly string[];
      cursor: { row: number; column: number } | null;
    },
    authorityFault: TerminalViewRefusalCode | null,
  ): Response {
    const request = correlation(ingress);
    const header = envelope(request);
    const time = performance.now();
    const refuse = (code: TerminalViewRefusalCode): Response => ({
      ...header,
      type: 'session_terminal_refused',
      operation: request.operation,
      code,
    });
    if (authorityFault) {
      this.receipt(record, authorityFault);
      return refuse(authorityFault);
    }
    if (ingress.kind === 'malformed') {
      this.receipt(record, 'malformed');
      return refuse('malformed');
    }
    const message = ingress.request;
    if (message.type === 'session_terminal_open') {
      if (!sameBinding(message.binding, record.authority.binding)) {
        this.receipt(record, 'binding_changed');
        return refuse('binding_changed');
      }
      let id: string;
      do {
        id = randomBytes(16).toString('base64url');
      } while ([...this.records.values()].some((other) => other.viewId === id));
      record.viewId = id;
      record.until = time + 300000;
      record.expiresAt = new Date(Date.now() + 300000).toISOString();
      record.lastRead = Number.NEGATIVE_INFINITY;
      record.state = 'open';
      return {
        ...header,
        type: 'session_terminal_opened',
        viewId: id,
        expiresAt: record.expiresAt,
      };
    }
    if (message.viewId !== record.viewId) return refuse('unavailable');
    if (record.state === 'open' && time >= record.until) this.receipt(record, 'expired');
    if (record.state === 'receipt')
      return record.reason === 'closed' && message.type === 'session_terminal_close'
        ? { ...header, type: 'session_terminal_closed', viewId: record.viewId }
        : refuse(record.reason === 'closed' ? 'unavailable' : record.reason);
    if (message.type === 'session_terminal_close') {
      this.receipt(record, 'closed');
      return { ...header, type: 'session_terminal_closed', viewId: record.viewId };
    }
    if (time - record.lastRead < 500) return refuse('busy');
    record.lastRead = time;
    if (message.afterRevision !== null && message.afterRevision > revision)
      return refuse('malformed');
    return message.afterRevision === revision
      ? { ...header, type: 'session_terminal_unchanged', viewId: record.viewId, revision }
      : {
          ...header,
          type: 'session_terminal_snapshot',
          viewId: record.viewId,
          revision,
          ...snapshot,
        };
  }

  private receipt(record: Record, reason: Record['reason']): void {
    if (record.state !== 'receipt') record.until = performance.now() + 1000;
    // An initial control-only record keeps its original admission deadline.
    record.state = 'receipt';
    record.reason = reason;
  }

  private retire(record: Record): void {
    record.state = 'retired';
    record.intent = null;
    record.slot.retire();
    record.view.retire();
    this.cleanup(record);
  }

  private cleanup(record: Record): void {
    if (record.state !== 'retired' || record.slot.busy) return;
    record.unsubscribe();
    if (this.records.get(record.authority.connection) === record)
      this.records.delete(record.authority.connection);
  }

  private maintain(): void {
    for (const record of this.records.values()) {
      try {
        if (record.state !== 'retired') {
          const fault = this.grant(record.authority.publicKey, (epoch) =>
            this.current(record, epoch),
          );
          if (fault) {
            this.retire(record);
            continue;
          }
          if (performance.now() >= record.until) {
            if (record.state === 'open') this.receipt(record, 'expired');
            else this.retire(record);
          }
        }
      } catch {
        this.retire(record);
      }
      this.advance(record);
    }
  }

  forgetConnection(id: string): void {
    for (const record of this.records.values())
      if (record.authority.connection.id === id) this.retire(record);
  }
  forgetSession(id: string): void {
    for (const record of this.records.values())
      if (record.authority.session.sessionId === id) this.retire(record);
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const record of this.records.values()) this.retire(record);
  }
}
