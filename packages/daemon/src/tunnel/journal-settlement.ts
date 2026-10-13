// #1170 journal composition used by authenticated direct image staging and recovery.
// Captured transfer authority belongs to ImageStagingService; insertion remains separately gated.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DirectoryRoot } from './admission';
import {
  type JournalBinding,
  type JournalLease,
  journalArtifactName,
  sameWitnesses,
} from './journal-schema';
import { RecoveryError, RecoveryIntent, type RecoveryOps } from './recovery';
import { ReservationError, type Reservations } from './reservations';

export type SettlementStage =
  | 'retirement-committed'
  | 'retired-owned'
  | 'retired-cleaned'
  | 'retired-intent'
  | 'metadata-fsynced'
  | 'settled-committed';
export const SETTLEMENT_STAGES: readonly SettlementStage[] = [
  'retirement-committed',
  'retired-owned',
  'retired-cleaned',
  'retired-intent',
  'metadata-fsynced',
  'settled-committed',
];

function roots(lease: JournalLease, scratch: DirectoryRoot, metadata: DirectoryRoot): void {
  if (
    !scratch.isCurrent() ||
    !metadata.isCurrent() ||
    lease.scratch !== scratch.identity ||
    lease.metadata !== metadata.identity
  )
    throw new RecoveryError('unavailable');
}

export type JournalWriter = {
  readonly lease: JournalLease;
  write(bytes: Uint8Array | string, afterChunkForProof?: (ownedFd: number) => void): void;
  close(beforeCloseForProof?: (ownedFd: number) => void): void;
  openRead(): JournalRead;
};

/** Internal owned read view; completion correlation and transfer authority belong to the caller. */
export type JournalRead = {
  readonly lease: JournalLease;
  readonly byteLength: number;
  read(position: number, length: number): Buffer;
  /** Internal host handoff only. Validate again at the queued effect; never send this on the wire. */
  referencePath(): string;
  retainStaged(): 'staged';
  close(): void;
};

function openJournalRead(
  store: Reservations,
  lease: JournalLease,
  scratch: DirectoryRoot,
  metadata: DirectoryRoot,
  ops: RecoveryOps,
): JournalRead {
  let intent: RecoveryIntent | undefined;
  let fd = -1;
  let original: fs.BigIntStats | undefined;
  try {
    const byteLength = store.captureJournalRead(lease, (bytes, ownership) => {
      roots(lease, scratch, metadata);
      intent = RecoveryIntent.open(
        scratch,
        metadata,
        lease.id,
        ops,
        false,
        lease.artifactExtension,
      );
      const measured = intent.snapshot(['intent', 'owned']);
      if (!sameWitnesses(measured, ownership)) throw new RecoveryError('unavailable');
      fd = intent.openArtifactRead();
      original = fs.fstatSync(fd, { bigint: true });
      if (original.size !== BigInt(bytes)) throw new RecoveryError('unavailable');
      return { ownership: measured, allocated: intent.artifactAllocated(fd) };
    });
    if (!intent || !original) throw new RecoveryError('unavailable');
    const held = intent;
    const stat = original;
    let closed = false;
    let closeFailed = false;
    let staged = false;
    const current = () => {
      if (closed) throw new RecoveryError('unavailable');
      roots(lease, scratch, metadata);
      held.validateArtifactRead(fd, stat);
    };
    const measure = (bytes: number) => {
      if (bytes !== byteLength) throw new RecoveryError('unavailable');
      current();
      const measurement = {
        ownership: held.snapshot(['intent', 'owned']),
        allocated: held.artifactAllocated(fd),
      };
      current();
      return measurement;
    };
    const account = () => store.captureJournalRead(lease, measure);
    return {
      lease,
      byteLength,
      read(position, length) {
        if (
          closed ||
          !Number.isSafeInteger(position) ||
          position < 0 ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > 32 * 1024 ||
          position + length > byteLength
        )
          throw new RecoveryError('unavailable');
        account();
        const buffer = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          account();
          const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
          if (!count) throw new RecoveryError('unavailable');
          offset += count;
          account();
        }
        return buffer;
      },
      referencePath() {
        if (!staged) throw new RecoveryError('unavailable');
        account();
        return path.join(scratch.pathname, journalArtifactName(lease.id, lease.artifactExtension));
      },
      retainStaged() {
        if (closed) throw new RecoveryError('unavailable');
        const result = store.retainJournal(lease, measure);
        staged = true;
        return result;
      },
      close() {
        if (closeFailed) throw new RecoveryError('unavailable');
        if (closed) return;
        closed = true;
        try {
          const current = fs.fstatSync(fd, { bigint: true });
          if (current.dev !== stat.dev || current.ino !== stat.ino)
            throw new RecoveryError('unavailable');
          fs.closeSync(fd);
          held.close();
        } catch {
          closeFailed = true; // Never retry a possibly recycled FD; retain the intent until death.
          throw new RecoveryError('unavailable');
        }
      },
    };
  } catch (error) {
    if (fd >= 0) fs.closeSync(fd);
    intent?.close();
    throw error;
  }
}

