// #1443/#1170 standalone composition; no shipping caller or transfer authority.
import * as fs from 'node:fs';
import type { DirectoryRoot } from './admission';
import { type JournalLease, sameWitnesses } from './journal-schema';
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
};

export function beginJournal(
  store: Reservations,
  owner: { device: string; session: string; hub: string },
  bytes: number,
  scratch: DirectoryRoot,
  metadata: DirectoryRoot,
  ops: RecoveryOps,
): JournalWriter {
  if (!scratch.isCurrent() || !metadata.isCurrent()) throw new RecoveryError('unavailable');
  const lease = store.reserveJournal(owner, bytes, scratch.identity, metadata.identity);
  let intent: RecoveryIntent | undefined;
  let fd = -1;
  try {
    roots(lease, scratch, metadata);
    intent = RecoveryIntent.open(scratch, metadata, lease.id, ops, true);
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
      const intent = RecoveryIntent.open(scratch, metadata, lease.id, ops);
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
      );
    },
    checkpoint,
  );
}
