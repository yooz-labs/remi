// #1170 authenticated direct image staging and internal insertion lease preparation.
// Staging writes no harness input; insertion reuses its original owner and retained artifact.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ImageInsertionCorrelation,
  type ImageInsertionRefusalCode,
  type ImageStagingBinding,
  type ImageStagingCorrelation,
  type ImageStagingMessage,
  type ImageStagingRefusalCode,
  type ImageUploadBegin,
  type ImageUploadCancel,
  type ImageUploadChunk,
  type ImageUploadComplete,
  type UUID,
  decodeImageStagingFrame,
  encodeImageStagingFrame,
  relayV2,
} from '@remi/shared';
import { WebSocketAdapter } from '../adapters/websocket-adapter';
import type { IdentityStore } from '../auth/identity-store';
import type { Connection } from '../server/connection';
import type { SessionBindingStore } from '../session/session-binding-store';
import type { ManagedSession, SessionRegistry } from '../session/session-registry';
import type { DirectoryRoot } from './admission';
import { admitImage } from './image-admission';
import { ImageInsertionError, type ImageInsertionLease } from './image-insertion-lease';
import { type ImageDecoder, createImageDecoder } from './image-worker-command';
import type { JournalLease } from './journal-schema';
import {
  type JournalRead,
  type JournalWriter,
  beginJournal,
  settleJournal,
} from './journal-settlement';
import { type ManagedTunnelStorage, openManagedTunnelStorage } from './managed-tunnel-storage';
import type { Reservations } from './reservations';

export type ImageStagingRequest =
  | ImageUploadBegin
  | ImageUploadChunk
  | ImageUploadComplete
  | ImageUploadCancel;
export type ImageStagingResponse = Exclude<ImageStagingMessage, ImageStagingRequest>;
type Delivery = (response: ImageStagingResponse) => void;

export interface ImageStagingServiceHost {
  readonly home: string;
  readonly identityStore: IdentityStore;
  readonly sessionRegistry: SessionRegistry;
  readonly bindingStore: SessionBindingStore;
  readonly directAdapter: () => WebSocketAdapter | undefined;
}

class StagingFault extends Error {
  constructor(readonly code: ImageStagingRefusalCode) {
    super('Image staging refused');
  }
}
type Authority = {
  connection: Connection;
  session: ManagedSession;
  pty: ManagedSession['pty'];
  publicKey: string;
  fingerprint: string;
  storageOwner: string;
  epoch: string;
  binding: ImageStagingBinding;
  attachment: object;
};
type Transfer = {
  begin: ImageUploadBegin;
  authority: Authority;
  transferId: string;
  lease: JournalLease;
  writer: JournalWriter;
  reader: JournalRead | undefined;
  writerClosed: boolean;
  retired: boolean;
  insertionRetired?: boolean;
  state: 'receiving' | 'checking' | 'staged' | 'cancelled' | 'expired' | 'cleanup_failed';
  received: number;
  sequence: number;
  expiresAt: string;
  totalUntil: number;
  idleUntil: number;
  idleWallUntil: number;
  artifact: { id: string; expiresAt: string; until: number } | undefined;
  abort: AbortController;
  work: Promise<void> | undefined;
};

const partialLifetime = 5 * 60 * 1000;
const idleLifetime = 30 * 1000;
const stagedLifetime = 24 * 60 * 60 * 1000;
const fault = (code: ImageStagingRefusalCode): never => {
  throw new StagingFault(code);
};
const envelope = (request: ImageStagingRequest) => ({
  id: randomUUID(),
  requestId: request.id,
  timestamp: new Date().toISOString(),
  sessionId: request.sessionId,
});

export class ImageStagingService {
  private readonly transfers = new Map<string, Transfer>();
  private readonly begins = new Map<string, Transfer>();
  private readonly debt = new Set<Transfer>();
  private readonly completions = new Set<Promise<void>>();
  private readonly hub: string;
  private readonly decoder: ImageDecoder;
  private decodeTail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private closing: Promise<boolean> | undefined;
  private maintenance: Promise<void> | undefined;

