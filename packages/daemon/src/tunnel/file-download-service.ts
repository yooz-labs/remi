/** Dormant ADR0045 core. No raw route, capability advertisement or production root discovery. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  FILE_DOWNLOAD_LIMITS,
  type FileDownloadBinding,
  type FileDownloadCorrelation,
  type FileDownloadMessage,
  type FileDownloadRefusalCode,
  type FileFetchBegin,
  type FileFetchCancel,
  type FileFetchComplete,
  type FileFetchRead,
  type UUID,
  decodeFileDownloadFrame,
  encodeFileDownloadFrame,
} from '@remi/shared';
import { WebSocketAdapter } from '../adapters/websocket-adapter';
import type { IdentityStore } from '../auth/identity-store';
import type { Connection } from '../server/connection';
import type { SessionBindingStore } from '../session/session-binding-store';
import type { ManagedSession, SessionRegistry } from '../session/session-registry';
import { DirectoryRoot, FileAdmission } from './admission';
import {
  DownloadPreparationError,
  type PreparedDownloadCopy,
  prepareDownloadCopy,
} from './download-preparation';
import { type ManagedTunnelStorage, openManagedTunnelStorage } from './managed-tunnel-storage';

export type FileDownloadRequest =
  | FileFetchBegin
  | FileFetchRead
  | FileFetchComplete
  | FileFetchCancel;
export type FileDownloadResponse = Exclude<FileDownloadMessage, FileDownloadRequest>;
/** Replace this incarnation and invalidate synchronously before runtime/protection transitions. */
export interface FileDownloadHostContext {
  readonly runtime: object;
  readonly protectedRootPaths: readonly string[];
}
export interface FileDownloadServiceHost {
  readonly home: string;
  readonly identityStore: IdentityStore;
  readonly sessions: SessionRegistry;
  readonly bindings: SessionBindingStore;
  readonly directAdapter: () => WebSocketAdapter | undefined;
  readonly contextFor: (sessionId: UUID) => FileDownloadHostContext | null;
}
interface Actor {
  readonly connection: Connection;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly epoch: string;
  readonly session: ManagedSession;
  readonly pty: ManagedSession['pty'];
  readonly attachment: object;
}
interface Authority extends Actor {
  readonly binding: FileDownloadBinding;
  readonly context: FileDownloadHostContext;
  readonly runtime: object;
  readonly protectedPaths: readonly string[];
  readonly workingDirectory: string;
}
interface DownloadRecord {
  readonly begin: FileFetchBegin;
  readonly authority: Authority;
  readonly totalUntil: number;
  readonly expiresAt: string;
  roots: DirectoryRoot[];
  rootsCloseAttempted: boolean;
  rootsClosed: boolean;
  terminal: boolean;
  reason: FileDownloadRefusalCode;
  intent: FileDownloadRequest | undefined;
  preparationDone: boolean;
  cleanupConfirmed: boolean;
  poisoned: boolean;
  prepared: PreparedDownloadCopy | undefined;
  transferId: string | undefined;
  idleUntil: number;
  sequence: number;
  sentBytes: number;
  reading: boolean;
  work: Promise<void>;
}
class DownloadFault extends Error {
  constructor(readonly code: FileDownloadRefusalCode) {
    super('File download unavailable');
  }
}
const fail = (code: FileDownloadRefusalCode): never => {
  throw new DownloadFault(code);
};
const totalLifetime = 300_000;
const idleLifetime = 30_000;
const recordLimit = 128;
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const envelope = (request: Pick<FileDownloadRequest, 'id' | 'sessionId'>) => ({
  id: randomUUID(),
  requestId: request.id,
  timestamp: new Date().toISOString(),
  sessionId: request.sessionId,
});
const sameActor = (a: Actor, b: Actor) =>
  a.connection === b.connection &&
  a.publicKey === b.publicKey &&
  a.fingerprint === b.fingerprint &&
  a.epoch === b.epoch &&
  a.session === b.session &&
  a.pty === b.pty &&
  a.attachment === b.attachment;