export function beginJournal(
  store: Reservations,
  owner: { device: string; session: string; hub: string },
  bytes: number,
  scratch: DirectoryRoot,
  metadata: DirectoryRoot,
  ops: RecoveryOps,
  artifactExtension?: JournalBinding['artifactExtension'],
): JournalWriter {
  if (!scratch.isCurrent() || !metadata.isCurrent()) throw new RecoveryError('unavailable');
  const lease = store.reserveJournal(
    owner,
    bytes,
    scratch.identity,
    metadata.identity,
    artifactExtension,
  );
  let intent: RecoveryIntent | undefined;
  let fd = -1;
  try {
    roots(lease, scratch, metadata);
    intent = RecoveryIntent.open(scratch, metadata, lease.id, ops, true, lease.artifactExtension);
    fd = intent.createArtifact();
    store.bindJournalOwnership(
      lease,
      intent.snapshot(['intent', 'owned']),
      intent.artifactAllocated(fd),
    );
    roots(lease, scratch, metadata);
    const held = intent;
    let closed = false;
    let failed = false;
    let position = 0;
    return {
      lease,
      write(bytes, afterChunkForProof) {
        if (closed || failed) throw new RecoveryError('unavailable');
        const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
        const projected = position + buffer.length;
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(projected))
          throw new RecoveryError('unavailable');
        const measure = () => {
          roots(lease, scratch, metadata);
          return {
            ownership: held.snapshot(['intent', 'owned']),
            allocated: held.artifactAllocated(fd),
          };
        };
        let effects = false;
        const effect = () => {
          let offset = 0;
          while (offset < buffer.length) {
            effects = true;
            const count = fs.writeSync(
              fd,
              buffer,
              offset,
              Math.min(64 * 1024, buffer.length - offset),
              position,
            );
            if (!count) throw new RecoveryError('unavailable');
            position += count;
            offset += count;
            // Standalone proof only: actual FD closure after a real chunk induces the next EBADF.
            afterChunkForProof?.(fd);
          }
        };
        try {
          store.writeJournal(lease, projected, measure, effect);
        } catch (error) {
          if (!(error instanceof ReservationError && error.code === 'busy' && !effects))
            failed = true;
          throw error; // Uncertain effects retain the intent until death; pre-effect busy is retryable.
        }
      },
      close(beforeCloseForProof) {
        if (failed) throw new RecoveryError('unavailable');
        if (closed) return;
        try {
          fs.fsyncSync(fd);
          // Standalone proof only: invoke a real close here, then observe actual EBADF below.
          beforeCloseForProof?.(fd);
          fs.closeSync(fd);
          held.close();
          closed = true;
        } catch {
          // Never retry this numeric FD: a failed close may have freed it for unrelated reuse.
          failed = true;
          throw new RecoveryError('unavailable'); // Keep the intent flock until process exit.
        }
      },
      openRead() {
        if (!closed || failed) throw new RecoveryError('unavailable');
        return openJournalRead(store, lease, scratch, metadata, ops);
      },
    }; // Ledger ownership binding precedes the managed writable handle return.
  } catch (error) {
    if (fd >= 0) fs.closeSync(fd);
    intent?.close();
    throw error; // Reservation remains charged; missing ownership never becomes guessed cleanup.
  }
}

/** Close any ordinary intent/artifact lease first: the retirement open must own its own flock. */
export function settleJournal(
  store: Reservations,
  lease: JournalLease,
  scratch: DirectoryRoot,
  metadata: DirectoryRoot,
  ops: RecoveryOps,
  checkpoint?: (stage: SettlementStage) => void,
): 'settled' | 'already_settled' {
  roots(lease, scratch, metadata);
  return store.reconcileJournal(
    lease,
    (ownership, retainAllocation) => {
      roots(lease, scratch, metadata);
      const intent = RecoveryIntent.open(
        scratch,
        metadata,
        lease.id,
        ops,
        false,
        lease.artifactExtension,
      );
      try {
        const measured = intent.snapshot(['intent', 'owned']);
        if (!sameWitnesses(measured, ownership)) throw new RecoveryError('unavailable');
        retainAllocation(intent.artifactAllocated(), measured);
        if (intent.cleanup() !== 'cleaned') throw new RecoveryError('unavailable');
        return intent.snapshot(['intent', 'owned', 'cleaned']);
      } finally {
        intent.close();
      }
    },
    (witnesses, retainMarkers) => {
      roots(lease, scratch, metadata);
      RecoveryIntent.retire(
        scratch,
        metadata,
        lease.id,
        ops,
        witnesses,
        (stage) => checkpoint?.(stage as SettlementStage),
        retainMarkers,
        lease.artifactExtension,
      );
    },
    checkpoint,
  );
}
