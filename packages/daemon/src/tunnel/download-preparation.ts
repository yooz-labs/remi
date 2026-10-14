/** Owned managed-copy preparation; no wire dispatch or client authority is created here (#1170). */
import { createHash } from 'node:crypto';
import type { AdmittedFile, DirectoryRoot } from './admission';
import { ADMITTED_READ_CHUNK_SIZE, AdmittedRead } from './admitted-read';
import {
  type JournalRead,
  type JournalWriter,
  beginJournal,
  settleJournal,
} from './journal-settlement';
import type { RecoveryOps } from './recovery';
import type { Reservations } from './reservations';

export class DownloadPreparationError extends Error {
  constructor(
    readonly code: 'unavailable' | 'empty_file' | 'cleanup_failed',
    readonly cleanupConfirmed: boolean,
  ) {
    super(`download preparation ${code}`);
  }
}

export interface DownloadCopyContext {
  /** Captured owner/connection/binding/deadline check around each synchronous effect. */
  effect<T>(operation: () => T): T;
  /** Yield between bounded chunks; called through this context to preserve its receiver. */
  yield(): Promise<void>;
}

export interface PreparedDownloadCopy {
  readonly byteLength: number;
  /** Canonical base64url SHA-256 of the verified private copy. */
  readonly digest: string;
  read(position: number, length: number): Buffer;
  /** Close the owned reader before journal settlement. A failed settlement may be retried. */
  retire(): 'settled' | 'already_settled';
}

/** Consumes the admitted source. The caller still guards acceptance and the actual queued send. */
export async function prepareDownloadCopy(
  source: AdmittedFile,
  store: Reservations,
  owner: Parameters<Reservations['reserveJournal']>[0],
  scratch: DirectoryRoot,
  metadata: DirectoryRoot,
  ops: RecoveryOps,
  context: DownloadCopyContext,
): Promise<PreparedDownloadCopy> {
  let writer: JournalWriter | undefined;
  let reader: JournalRead | undefined;
  let beginAttempted = false;
  let writerCloseAttempted = false;
  let writerClosed = false;
  let readerCloseAttempted = false;
  let readerClosed = false;
  let readerCloseFailed = false;
  let sourceClosed = false;
  let sourceCloseAttempted = false;
  let terminal = false;
  let settled = false;
  const closeSource = () => {
    if (sourceClosed) return;
    if (sourceCloseAttempted) throw new DownloadPreparationError('cleanup_failed', false);
    sourceCloseAttempted = true;
    source.close();
    sourceClosed = true;
  };
  const closeReader = () => {
    if (!reader || readerClosed) return;
    if (readerCloseFailed || readerCloseAttempted)
      throw new DownloadPreparationError('cleanup_failed', false);
    readerCloseAttempted = true;
    try {
      reader.close();
      readerClosed = true;
    } catch {
      readerCloseFailed = true;
      throw new DownloadPreparationError('cleanup_failed', false);
    }
  };
  const retire = () => {
    if (settled) return 'already_settled' as const;
    terminal = true;
    if (!writer || !writerClosed) throw new DownloadPreparationError('cleanup_failed', false);
    closeReader();
    try {
      const result = settleJournal(store, writer.lease, scratch, metadata, ops);
      settled = true;
      return result;
    } catch {
      throw new DownloadPreparationError('cleanup_failed', false);
    }
  };
  try {
    const captured = context.effect(() => {
      const cursor = AdmittedRead.capture(source);
      if (!cursor) throw new DownloadPreparationError('unavailable', true);
      if (cursor.byteLength === 0) throw new DownloadPreparationError('empty_file', true);
      beginAttempted = true;
      writer = beginJournal(store, owner, cursor.byteLength, scratch, metadata, ops);
      return { cursor, writer };
    });
    const admitted = captured.cursor;
    const ownedWriter = captured.writer;
    while (admitted.bytesRead < admitted.byteLength) {
      context.effect(() => {
        if (!admitted.isCurrent()) throw new DownloadPreparationError('unavailable', true);
        ownedWriter.write(admitted.readNext());
      });
      await context.yield();
    }
    const expected = context.effect(() => admitted.finish());
    const privateReader = context.effect(() => {
      writerCloseAttempted = true;
      ownedWriter.close();
      writerClosed = true;
      reader = ownedWriter.openRead();
      return reader;
    });
    if (privateReader.byteLength !== expected.byteLength)
      throw new DownloadPreparationError('unavailable', true);
    const hash = createHash('sha256');
    for (let position = 0; position < expected.byteLength; position += ADMITTED_READ_CHUNK_SIZE) {
      context.effect(() => {
        hash.update(
          privateReader.read(
            position,
            Math.min(ADMITTED_READ_CHUNK_SIZE, expected.byteLength - position),
          ),
        );
      });
      await context.yield();
    }
    if (hash.digest('hex') !== expected.sha256)
      throw new DownloadPreparationError('unavailable', true);
    context.effect(() => {
      // Verification yields: preserve the source's final publication check as well.
      if (!admitted.isCurrent()) throw new DownloadPreparationError('unavailable', true);
      // Validate the private descriptor/name/metadata after the final verification yield.
      privateReader.read(0, 1);
      closeSource();
    });
    return context.effect(() => ({
      byteLength: expected.byteLength,
      digest: Buffer.from(expected.sha256, 'hex').toString('base64url'),
      read(position: number, length: number) {
        if (terminal) throw new DownloadPreparationError('unavailable', settled);
        return context.effect(() => privateReader.read(position, length));
      },
      retire,
    }));
  } catch (error) {
    let cleanupConfirmed = !beginAttempted;
    try {
      closeSource();
    } catch {
      cleanupConfirmed = false;
    }
    try {
      if (writer) {
        if (!writerClosed) {
          if (writerCloseAttempted) throw new DownloadPreparationError('cleanup_failed', false);
          writerCloseAttempted = true;
          writer.close();
          writerClosed = true;
        }
        closeReader();
        // An uncertain source close retains the charged operation until recovery.
        if (!sourceClosed) throw new DownloadPreparationError('cleanup_failed', false);
        retire();
        cleanupConfirmed = true;
      }
    } catch {
      cleanupConfirmed = false;
    }
    if (!cleanupConfirmed) throw new DownloadPreparationError('cleanup_failed', false);
    if (error instanceof DownloadPreparationError) throw error;
    throw new DownloadPreparationError('unavailable', true);
  }
}