export class FileDownloadService {
  private readonly records = new Set<DownloadRecord>();
  private readonly connections = new Map<Connection, Map<UUID, Map<string, DownloadRecord>>>();
  private readonly sessions = new Map<UUID, Set<DownloadRecord>>();
  private readonly transfers = new Map<string, DownloadRecord>();
  private closed = false;
  private poisoned = false;
  private grantHeld = false;
  private maintenance: Promise<void> | undefined;
  private closing: Promise<boolean> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly host: FileDownloadServiceHost,
    private readonly storage: ManagedTunnelStorage,
  ) {
    this.timer = setInterval(() => void this.maintain(), 1000);
    this.timer.unref();
  }
  static async open(host: FileDownloadServiceHost): Promise<FileDownloadService> {
    const storage = await openManagedTunnelStorage(host.home);
    try {
      storage.recover();
      return new FileDownloadService(host, storage);
    } catch (error) {
      storage.close();
      throw error;
    }
  }
  private direct(id: UUID): Connection | null {
    const adapter = this.host.directAdapter();
    const connection = adapter instanceof WebSocketAdapter ? adapter.getDirectConnection(id) : null;
    return connection?.isConnected ? connection : null;
  }
  private grant<T>(key: string, effect: (epoch: string | null) => T, migrate = false): T {
    if (this.grantHeld) return fail('unavailable');
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
  /** Caller holds the one original-grant lock. No storage or another grant lock is acquired here. */
  private actor(connection: Connection, sessionId: UUID, epoch: string | null): Actor {
    const publicKey = connection.connectionClientPublicKey;
    const fingerprint = connection.connectionClientFingerprint;
    const session = this.host.sessions.getSessionForConnection(connection.id);
    const attachment = this.host.sessions.getAttachmentToken(connection.id);
    if (
      this.closed ||
      !epoch ||
      !publicKey ||
      !fingerprint ||
      connection.connectionListenerTransport !== 'public-tls' ||
      connection.structuredChatProxyAuthority ||
      this.direct(connection.id) !== connection ||
      !session ||
      session.sessionId !== sessionId ||
      !session.pty.isRunning ||
      !attachment
    )
      return fail('unavailable');
    return { connection, publicKey, fingerprint, epoch, session, pty: session.pty, attachment };
  }
  private authority(actor: Actor): Authority {
    const binding = this.host.bindings.getIdentity(actor.session.sessionId);
    const context = this.host.contextFor(actor.session.sessionId);
    if (
      !binding?.harnessSessionId ||
      (binding.harness !== 'claude' && binding.harness !== 'codex') ||
      !context ||
      !context.runtime ||
      typeof context.runtime !== 'object' ||
      !Array.isArray(context.protectedRootPaths) ||
      context.protectedRootPaths.length === 0 ||
      !context.protectedRootPaths.every((value) => typeof value === 'string' && value.length > 0)
    )
      return fail('unavailable');
    return {
      ...actor,
      binding: Object.freeze({
        harness: binding.harness,
        harnessSessionId: binding.harnessSessionId,
      }),
      context,
      runtime: context.runtime,
      protectedPaths: Object.freeze([...context.protectedRootPaths]),
      workingDirectory: actor.session.workingDirectory,
    };
  }
  private capture(id: UUID, sessionId: UUID): Authority {
    if (this.closed || this.poisoned) return fail('unavailable');
    const connection = this.direct(id);
    const key = connection?.connectionClientPublicKey;
    if (!connection || !key) return fail('unavailable');
    // Explicit legacy epoch migration applies only to an already-authorized exact signed key.
    return this.grant(
      key,
      (epoch) => this.authority(this.actor(connection, sessionId, epoch)),
      true,
    );
  }
  private current<T>(authority: Authority, effect: () => T, full = true): T {
    return this.grant(authority.publicKey, (epoch) => {
      const actor = this.actor(authority.connection, authority.session.sessionId, epoch);
      if (!sameActor(authority, actor)) return fail('unavailable');
      if (full) {
        const current = this.authority(actor);
        if (
          current.binding.harness !== authority.binding.harness ||
          current.binding.harnessSessionId !== authority.binding.harnessSessionId ||
          current.context !== authority.context ||
          current.runtime !== authority.runtime ||
          current.workingDirectory !== authority.workingDirectory ||
          current.protectedPaths.length !== authority.protectedPaths.length ||
          current.protectedPaths.some((value, i) => value !== authority.protectedPaths[i])
        )
          return fail('binding_changed');
      }
      return effect();
    });
  }
  private owner<T>(record: DownloadRecord, effect: () => T, terminalResponse = false): T {
    return this.current(record.authority, () => {
      if (record.terminal && !terminalResponse) return fail(record.reason);
      if (
        performance.now() >= record.totalUntil ||
        (record.transferId !== undefined && performance.now() >= record.idleUntil)
      )
        return fail('expired');
      if (record.roots.some((root) => !root.isCurrent())) return fail('binding_changed');
      return effect();
    });
  }
  private captureRoots(authority: Authority): DirectoryRoot[] {
    const roots: DirectoryRoot[] = [];
    try {
      for (const pathname of [
        authority.workingDirectory,
        ...new Set([this.host.home, ...authority.protectedPaths]),
      ]) {
        const root = DirectoryRoot.capture(
          pathname,
          this.storage.ops.openAt.bind(this.storage.ops),
        );
        if (!root) return fail('unavailable');
        roots.push(root);
      }
      return roots;
    } catch (error) {
      if (!(error instanceof DownloadFault)) this.poisoned = true;
      for (const root of roots.reverse()) {
        try {
          root.close();
        } catch {
          this.poisoned = true; // Uncertain directory handles keep this native bundle owned.
        }
      }
      throw error;
    }
  }
  isAvailable(connectionId: UUID): boolean {
    let roots: DirectoryRoot[] = [];
    let available = false;
    try {
      const authority = this.capture(
        connectionId,
        this.host.sessions.getSessionForConnection(connectionId)?.sessionId ?? '',
      );
      roots = this.current(authority, () => this.captureRoots(authority));
      available = true;
    } catch {
      available = false;
    } finally {
      for (const root of roots.reverse()) {
        try {
          root.close();
        } catch {
          this.poisoned = true;
        }
      }
    }
    return available && !this.poisoned;
  }
  private beginMap(connection: Connection, session: UUID): Map<string, DownloadRecord> | undefined {
    return this.connections.get(connection)?.get(session);
  }
  private terminal(
    record: DownloadRecord,
    reason: FileDownloadRefusalCode,
    intent?: FileDownloadRequest,
  ) {
    if (record.terminal) return;
    record.terminal = true;
    record.reason = reason;
    record.intent = intent;
    const begins = this.beginMap(record.authority.connection, record.begin.sessionId);
    if (begins?.get(record.begin.id) === record) begins.delete(record.begin.id);
    if (record.transferId && this.transfers.get(record.transferId) === record)
      this.transfers.delete(record.transferId);
  }
  /** Settlement is independent of current client authority; no grant lease may wrap it. */
  private cleanup(record: DownloadRecord): boolean {
    if (!record.preparationDone || record.poisoned) return false;
    try {
      if (!record.cleanupConfirmed) {
        record.prepared?.retire();
        record.cleanupConfirmed = true;
      }
    } catch {
      return false; // Existing safe retire closure can retry settlement, never numeric close.
    }
    if (record.intent || record.reading) return true; // Join the in-flight read and terminal response before closing roots.
    if (!record.rootsClosed) {
      if (record.rootsCloseAttempted) return false;
      record.rootsCloseAttempted = true;
      for (const root of [...record.roots].reverse()) {
        try {
          root.close();
        } catch {
          record.poisoned = true;
          this.poisoned = true;
        }
      }
      if (record.poisoned) return false;
      record.rootsClosed = true;
    }
    this.records.delete(record);
    const bySession = this.connections.get(record.authority.connection);
    if (bySession?.get(record.begin.sessionId)?.size === 0)
      bySession.delete(record.begin.sessionId);
    if (bySession?.size === 0) this.connections.delete(record.authority.connection);
    const session = this.sessions.get(record.begin.sessionId);
    session?.delete(record);
    if (session?.size === 0) this.sessions.delete(record.begin.sessionId);
    return true;
  }
  private refusal(
    id: UUID,
    request: Pick<FileDownloadRequest, 'id' | 'sessionId' | 'type'>,
    code: FileDownloadRefusalCode,
    authority?: Authority,
  ) {
    try {
      const send = (actor: Actor) =>
        actor.connection.sendFileDownloadFrame({
          ...envelope(request),
          type: 'file_fetch_refused',
          operation: request.type,
          code,
        });
      if (authority) this.current(authority, () => send(authority), false);
      else {
        const connection = this.direct(id);
        const key = connection?.connectionClientPublicKey;
        if (!connection || !key) return;
        this.grant(key, (epoch) => send(this.actor(connection, request.sessionId, epoch)));
      }
    } catch {
      // No proven original owner means no response; never log client/file/error payloads.
    }
  }
  private finish(
    record: DownloadRecord,
    request: FileDownloadRequest,
    success?: FileDownloadResponse,
  ) {
    const clean = this.cleanup(record);
    try {
      if (success && clean)
        this.owner(record, () => record.authority.connection.sendFileDownloadFrame(success), true);
      else
        this.refusal(
          record.authority.connection.id,
          request,
          clean ? record.reason : 'cleanup_failed',
          record.authority,
        );
    } catch (error) {
      this.refusal(
        record.authority.connection.id,
        request,
        error instanceof DownloadFault ? error.code : 'unavailable',
        record.authority,
      );
    } finally {
      record.intent = undefined;
      this.cleanup(record);
    }
  }
  private async prepare(record: DownloadRecord): Promise<void> {
    try {
      const source = this.owner(record, () => {
        record.roots = this.captureRoots(record.authority);
        const root = record.roots[0];
        if (!root) return fail('unavailable');
        const admission = new FileAdmission(
          this.storage.ops.openAt.bind(this.storage.ops),
          record.roots.slice(1),
        );
        const source = admission.open(root, record.begin.relativePath.split('/'));
        if (!source) return fail('unavailable');
        return source;
      });
      record.prepared = await prepareDownloadCopy(
        source,
        this.storage.store,
        {
          device: createHash('sha256')
            .update(Buffer.from(record.authority.publicKey, 'base64'))
            .digest('hex'),
          session: record.begin.sessionId,
          hub: this.storage.hub,
        },
        this.storage.scratch,
        this.storage.metadata,
        this.storage.ops,
        {
          effect: (effect) => {
            try {
              return this.owner(record, effect);
            } catch (error) {
              if (error instanceof DownloadFault) this.terminal(record, error.code, record.begin);
              throw error;
            }
          },
          yield: yieldLoop,
        },
      );
      record.preparationDone = true;
      if (record.terminal) {
        this.cleanup(record);
        return;
      }
      const sent = this.owner(record, () => {
        let transferId: string;
        do {
          transferId = randomBytes(16).toString('base64url');
        } while ([...this.records].some((value) => value.transferId === transferId));
        record.transferId = transferId;
        record.idleUntil = performance.now() + idleLifetime;
        this.transfers.set(transferId, record);
        const prepared = record.prepared;
        if (!prepared) return fail('unavailable');
        return record.authority.connection.sendFileDownloadFrame({
          ...envelope(record.begin),
          type: 'file_fetch_accepted',
          transferId,
          fileName: record.begin.relativePath.split('/').at(-1) as string,
          byteLength: prepared.byteLength,
          mediaType: 'application/octet-stream',
          digest: prepared.digest,
          expiresAt: record.expiresAt,
        });
      });
      if (!sent) {
        this.terminal(record, 'unavailable');
        this.cleanup(record);
      }
    } catch (error) {
      record.preparationDone = true;
      if (error instanceof DownloadPreparationError && !error.cleanupConfirmed) {
        record.poisoned = true;
        this.poisoned = true;
      }
      const code =
        error instanceof DownloadFault
          ? error.code
          : error instanceof DownloadPreparationError && error.code !== 'unavailable'
            ? error.code
            : record.reason;
      if (!record.terminal) this.terminal(record, code, record.begin);
      if (record.intent === record.begin) this.finish(record, record.begin);
      else this.cleanup(record);
    }
  }
  private async read(record: DownloadRecord, request: FileFetchRead) {
    let attempted = false;
    try {
      this.owner(record, () => {
        if (
          record.reading ||
          request.seq !== record.sequence ||
          request.receivedBytes !== record.sentBytes
        )
          return fail('sequence');
        record.reading = true;
      });
      const prepared = record.prepared;
      if (!prepared || record.sentBytes >= prepared.byteLength) return fail('sequence');
      // read already owns context.effect: never nest another grant lock around it.
      const bytes = prepared.read(
        record.sentBytes,
        Math.min(FILE_DOWNLOAD_LIMITS.chunkBytes, prepared.byteLength - record.sentBytes),
      );
      await yieldLoop();
      this.owner(record, () => {
        const seq = record.sequence;
        record.sequence++;
        record.sentBytes += bytes.length;
        record.idleUntil = performance.now() + idleLifetime;
        attempted = true;
        const sent = record.authority.connection.sendFileDownloadFrame({
          ...envelope(request),
          type: 'file_fetch_chunk',
          transferId: request.transferId,
          seq,
          data: bytes.toString('base64url'),
        });
        if (!sent) return fail('unavailable');
      });
    } catch (error) {
      if (!record.terminal)
        this.terminal(
          record,
          error instanceof DownloadFault ? error.code : 'unavailable',
          attempted ? undefined : request,
        );
      if (record.intent === request) this.finish(record, request);
      else this.cleanup(record);
    } finally {
      record.reading = false;
      if (record.terminal) this.cleanup(record);
    }
  }
  /** Hints locate an existing owner only; malformed input never allocates or advances work. */
  refuseMalformed(connectionId: UUID, correlation: FileDownloadCorrelation): void {
    if (this.closed || this.poisoned) return;
    const request = {
      type: correlation.operation,
      id: correlation.requestId,
      sessionId: correlation.sessionId,
    };
    try {
      const connection = this.direct(connectionId);
      if (!connection) return;
      const known =
        correlation.operation === 'file_fetch_begin'
          ? this.beginMap(connection, correlation.sessionId)?.get(correlation.requestId)
          : correlation.operation === 'file_fetch_cancel'
            ? correlation.beginId
              ? this.beginMap(connection, correlation.sessionId)?.get(correlation.beginId)
              : undefined
            : correlation.transferId
              ? this.transfers.get(correlation.transferId)
              : undefined;
      if (
        known &&
        !known.terminal &&
        known.authority.connection === connection &&
        known.begin.sessionId === correlation.sessionId
      ) {
        this.owner(known, () =>
          connection.sendFileDownloadFrame({
            ...envelope(request),
            type: 'file_fetch_refused',
            operation: correlation.operation,
            code: 'malformed',
          }),
        );
        return;
      }
    } catch {
      // Lost original authority cannot expose a more specific operation result.
    }
    this.refusal(connectionId, request, 'unavailable');
  }

  handle(connectionId: UUID, input: FileDownloadRequest): Promise<void> {
    let request: FileDownloadRequest;
    try {
      const value = decodeFileDownloadFrame(encodeFileDownloadFrame(input));
      if (
        !value ||
        ![
          'file_fetch_begin',
          'file_fetch_read',
          'file_fetch_complete',
          'file_fetch_cancel',
        ].includes(value.type)
      )
        return Promise.resolve();
      request = Object.freeze(value) as FileDownloadRequest;
    } catch {
      return Promise.resolve();
    }
    try {
      const connection = this.direct(connectionId);
      if (!connection) return Promise.resolve();
      if (request.type === 'file_fetch_begin') {
        const authority = this.capture(connectionId, request.sessionId);
        if (
          request.binding.harness !== authority.binding.harness ||
          request.binding.harnessSessionId !== authority.binding.harnessSessionId
        )
          return fail('binding_changed');
        if (this.beginMap(connection, request.sessionId)?.has(request.id)) return fail('conflict');
        if (this.records.size >= recordLimit) return fail('busy');
        const record: DownloadRecord = {
          begin: request,
          authority,
          totalUntil: performance.now() + totalLifetime,
          expiresAt: new Date(Date.now() + totalLifetime).toISOString(),
          roots: [],
          rootsCloseAttempted: false,
          rootsClosed: false,
          terminal: false,
          reason: 'unavailable',
          intent: undefined,
          preparationDone: false,
          cleanupConfirmed: false,
          poisoned: false,
          prepared: undefined,
          transferId: undefined,
          idleUntil: Number.POSITIVE_INFINITY,
          sequence: 0,
          sentBytes: 0,
          reading: false,
          work: Promise.resolve(),
        };
        this.records.add(record); // Before prepare's first yield; no unbounded async admission queue.
        let bySession = this.connections.get(connection);
        if (!bySession) {
          bySession = new Map();
          this.connections.set(connection, bySession);
        }
        let begins = bySession.get(request.sessionId);
        if (!begins) {
          begins = new Map();
          bySession.set(request.sessionId, begins);
        }
        begins.set(request.id, record);
        let session = this.sessions.get(request.sessionId);
        if (!session) {
          session = new Set();
          this.sessions.set(request.sessionId, session);
        }
        session.add(record);
        record.work = this.prepare(record);
        return record.work;
      }
      const record =
        request.type === 'file_fetch_cancel'
          ? this.beginMap(connection, request.sessionId)?.get(request.beginId)
          : this.transfers.get(request.transferId);
      if (
        !record ||
        record.authority.connection !== connection ||
        record.begin.sessionId !== request.sessionId
      )
        return fail('unavailable');
      if (request.type === 'file_fetch_read') {
        if (record.reading) {
          let reason: FileDownloadRefusalCode = 'sequence';
          try {
            this.owner(record, () => undefined);
          } catch (error) {
            reason = error instanceof DownloadFault ? error.code : 'unavailable';
          }
          this.terminal(record, reason, request);
          return record.work.then(() => this.finish(record, request));
        }
        record.work = this.read(record, request);
        return record.work;
      }
      if (request.type === 'file_fetch_cancel') {
        try {
          this.owner(record, () => this.terminal(record, 'unavailable', request));
        } catch (error) {
          this.terminal(
            record,
            error instanceof DownloadFault ? error.code : 'unavailable',
            request,
          );
          return record.work.then(() => this.finish(record, request));
        }
        const cancel = request;
        return record.work.then(() =>
          this.finish(record, cancel, {
            ...envelope(cancel),
            type: 'file_fetch_cancel_result',
            beginId: cancel.beginId,
            outcome: 'cancelled',
          }),
        );
      }
      try {
        this.owner(record, () => {
          if (
            record.reading ||
            !record.prepared ||
            record.sentBytes !== record.prepared.byteLength ||
            request.receivedBytes !== record.prepared.byteLength ||
            request.digest !== record.prepared.digest
          )
            return fail('integrity');
          this.terminal(record, 'unavailable', request);
        });
        this.finish(record, request, {
          ...envelope(request),
          type: 'file_fetch_result',
          transferId: request.transferId,
          outcome: 'complete',
        });
      } catch (error) {
        this.terminal(record, error instanceof DownloadFault ? error.code : 'unavailable', request);
        this.finish(record, request);
      }
    } catch (error) {
      this.refusal(
        connectionId,
        request,
        error instanceof DownloadFault ? error.code : 'unavailable',
      );
    }
    return Promise.resolve();
  }
  private async invalidate(records: DownloadRecord[]) {
    for (const record of records) this.terminal(record, 'unavailable');
    await Promise.all(records.map((record) => record.work));
    for (const record of records) this.cleanup(record);
  }
  invalidateConnection(id: UUID): Promise<void> {
    return this.invalidate(
      [...this.records].filter((record) => record.authority.connection.id === id),
    );
  }
  invalidateSession(id: UUID): Promise<void> {
    return this.invalidate([...(this.sessions.get(id) ?? [])]);
  }
  maintain(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    this.maintenance = (async () => {
      for (const record of [...this.records]) {
        if (!record.terminal) {
          try {
            this.owner(record, () => undefined);
          } catch (error) {
            this.terminal(record, error instanceof DownloadFault ? error.code : 'unavailable');
          }
        }
        if (record.terminal) this.cleanup(record);
      }
    })().finally(() => {
      this.maintenance = undefined;
    });
    return this.maintenance;
  }
  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const record of this.records) {
      this.terminal(record, 'unavailable');
      record.intent = undefined;
    }
    this.closing = (async () => {
      await Promise.all([...this.records].map((record) => record.work));
      for (const record of [...this.records]) this.cleanup(record);
      if (this.records.size || this.poisoned) return false;
      try {
        this.storage.close();
        return true;
      } catch {
        this.poisoned = true;
        return false;
      }
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
