/** Shared physical journal namespace; each opener owns its own native/root handles. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withInterprocessFileLockNonblocking } from '../storage/interprocess-file-lock';
import { DirectoryRoot } from './admission';
import { settleJournal } from './journal-settlement';
import { RecoveryError, type RecoveryOps } from './recovery';
import { recoveryNative } from './recovery-native';
import { Reservations } from './reservations';

export interface ManagedTunnelStorage {
  readonly base: string;
  readonly hub: string;
  readonly store: Reservations;
  readonly scratch: DirectoryRoot;
  readonly metadata: DirectoryRoot;
  readonly ops: RecoveryOps;
  recover(): void;
  /** Caller must first settle its own work/debt. A failed close is never retried numerically. */
  close(): void;
}

function privateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.()
  )
    throw new RecoveryError('unavailable');
}

export async function openManagedTunnelStorage(home: string): Promise<ManagedTunnelStorage> {
  if (!path.isAbsolute(home)) throw new RecoveryError('unavailable');
  privateDirectory(home);
  const base = path.join(home, 'image-staging');
  const ledger = path.join(base, 'ledger');
  const scratchPath = path.join(base, 'scratch');
  const metadataPath = path.join(base, 'metadata');
  withInterprocessFileLockNonblocking(path.join(home, 'image-staging-initialize'), () => {
    if (!fs.existsSync(base)) {
      fs.mkdirSync(base, { mode: 0o700 });
      fs.mkdirSync(scratchPath, { mode: 0o700 });
      fs.mkdirSync(metadataPath, { mode: 0o700 });
      Reservations.create(ledger);
    }
    for (const directory of [base, ledger, scratchPath, metadataPath]) privateDirectory(directory);
  });
  const native = await recoveryNative();
  let scratch: DirectoryRoot | undefined;
  let metadata: DirectoryRoot | undefined;
  try {
    const store = new Reservations(ledger);
    scratch = DirectoryRoot.capture(scratchPath, native.ops.openAt.bind(native.ops)) ?? undefined;
    metadata = DirectoryRoot.capture(metadataPath, native.ops.openAt.bind(native.ops)) ?? undefined;
    if (!scratch || !metadata) throw new RecoveryError('unavailable');
    const ownedScratch = scratch;
    const ownedMetadata = metadata;
    const stat = fs.lstatSync(ledger, { bigint: true });
    const hub = createHash('sha256')
      .update(`remi-image-staging:${stat.dev}:${stat.ino}`)
      .digest('hex')
      .slice(0, 32);
    let state: 'open' | 'closed' | 'uncertain' = 'open';
    return {
      base,
      hub,
      store,
      scratch: ownedScratch,
      metadata: ownedMetadata,
      ops: native.ops,
      recover() {
        if (state !== 'open') throw new RecoveryError('unavailable');
        for (const record of store.inspect()) {
          if (record.state === 'settled' || !record.journal) continue;
          try {
            settleJournal(
              store,
              { id: record.id, ...record.journal },
              ownedScratch,
              ownedMetadata,
              native.ops,
            );
          } catch {
            // Live ownership, uncertain handles or unverifiable debt stay charged.
          }
        }
      },
      close() {
        if (state === 'closed') return;
        if (state === 'uncertain') throw new RecoveryError('unavailable');
        state = 'uncertain';
        ownedScratch.close();
        ownedMetadata.close();
        native.close();
        state = 'closed';
      },
    };
  } catch (error) {
    scratch?.close();
    metadata?.close();
    native.close();
    throw error;
  }
}