  private readonly store: Reservations;
  private readonly scratch: DirectoryRoot;
  private readonly metadata: DirectoryRoot;

  private constructor(
    private readonly host: ImageStagingServiceHost,
    private readonly storage: ManagedTunnelStorage,
    private readonly workerCwd: string,
  ) {
    this.store = storage.store;
    this.scratch = storage.scratch;
    this.metadata = storage.metadata;
    this.hub = storage.hub;
    this.decoder = createImageDecoder(workerCwd);
  }

  static async open(host: ImageStagingServiceHost): Promise<ImageStagingService> {
    const storage = await openManagedTunnelStorage(host.home);
    let worker: string | undefined;
    try {
      worker = fs.mkdtempSync(path.join(storage.base, 'worker-'));
      fs.chmodSync(worker, 0o700);
      const service = new ImageStagingService(host, storage, worker);
      storage.recover();
      service.timer = setInterval(() => {
        void service.maintain().catch(() => {});
      }, 1000);
      return service;
    } catch (error) {
      storage.close();
      if (worker) fs.rmdirSync(worker);
      throw error;
    }
  }

  private direct(id: UUID): Connection {
    const adapter = this.host.directAdapter();
    const connection =
      adapter instanceof WebSocketAdapter ? adapter.getDirectConnection(id) : undefined;
    if (
      !connection?.isConnected ||
      !connection.connectionClientPublicKey ||
      !connection.connectionClientFingerprint
    )
      return fault('unavailable');
    return connection;
  }

  private currentAuthority(id: UUID, sessionId: string): Authority {
    const connection = this.direct(id);
    const publicKey = connection.connectionClientPublicKey;
    const fingerprint = connection.connectionClientFingerprint;
    if (!publicKey || !fingerprint) return fault('unavailable');
    return this.host.identityStore.withAuthorizationEpochNonblocking(
      publicKey,
      (epoch) => {
        if (!epoch) return fault('unavailable');
        const session = this.host.sessionRegistry.getSessionForConnection(id);
        const binding = this.host.bindingStore.getIdentity(sessionId as UUID);
        const attachment = this.host.sessionRegistry.getAttachmentToken(id);
        if (
          !session ||
          !attachment ||
          session.sessionId !== sessionId ||
          !session.pty.isRunning ||
          binding?.harness !== 'claude' ||
          !binding.harnessSessionId
        )
          return fault('unavailable');
        return {
          connection,
          session,
          pty: session.pty,
          publicKey,
          fingerprint,
          storageOwner: createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex'),
          epoch,
          binding: { harness: 'claude', harnessSessionId: binding.harnessSessionId },
          attachment,
        };
      },
      true,
    );
  }

  private capture(id: UUID, request: ImageUploadBegin): Authority {
    const authority = this.currentAuthority(id, request.sessionId);
    if (authority.binding.harnessSessionId !== request.binding.harnessSessionId)
      return fault('unavailable');
    return authority;
  }

  /** Per-connection readiness; capability-only, relay and unbound peers never qualify. */
  isAvailable(id: UUID): boolean {
    try {
      if (this.closed) return false;
      const session = this.host.sessionRegistry.getSessionForConnection(id);
      if (!session) return false;
      const authority = this.currentAuthority(id, session.sessionId);
      return this.owner({ authority }, () => true);
    } catch {
      return false;
    }
  }

