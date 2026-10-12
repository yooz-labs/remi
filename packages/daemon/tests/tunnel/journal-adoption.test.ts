import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as proofJournal from '../../../../scripts/tunnel-storage-proof/journal-settlement';
import * as proofRecovery from '../../../../scripts/tunnel-storage-proof/recovery';
import { recoveryNative } from '../../../../scripts/tunnel-storage-proof/recovery-native';
import { DirectoryRoot } from '../../src/tunnel/admission';
import {
  SETTLEMENT_STAGES,
  beginJournal,
  settleJournal,
} from '../../src/tunnel/journal-settlement';
import { RecoveryError, RecoveryIntent, allocatedBlocks } from '../../src/tunnel/recovery';
import { Reservations } from '../../src/tunnel/reservations';

test('proof journal adapters share daemon functions and settle an actual private journal', async () => {
  expect(proofJournal.beginJournal).toBe(beginJournal);
  expect(proofJournal.settleJournal).toBe(settleJournal);
  expect(proofJournal.SETTLEMENT_STAGES).toBe(SETTLEMENT_STAGES);
  expect(proofRecovery.RecoveryIntent).toBe(RecoveryIntent);
  expect(proofRecovery.allocatedBlocks).toBe(allocatedBlocks);
  expect(proofRecovery.RecoveryError).toBe(RecoveryError);
  expect(new proofRecovery.RecoveryError('busy')).toBeInstanceOf(RecoveryError);
  expect(new RecoveryError('unavailable')).toBeInstanceOf(proofRecovery.RecoveryError);
  const bytes = fs.readFileSync(
    path.resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof/fixture.png'),
  );
  const native = await recoveryNative();
  const home = fs.mkdtempSync(path.join(tmpdir(), 'remi-journal-adoption-'));
  fs.chmodSync(home, 0o700);
  let scratch: DirectoryRoot | null = null;
  let metadata: DirectoryRoot | null = null;
  try {
    const scratchPath = path.join(home, 'scratch');
    const metadataPath = path.join(home, 'metadata');
    fs.mkdirSync(scratchPath, { mode: 0o700 });
    fs.mkdirSync(metadataPath, { mode: 0o700 });
    scratch = DirectoryRoot.capture(scratchPath, native.ops.openAt.bind(native.ops));
    metadata = DirectoryRoot.capture(metadataPath, native.ops.openAt.bind(native.ops));
    expect(scratch).toBeInstanceOf(DirectoryRoot);
    expect(metadata).toBeInstanceOf(DirectoryRoot);
    if (!scratch || !metadata) throw new Error('actual journal root capture failed');
    const store = Reservations.create(path.join(home, 'ledger'));
    const writer = proofJournal.beginJournal(
      store,
      {
        device: randomBytes(32).toString('hex'),
        session: randomUUID(),
        hub: randomBytes(16).toString('hex'),
      },
      bytes.length,
      scratch,
      metadata,
      native.ops,
    );
    writer.write(bytes.subarray(0, 32));
    writer.write(bytes.subarray(32));
    writer.close();
    expect(fs.readFileSync(path.join(scratchPath, `${writer.lease.id}.artifact`))).toEqual(bytes);
    expect(store.inspect()[0]?.state).toBe('active');
    expect(store.inspect()[0]?.charge).toBeGreaterThanOrEqual(bytes.length);
    const intent = proofRecovery.RecoveryIntent.open(
      scratch,
      metadata,
      writer.lease.id,
      native.ops,
    );
    try {
      expect(intent.cleanup()).toBe('cleaned');
      expect(intent.snapshot(['intent', 'owned', 'cleaned'])).toHaveLength(3);
    } finally {
      intent.close();
    }
    expect(proofJournal.settleJournal(store, writer.lease, scratch, metadata, native.ops)).toBe(
      'settled',
    );
    expect(fs.readdirSync(scratchPath)).toEqual([]);
    expect(fs.readdirSync(metadataPath)).toEqual([]);
    expect(store.inspect()[0]?.state).toBe('settled');
    expect(store.inspect()[0]?.charge).toBe(0);
    expect(settleJournal(store, writer.lease, scratch, metadata, native.ops)).toBe(
      'already_settled',
    );
  } finally {
    scratch?.close();
    metadata?.close();
    native.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
