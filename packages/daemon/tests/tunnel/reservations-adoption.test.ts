import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as proofSchema from '../../../../scripts/tunnel-storage-proof/journal-schema';
import { RecoveryError as ProofRecoveryError } from '../../../../scripts/tunnel-storage-proof/recovery';
import * as proofReservations from '../../../../scripts/tunnel-storage-proof/reservations';
import * as schema from '../../src/tunnel/journal-schema';
import { RecoveryError } from '../../src/tunnel/recovery-error';
import {
  CLEANUP_BLOCKING_DEBT,
  ReservationError,
  Reservations,
} from '../../src/tunnel/reservations';

test('proof adapters share daemon constructors and actual durable reservation accounting', () => {
  expect(proofReservations.Reservations).toBe(Reservations);
  expect(proofReservations.ReservationError).toBe(ReservationError);
  expect(proofReservations.CLEANUP_BLOCKING_DEBT).toBe(CLEANUP_BLOCKING_DEBT);
  expect(ProofRecoveryError).toBe(RecoveryError);
  expect(new ProofRecoveryError('busy')).toBeInstanceOf(RecoveryError);
  expect(new RecoveryError('unavailable')).toBeInstanceOf(ProofRecoveryError);
  expect(new ProofRecoveryError('busy').message).toBe('recovery busy');
  expect(proofSchema.MARKER_ALLOWANCE).toBe(schema.MARKER_ALLOWANCE);
  for (const name of ['sameLease', 'sameWitnesses', 'validBinding', 'validWitnesses'] as const)
    expect(proofSchema[name]).toBe(schema[name]);

  const root = fs.mkdtempSync(path.join(tmpdir(), 'remi-reservations-adoption-'));
  try {
    const home = path.join(root, 'home');
    const scratch = path.join(root, 'scratch');
    const metadata = path.join(root, 'metadata');
    fs.mkdirSync(scratch, { mode: 0o700 });
    fs.mkdirSync(metadata, { mode: 0o700 });
    const identity = (directory: string) => {
      const stat = fs.statSync(directory, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    };
    const owner = {
      device: randomBytes(32).toString('hex'),
      session: randomUUID(),
      hub: randomBytes(16).toString('hex'),
    };
    const store = Reservations.create(home);
    const lease = store.reserveJournal(owner, 1, identity(scratch), identity(metadata));
    const { id, ...binding } = lease;
    expect(schema.validBinding(binding, 'active')).toBe(true);
    expect(proofSchema.sameLease(binding, lease)).toBe(true);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    store.reserve(owner, 1);
    expect(() => store.reserve(owner, 1)).toThrow(ReservationError);
    try {
      store.reserve(owner, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(proofReservations.ReservationError);
      expect((error as ReservationError).code).toBe('busy');
    }
    const reopened = new proofReservations.Reservations(home);
    expect(reopened.inspect().map((record) => record.charge)).toEqual([16384, 4096]);
    expect(fs.statSync(path.join(home, 'reservations.json')).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