  /** Bounded correlation hints may locate authority, but never create transfer authority. */
  refuseMalformed(id: UUID, correlation: ImageStagingCorrelation, deliver: Delivery): void {
    let code: ImageStagingRefusalCode = 'unavailable';
    const response = () =>
      deliver({
        type: 'image_upload_refused',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        requestId: correlation.requestId,
        sessionId: correlation.sessionId,
        operation: correlation.operation,
        code,
      });
    try {
      if (this.closed) {
        response();
        return;
      }
      const known =
        correlation.operation === 'image_upload_begin'
          ? this.begins.get(correlation.requestId)
          : correlation.transferId
            ? this.transfers.get(correlation.transferId)
            : undefined;
      if (known) {
        if (
          known.retired ||
          this.expired(known) ||
          known.begin.sessionId !== correlation.sessionId ||
          this.direct(id) !== known.authority.connection
        ) {
          response();
          return;
        }
        this.owner(
          known,
          () => {
            const binding = this.host.bindingStore.getIdentity(correlation.sessionId);
            code = !binding?.harnessSessionId
              ? 'unavailable'
              : binding.harness !== 'claude' ||
                  binding.harnessSessionId !== known.authority.binding.harnessSessionId
                ? 'binding_changed'
                : 'malformed';
            response();
          },
          false,
        );
      } else if (correlation.operation === 'image_upload_begin') {
        const authority = this.currentAuthority(id, correlation.sessionId);
        this.owner({ authority }, () => {
          code = 'malformed';
          response();
        });
      } else response();
    } catch {
      code = 'unavailable';
      response();
    }
  }

  private owner<T>(record: Pick<Transfer, 'authority'>, operation: () => T, binding = true): T {
    const captured = record.authority;
    return this.host.identityStore.withAuthorizationEpochNonblocking(
      captured.publicKey,
      (epoch) => {
        const current = this.direct(captured.connection.id);
        const session = this.host.sessionRegistry.getSessionForConnection(current.id);
        if (
          epoch !== captured.epoch ||
          current !== captured.connection ||
          current.connectionClientPublicKey !== captured.publicKey ||
          current.connectionClientFingerprint !== captured.fingerprint ||
          session !== captured.session ||
          session.pty !== captured.pty ||
          this.host.sessionRegistry.getAttachmentToken(current.id) !== captured.attachment ||
          !captured.pty.isRunning
        )
          return fault('unavailable');
        if (binding) {
          const currentBinding = this.host.bindingStore.getIdentity(session.sessionId);
          if (!currentBinding?.harnessSessionId) return fault('unavailable');
          if (
            currentBinding.harness !== 'claude' ||
            currentBinding.harnessSessionId !== captured.binding.harnessSessionId
          )
            return fault('binding_changed');
        }
        return operation();
      },
    );
  }

  /** A malformed envelope can locate its existing owner only; it never acquires an effect lease. */
  insertionMalformedCode(
    id: UUID,
    correlation: ImageInsertionCorrelation,
  ): ImageInsertionRefusalCode {
    try {
      const record = [...this.transfers.values()].find(
        (item) => item.artifact?.id === correlation.artifactId,
      );
      if (
        this.closed ||
        !record ||
        record.retired ||
        record.state !== 'staged' ||
        this.expired(record) ||
        record.begin.sessionId !== correlation.sessionId ||
        this.direct(id) !== record.authority.connection
      )
        return 'unavailable';
      return this.owner(
        record,
        () => {
          const current = this.host.bindingStore.getIdentity(correlation.sessionId);
          if (!current?.harnessSessionId) return 'unavailable';
          return current.harness === 'claude' &&
            current.harnessSessionId === record.authority.binding.harnessSessionId
            ? 'malformed'
            : 'binding_changed';
        },
        false,
      );
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'busy'
        ? 'busy'
        : 'unavailable';
    }
  }

