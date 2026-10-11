// #1170 standalone composition only: trusted metadata, no recovery or transfer authority.
import type { AdmittedFile, DirectoryRoot } from './admission';
import {
  type CopyCheckpoint,
  type PrivateCopy,
  PrivateCopyCleanupError,
  type PrivateOps,
  copyToPrivate,
} from './private-copy';
import { CLEANUP_BLOCKING_DEBT, type Reservations } from './reservations';

export class ReservedCopyError extends Error {
  constructor(
    readonly code: 'cleanup_failed' | 'unavailable',
    readonly cleanupConfirmed: boolean,
  ) {
    super(`reserved copy ${code}; cleanup ${cleanupConfirmed ? 'confirmed' : 'unconfirmed'}`);
  }
}

function retainFailedCleanup(
  store: Reservations,
  id: string,
  allocatedBytes: number | null,
): never {
  try {
    // Unknown allocation retains blocking debt; metadata failure still reports unavailability.
    store.retain(id, 'cleanup', allocatedBytes ?? CLEANUP_BLOCKING_DEBT);
  } catch {
    // Even an unreadable ledger is never reset or refunded. The artifact may remain.
    throw new ReservedCopyError('unavailable', false);
  }
  throw new ReservedCopyError('cleanup_failed', false);
}

function completedAllocation(copy: PrivateCopy): number | null {
  try {
    return copy.allocatedBytes();
  } catch {
    return null;
  }
}

function releaseConfirmed(store: Reservations, id: string): void {
  try {
    store.releaseAfterCleanup(id);
  } catch {
    // The file is gone; metadata may have committed before its acknowledgment failed.
    // Only a known pre-write lock refusal is proven retryable. An absent ID still refuses.
    throw new ReservedCopyError('unavailable', true);
  }
}

export class ReservedPrivateCopy {
  private released = false;
  constructor(
    private readonly copy: PrivateCopy,
    private readonly store: Reservations,
    readonly reservationId: string,
  ) {}

  get size(): number {
    return this.copy.size;
  }
  get sha256(): string {
    return this.copy.sha256;
  }
  read(buffer: Buffer, offset: number): number {
    return this.copy.read(buffer, offset);
  }

  close(): void {
    if (this.released) return;
    try {
      this.copy.close();
    } catch {
      retainFailedCleanup(this.store, this.reservationId, completedAllocation(this.copy));
    }
    // Idempotent file close permits a retry after known pre-write lock refusal.
    // An ambiguous metadata acknowledgment is not generic recovery authority.
    releaseConfirmed(this.store, this.reservationId);
    this.released = true;
  }
}

/** Reserve before the copy allocates, reads or creates. No filename is stored in the ledger. */
export function reserveAndCopy(
  source: AdmittedFile,
  root: DirectoryRoot,
  ops: PrivateOps,
  store: Reservations,
  owner: Parameters<Reservations['reserve']>[0],
  checkpoint?: (event: CopyCheckpoint) => void,
): ReservedPrivateCopy | null {
  const id = store.reserve(owner, Number(source.size));
  let copy: PrivateCopy | null;
  try {
    copy = copyToPrivate(source, root, ops, checkpoint);
  } catch (error) {
    // copyToPrivate throws when descriptor-owned partial cleanup could not be confirmed.
    retainFailedCleanup(
      store,
      id,
      error instanceof PrivateCopyCleanupError ? error.allocatedBytes : null,
    );
  }
  if (!copy) {
    releaseConfirmed(store, id); // Normal refusal returns only after successful owned cleanup.
    return null;
  }
  try {
    store.retain(id, 'staged', copy.allocatedBytes());
  } catch {
    try {
      copy.close();
    } catch {
      retainFailedCleanup(store, id, completedAllocation(copy));
    }
    releaseConfirmed(store, id);
    throw new ReservedCopyError('unavailable', true);
  }
  return new ReservedPrivateCopy(copy, store, id);
}