  /** Internal host lease only. Preparing never writes input or changes the original storage lifetime. */
  prepareInsertion(
    id: UUID,
    sessionId: UUID,
    binding: ImageStagingBinding,
    artifactId: string,
  ): ImageInsertionLease {
    const record = [...this.transfers.values()].find((item) => item.artifact?.id === artifactId);
    const requested = { ...binding };
    let possibleWrite = false;
    const refuse = (code: ImageInsertionError['code']): never => {
      throw new ImageInsertionError(code);
    };
    const current = <T>(operation: (reader: JournalRead) => T, allowRetired = false): T => {
      try {
        if (
          this.closed ||
          !record ||
          record.begin.sessionId !== sessionId ||
          this.direct(id) !== record.authority.connection
        )
          return refuse('unavailable');
        return this.owner(record, () => {
          if (record.retired || record.state !== 'staged' || !record.reader || !record.artifact)
            return refuse('unavailable');
          if (this.expired(record)) return refuse('expired');
          if (
            requested.harness !== 'claude' ||
            requested.harnessSessionId !== record.authority.binding.harnessSessionId
          )
            return refuse('binding_changed');
          if (record.insertionRetired && !allowRetired) return refuse('conflict');
          return operation(record.reader);
        });
      } catch (error) {
        if (error instanceof ImageInsertionError) throw error;
        if (error instanceof StagingFault && error.code === 'binding_changed')
          return refuse('binding_changed');
        if (error instanceof Error && 'code' in error && error.code === 'busy')
          return refuse('busy');
        return refuse('unavailable');
      }
    };
    const reference = (reader: JournalRead) => {
      const filename = reader.referencePath();
      const extension = record?.begin.mediaType === 'image/png' ? '.png' : '.jpg';
      if (!filename.endsWith(extension) || /["\\\u0000-\u001f\u007f-\u009f]/u.test(filename))
        return refuse('unavailable');
      return filename;
    };
    // Capture only after current authority and the held/named file pass. No new reader, copy or alias.
    return current((reader) => {
      reference(reader);
      const captured = record;
      if (!captured?.artifact) return refuse('unavailable');
      return {
        pty: captured.authority.pty,
        expiresAt: captured.artifact.expiresAt,
        get possibleWrite() {
          return possibleWrite;
        },
        assertCurrent() {
          current(reference, true);
        },
        referencePath() {
          return current(reference);
        },
        retire(expectedReference, promptUp) {
          current((reader) => {
            if (promptUp()) return refuse('prompt_up');
            if (reference(reader) !== expectedReference) return refuse('unavailable');
            // Retire BEFORE a sink may write. An uncertain/failed sink never restores authority.
            captured.insertionRetired = true;
            possibleWrite = true;
          });
        },
      };
    });
  }

  private partialLifetimeEnded(record: Transfer): boolean {
    return performance.now() >= record.totalUntil || Date.now() >= Date.parse(record.expiresAt);
  }
  private expired(record: Transfer): boolean {
    const now = performance.now();
    return record.state === 'staged'
      ? !record.artifact ||
          now >= record.artifact.until ||
          Date.now() >= Date.parse(record.artifact.expiresAt)
      : this.partialLifetimeEnded(record) ||
          now >= record.idleUntil ||
          Date.now() >= record.idleWallUntil;
  }
  private act<T>(record: Transfer, operation: () => T): T {
    return this.owner(record, () => {
      if (record.retired) return fault('unavailable');
      if (this.expired(record)) return fault(record.state === 'staged' ? 'unavailable' : 'expired');
      return operation();
    });
  }
  private publish(record: Transfer, response: ImageStagingResponse, deliver: Delivery): void {
    this.act(record, () => deliver(response));
  }
  private token(): string {
    let value: string;
    do {
      value = randomBytes(16).toString('base64url');
    } while (
      this.transfers.has(value) ||
      [...this.transfers.values()].some((record) => record.artifact?.id === value)
    );
    return value;
  }
  private acceptance(record: Transfer, request: ImageUploadBegin): ImageStagingResponse {
    return {
      ...envelope(request),
      type: 'image_upload_accepted',
      transferId: record.transferId,
      expiresAt: record.expiresAt,
    };
  }
  private result(record: Transfer, request: ImageUploadComplete): ImageStagingResponse {
    if (!record.artifact) return fault('unavailable');
    return {
      ...envelope(request),
      type: 'image_upload_result',
      transferId: record.transferId,
      outcome: 'staged',
      artifactId: record.artifact.id,
      artifactExpiresAt: record.artifact.expiresAt,
      byteLength: record.begin.byteLength,
      mediaType: record.begin.mediaType,
      digest: record.begin.digest,
    };
  }

  /** Delivery runs at the current-authority decision; integration must perform its synchronous send here. */
  async handle(id: UUID, request: ImageStagingRequest, deliver: Delivery): Promise<void> {
    const valid = decodeImageStagingFrame(encodeImageStagingFrame(request));
    if (
      !valid ||
      ![
        'image_upload_begin',
        'image_upload_chunk',
        'image_upload_complete',
        'image_upload_cancel',
      ].includes(valid.type)
    )
      throw new Error('Invalid image staging request');
    let record: Transfer | undefined;
    try {
      if (this.closed) return fault('unavailable');
      if (request.type === 'image_upload_begin') {
        const previous = this.begins.get(request.id);
        if (previous) {
          if (this.direct(id) !== previous.authority.connection) return fault('unavailable');
          this.owner(previous, () => {}, false);
          record = previous;
          this.owner(record, () => {
            if (record?.state !== 'receiving')
              return fault(record?.state === 'staged' ? 'conflict' : 'unavailable');
            const old = record.begin;
            if (
              old.sessionId !== request.sessionId ||
              old.timestamp !== request.timestamp ||
              old.binding.harnessSessionId !== request.binding.harnessSessionId ||
              old.mediaType !== request.mediaType ||
              old.byteLength !== request.byteLength ||
              old.digest !== request.digest
            )
              return fault('conflict');
          });
          this.publish(record, this.acceptance(record, request), deliver);
          return;
        }
        const authority = this.capture(id, request);
        if (this.transfers.size >= 128) return fault('busy');
        const writer = this.owner({ authority }, () => {
          return beginJournal(
            this.store,
            { device: authority.storageOwner, session: request.sessionId, hub: this.hub },
            request.byteLength,
            this.scratch,
            this.metadata,
            this.storage.ops,
            request.mediaType === 'image/png' ? 'png' : 'jpg',
          );
        });
        const now = performance.now();
        record = {
          begin: { ...request, binding: { ...request.binding } },
          authority,
          transferId: this.token(),
          lease: writer.lease,
          writer,
          reader: undefined,
          writerClosed: false,
          retired: false,
          state: 'receiving',
          received: 0,
          sequence: 0,
          expiresAt: new Date(Date.now() + partialLifetime).toISOString(),
          totalUntil: now + partialLifetime,
          idleUntil: now + idleLifetime,
          idleWallUntil: Date.now() + idleLifetime,
          artifact: undefined,
          abort: new AbortController(),
          work: undefined,
        };
        this.transfers.set(record.transferId, record);
        this.begins.set(request.id, record);
        this.publish(record, this.acceptance(record, request), deliver);
        return;
      }
      const existing = this.transfers.get(request.transferId);
      if (
        !existing ||
        existing.begin.sessionId !== request.sessionId ||
        this.direct(id) !== existing.authority.connection
      )
        return fault('unavailable');
      this.owner(existing, () => {}, false);
      record = existing;
      const current = existing;
      this.owner(current, () => {});
      if (request.id === current.begin.id) return fault('conflict');
      if (request.type === 'image_upload_cancel') {
        if (this.partialLifetimeEnded(current) && current.state !== 'staged')
          return fault('unavailable');
        if (current.state === 'staged') return fault('conflict');
        if (current.state !== 'cancelled') await this.retire(current, 'cancelled');
        this.owner(current, () =>
          this.store.withRetainedJournalReceipt(current.lease, () =>
            deliver({
              ...envelope(request),
              type: 'image_upload_cancel_result',
              transferId: request.transferId,
              outcome: 'cancelled',
            }),
          ),
        );
        return;
      }
      if (request.type === 'image_upload_chunk') {
        if (current.state === 'staged') return fault('conflict');
        if (current.state !== 'receiving') return fault('unavailable');
        const bytes = Buffer.from(relayV2.fromB64u(request.data));
        if (
          request.seq !== current.sequence ||
          bytes.length !== Math.min(32768, current.begin.byteLength - current.received)
        )
          return fault('sequence');
        this.act(current, () => {
          current.writer.write(bytes);
          current.received += bytes.length;
          current.sequence++;
          current.idleUntil = performance.now() + idleLifetime;
          current.idleWallUntil = Date.now() + idleLifetime;
        });
        this.publish(
          current,
          {
            ...envelope(request),
            type: 'image_upload_chunk_ack',
            transferId: current.transferId,
            seq: request.seq,
            receivedBytes: current.received,
          },
          deliver,
        );
        return;
      }
      if (current.state === 'staged') {
        this.act(current, () => {
          if (!current.reader) return fault('unavailable');
          current.reader.retainStaged();
          deliver(this.result(current, request));
        });
        return;
      }
      if (current.state === 'checking') return fault('busy');
      if (current.state !== 'receiving') return fault('unavailable');
      if (current.received !== current.begin.byteLength) return fault('sequence');
      current.state = 'checking';
      const completion = this.complete(current, request, deliver);
      current.work = completion;
      this.completions.add(completion);
      try {
        await completion;
      } finally {
        current.work = undefined;
        this.completions.delete(completion);
      }
    } catch (error) {
      let code: ImageStagingRefusalCode =
        record?.retired && request.type === 'image_upload_complete'
          ? 'unavailable'
          : error instanceof StagingFault
            ? error.code
            : error instanceof Error && 'code' in error && error.code === 'busy'
              ? 'busy'
              : 'unavailable';
      if (
        record &&
        (code === 'binding_changed' || !['staged', 'cancelled'].includes(record.state)) &&
        !['busy', 'conflict'].includes(code)
      ) {
        try {
          await this.retire(record, code === 'expired' ? 'expired' : 'cleanup_failed');
        } catch {
          if (code !== 'unavailable') code = 'cleanup_failed';
        }
      }
      const response: ImageStagingResponse = {
        ...envelope(request),
        type: 'image_upload_refused',
        operation: request.type,
        code,
      };
      if (code === 'unavailable') deliver(response);
      else if (!record) {
        try {
          if (request.type !== 'image_upload_begin') return fault('unavailable');
          const authority = this.capture(id, request);
          this.owner({ authority }, () => deliver(response));
        } catch {
          deliver({ ...response, code: 'unavailable' });
        }
      } else {
        try {
          this.owner(
            record,
            () => {
              const binding = this.host.bindingStore.getIdentity(request.sessionId as UUID);
              const currentCode = !binding?.harnessSessionId
                ? 'unavailable'
                : binding.harness !== 'claude' ||
                    binding.harnessSessionId !== record?.authority.binding.harnessSessionId
                  ? 'binding_changed'
                  : code;
              deliver({ ...response, code: currentCode });
            },
            false,
          );
        } catch {
          deliver({ ...response, code: 'unavailable' });
        }
      }
    }
  }

  private async complete(
    record: Transfer,
    request: ImageUploadComplete,
    deliver: Delivery,
  ): Promise<void> {
    this.act(record, () => {
      record.writer.close();
      record.writerClosed = true;
      record.reader = record.writer.openRead();
    });
    const reader = record.reader;
    if (!reader || reader.byteLength !== record.begin.byteLength) return fault('integrity');
    const bytes = Buffer.alloc(reader.byteLength);
    const digest = createHash('sha256');
    for (let at = 0; at < bytes.length; at += 32768) {
      const block = this.act(record, () => reader.read(at, Math.min(32768, bytes.length - at)));
      block.copy(bytes, at);
      digest.update(block);
      // Let answers, cancellation and attachment/binding changes run between every bounded read/hash.
      await Bun.sleep(0);
      this.act(record, () => {});
    }
    if (digest.digest('base64url') !== record.begin.digest) return fault('integrity');
    try {
      admitImage(bytes, record.begin.mediaType);
    } catch {
      return fault('unsupported_media');
    }
    // Admission bounds the waiting work. One owned decoder runs at a time;
    // every queued operation rechecks authority and the original deadline.
    const decoded = this.decodeTail.then(async () => {
      const pending = this.act(record, () =>
        this.decoder.decode(bytes, record.begin.mediaType, { signal: record.abort.signal }),
      );
      try {
        await pending;
      } catch {
        return fault(this.expired(record) ? 'expired' : 'decode_failed');
      }
    });
    this.decodeTail = decoded.then(
      () => {},
      () => {},
    );
    await decoded;
    this.act(record, () => {
      if (record.state !== 'checking') return fault('unavailable');
      reader.retainStaged();
      const now = performance.now();
      record.artifact = {
        id: this.token(),
        expiresAt: new Date(Date.now() + stagedLifetime).toISOString(),
        until: now + stagedLifetime,
      };
      record.state = 'staged';
      // Keep the read view/intent flock for the artifact lifetime: another live daemon's boot cannot settle it.
      deliver(this.result(record, request));
    });
  }

  private async retire(
    record: Transfer,
    state: 'cancelled' | 'expired' | 'cleanup_failed',
  ): Promise<void> {
    // Confirmed cancellation already released storage. An evicted receipt must
    // neither recreate cleanup debt nor attempt the old lease again.
    if (record.state === 'cancelled') return;
    record.retired = true;
    record.state = state;
    record.abort.abort();
    // The completion owner performs its own unwind; cancellation can close the copied-input read independently.
    try {
      if (!record.writerClosed) {
        record.writer.close();
        record.writerClosed = true;
      }
      record.reader?.close();
      record.reader = undefined;
      settleJournal(this.store, record.lease, this.scratch, this.metadata, this.storage.ops);
      this.debt.delete(record);
    } catch {
      record.state = 'cleanup_failed';
      this.debt.add(record);
      return fault('cleanup_failed');
    }
  }

  async invalidateConnection(id: UUID): Promise<void> {
    for (const record of this.transfers.values()) {
      if (record.authority.connection.id !== id || record.state === 'staged') continue;
      try {
        await this.retire(record, 'expired');
      } catch {
        /* Charged owned debt remains. */
      }
    }
  }
  async invalidateSession(id: UUID): Promise<void> {
    for (const record of this.transfers.values()) {
      if (record.begin.sessionId !== id) continue;
      try {
        await this.retire(record, 'expired');
      } catch {
        /* Charged owned debt remains. */
      }
    }
  }
  maintain(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    const pending = this.maintainOwned();
    this.maintenance = pending;
    void pending
      .finally(() => {
        this.maintenance = undefined;
      })
      .catch(() => {});
    return pending;
  }

  private async maintainOwned(): Promise<void> {
    if (this.closed) return;
    for (const record of this.transfers.values()) {
      if (record.state === 'staged') {
        // Completed storage belongs to the captured session until its original deadline.
        // Losing this socket/grant only ends response authority, not the artifact lifetime.
        const session = this.host.sessionRegistry.getSession(record.begin.sessionId as UUID);
        if (
          this.expired(record) ||
          session !== record.authority.session ||
          session.pty !== record.authority.pty ||
          !record.authority.pty.isRunning
        ) {
          try {
            await this.retire(record, 'expired');
          } catch {
            /* Charged debt remains. */
          }
        }
      } else if (['receiving', 'checking'].includes(record.state)) {
        try {
          this.act(record, () => {});
        } catch {
          try {
            await this.retire(record, 'expired');
          } catch {
            /* Charged debt remains. */
          }
        }
      }
      if (this.partialLifetimeEnded(record) && record.state !== 'staged') {
        this.transfers.delete(record.transferId);
        this.begins.delete(record.begin.id);
      }
      // Bounded correlations keep their original deadline even if another process
      // temporarily holds the ledger lock. Every replay checks the current row.
    }
    for (const record of this.debt) {
      try {
        await this.retire(record, 'cleanup_failed');
      } catch {
        /* Charged debt remains. */
      }
    }
  }

  /** False means uncertain owned handles/debt must remain until process death; never retry numeric FDs. */
  close(): Promise<boolean> {
    if (!this.closing) this.closing = this.closeOwned();
    return this.closing;
  }

  private async closeOwned(): Promise<boolean> {
    this.closed = true;
    clearInterval(this.timer);
    if (this.maintenance) await this.maintenance;
    for (const record of this.transfers.values()) {
      try {
        await this.retire(record, 'expired');
      } catch {
        /* Preserve debt. */
      }
      if (record.work) await Promise.allSettled([record.work]);
    }
    await Promise.allSettled(this.completions);
    if (this.debt.size) return false;
    this.storage.close();
    fs.rmdirSync(this.workerCwd);
    return true;
  }
}
