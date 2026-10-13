// #1170 internal reservation accounting. No production caller or file-deletion authority.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  InterprocessFileLockError,
  withInterprocessFileLockNonblocking,
} from '../storage/interprocess-file-lock';
import { writeRestrictedJson } from '../storage/restricted-json';
import {
  type JournalBinding,
  type JournalLease,
  MARKER_ALLOWANCE,
  type MarkerWitness,
  sameLease,
  sameWitnesses,
  validBinding,
  validWitnesses,
} from './journal-schema';
import { RecoveryError } from './recovery-error';

const KIB = 1024;
const FILE_LIMIT = 10 * 1024 * KIB;
const HOME_LIMIT = 100 * 1024 * KIB;
// Blocking accounting debt when an unconfirmed cleanup has no owned allocation measurement.
// This is not a measured allocation or a physical ceiling.
export const CLEANUP_BLOCKING_DEBT = HOME_LIMIT + 4 * KIB;
const LEDGER_LIMIT = 256 * KIB;
const STATES = ['active', 'staged', 'cleanup'] as const;
type State = (typeof STATES)[number] | 'settled';
type Owner = { device: string; session: string; hub: string };
type Record = Owner & {
  id: string;
  bytes: number;
  charge: number;
  state: State;
  journal?: JournalBinding;
};
const KEYS = ['id', 'device', 'session', 'hub', 'bytes', 'charge', 'state'].sort();
const HEX = /^[a-f0-9]{64}$/;
const SESSION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const C = fs.constants;

export class ReservationError extends Error {
  constructor(readonly code: 'busy' | 'unavailable') {
    super(`reservation ${code}`);
  }
}

function rounded(bytes: number): number {
  return Math.max(4 * KIB, Math.ceil(bytes / (4 * KIB)) * 4 * KIB);
}

function validOwner(value: Owner): boolean {
  return (
    typeof value.device === 'string' &&
    HEX.test(value.device) &&
    typeof value.session === 'string' &&
    SESSION.test(value.session) &&
    typeof value.hub === 'string' &&
    TOKEN.test(value.hub)
  );
}

function overLimits(records: Record[], owner: Owner, extra: number): boolean {
  const active = records.filter((item) => item.state === 'active');
  return (
    records.length + extra > 128 ||
    records.filter((item) => item.device === owner.device).length + extra > 32 ||
    active.filter((item) => item.device === owner.device).length + extra > 2 ||
    active.filter((item) => item.session === owner.session).length + extra > 4 ||
    active.filter((item) => item.hub === owner.hub).length + extra > 8
  );
}

function parse(raw: string): Record[] {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).sort().join() !== 'records,version' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('records' in value) ||
    !Array.isArray(value.records) ||
    value.records.length > 128
  )
    throw new ReservationError('unavailable');
  const records: Record[] = [];
  const ids = new Set<string>();
  let total = 0;
  for (const item of value.records) {
    if (
      typeof item !== 'object' ||
      item === null ||
      ![KEYS.join(), [...KEYS, 'journal'].sort().join()].includes(Object.keys(item).sort().join())
    )
      throw new ReservationError('unavailable');
    const record = item as Record;
    if (
      typeof record.id !== 'string' ||
      !TOKEN.test(record.id) ||
      ids.has(record.id) ||
      !validOwner(record) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1 ||
      record.bytes > FILE_LIMIT ||
      !Number.isSafeInteger(record.charge) ||
      (record.state === 'settled'
        ? record.charge !== 0
        : record.charge < rounded(record.bytes) + (record.journal ? MARKER_ALLOWANCE : 0)) ||
      !(record.state === 'settled' ? !!record.journal : STATES.includes(record.state)) ||
      ('journal' in record && !validBinding(record.journal, record.state))
    )
      throw new ReservationError('unavailable');
    total += record.charge;
    if (!Number.isSafeInteger(total)) throw new ReservationError('unavailable');
    ids.add(record.id);
    records.push(record);
  }
  if (records.some((record) => overLimits(records, record, 0)))
    throw new ReservationError('unavailable');
  return records;
}

/**
 * A trusted private metadata namespace, not descriptor-confined recovery. The caller
 * reserves before any content allocation/read/create and releases only after confirmed
 * owned cleanup. Missing state never resets accounting. No transfer authority is stored.
 */
export class Reservations {
  private readonly identity: fs.BigIntStats;
  private readonly file: string;

  constructor(private readonly directory: string) {
    try {
      if (!path.isAbsolute(directory)) throw new ReservationError('unavailable');
      this.identity = fs.lstatSync(directory, { bigint: true });
      this.file = path.join(directory, 'reservations.json');
      this.locked(() => this.read());
    } catch (error) {
      if (error instanceof ReservationError) throw error;
      throw new ReservationError('unavailable');
    }
  }

  /** Exclusive initialization is separate from reopening; never recreate lost state. */
  static create(directory: string): Reservations {
    if (!path.isAbsolute(directory)) throw new ReservationError('unavailable');
    fs.mkdirSync(directory, { mode: 0o700 });
    writeRestrictedJson(path.join(directory, 'reservations.json'), { version: 1, records: [] });
    return new Reservations(directory);
  }

  private current(): void {
    const stat = fs.lstatSync(this.directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (stat.mode & 0o777n) !== 0o700n
    )
      throw new ReservationError('unavailable');
  }

  private read(): Record[] {
    const fd = fs.openSync(this.file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > LEDGER_LIMIT
      )
        throw new ReservationError('unavailable');
      // Bound actual reads as well as metadata; a concurrent growth cannot allocate unbounded JSON.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const amount = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (!amount) break;
        length += amount;
      }
      const after = fs.fstatSync(fd);
      if (
        length !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new ReservationError('unavailable');
      const records = parse(buffer.subarray(0, length).toString('utf8'));
      // Home guard persists across reopen: copying a ledger cannot recapture its authority.
      if (records.some((record) => record.journal && record.journal.home !== this.homeIdentity))
        throw new ReservationError('unavailable');
      return records;
    } finally {
      fs.closeSync(fd);
    }
  }

  private locked<T>(operation: () => T): T {
    try {
      this.current();
      return withInterprocessFileLockNonblocking(this.file, () => {
        this.current();
        const result = operation();
        this.current();
        return result;
      });
    } catch (error) {
      if (error instanceof ReservationError) throw error;
      if (error instanceof RecoveryError) throw new ReservationError(error.code);
      if (error instanceof InterprocessFileLockError && error.retryable)
        throw new ReservationError('busy');
      throw new ReservationError('unavailable');
    }
  }

  private get homeIdentity(): string {
    return `${this.identity.dev}:${this.identity.ino}`;
  }

  private write(records: Record[]): void {
    this.current();
    if (Buffer.byteLength(JSON.stringify({ version: 1, records })) > LEDGER_LIMIT)
      throw new ReservationError('unavailable');
    writeRestrictedJson(this.file, { version: 1, records });
  }

  private transaction<T>(operation: (records: Record[]) => T): T {
    return this.locked(() => {
      const records = this.read();
      const result = operation(records);
      this.write(records);
      return result;
    });
  }

  inspect(): readonly Readonly<Record>[] {
    return this.locked(() => this.read());
  }

  reserve(owner: Owner, bytes: number): string {
    return this.admit(owner, bytes);
  }

  reserveJournal(
    owner: Owner,
    bytes: number,
    scratch: string,
    metadata: string,
    artifactExtension?: JournalBinding['artifactExtension'],
  ): JournalLease {
    const journal: JournalBinding = {
      nonce: randomBytes(16).toString('hex'),
      home: this.homeIdentity,
      scratch,
      metadata,
      ...(artifactExtension !== undefined ? { artifactExtension } : {}),
    };
    if (!validBinding(journal, 'active')) throw new ReservationError('unavailable');
    return { id: this.admit(owner, bytes, journal), ...journal };
  }

  private admit(owner: Owner, bytes: number, journal?: JournalBinding): string {
    if (!validOwner(owner) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > FILE_LIMIT)
      throw new ReservationError('unavailable');
    return this.transaction((records) => {
      const charge = rounded(bytes) + (journal ? MARKER_ALLOWANCE : 0);
      // History-bound guard: only completed receipts make room; pending rows never disappear.
      while (records.length >= 128) {
        const oldest = records.findIndex((item) => item.state === 'settled');
        if (oldest < 0) break;
        records.splice(oldest, 1);
      }
      // Retained settled rows are cancellation retry slots too. Pressure may retire only receipts.
      while (records.filter((item) => item.device === owner.device).length >= 32) {
        const oldest = records.findIndex(
          (item) => item.state === 'settled' && item.device === owner.device,
        );
        if (oldest < 0) break;
        records.splice(oldest, 1);
      }
      if (
        overLimits(records, owner, 1) ||
        records.filter((item) => item.device === owner.device).length >= 32 ||
        records.reduce((sum, item) => sum + item.charge, charge) > HOME_LIMIT
      )
        throw new ReservationError('busy');
      let id: string;
      do {
        id = randomBytes(16).toString('hex');
      } while (records.some((item) => item.id === id));
      records.push({
        device: owner.device,
        session: owner.session,
        hub: owner.hub,
        id,
        bytes,
        charge,
        state: 'active',
        ...(journal ? { journal } : {}),
      });
      return id;
    });
  }

  retain(id: string, state: 'staged' | 'cleanup', allocatedBytes = 0): void {
    this.transaction((records) => {
      const record = records.find((item) => item.id === id);
      if (
        !record ||
        record.journal ||
        !['staged', 'cleanup'].includes(state) ||
        (record.state === 'cleanup' && state !== 'cleanup') ||
        !Number.isSafeInteger(allocatedBytes) ||
        allocatedBytes < 0
      )
        throw new ReservationError('unavailable');
      const charge = Math.max(record.charge, allocatedBytes);
      if (
        !Number.isSafeInteger(
          records.reduce((sum, item) => sum + (item.id === id ? charge : item.charge), 0),
        )
      )
        throw new ReservationError('unavailable');
      record.charge = charge;
      record.state = state;
      // Accounting debt is durable even above the budget; new reserve calls then refuse.
    });
  }

  /** A bounded cancellation receipt grants correlation only while its exact shared row remains. */
  withRetainedJournalReceipt<T>(lease: JournalLease, operation: () => T): T {
    return this.locked(() => {
      const record = this.read().find((item) => item.id === lease.id);
      if (
        !record ||
        record.state !== 'settled' ||
        !record.journal ||
        !sameLease(record.journal, lease)
      )
        throw new ReservationError('unavailable');
      return operation();
    });
  }

  bindJournalOwnership(lease: JournalLease, witnesses: MarkerWitness[], allocated: number): void {
    this.transaction((records) => {
      const record = records.find((item) => item.id === lease.id);
      if (
        !record?.journal ||
        record.state === 'settled' ||
        !sameLease(record.journal, lease) ||
        record.journal.retirement ||
        !validWitnesses(witnesses, ['intent', 'owned']) ||
        (record.journal.ownership && !sameWitnesses(record.journal.ownership, witnesses)) ||
        !Number.isSafeInteger(allocated) ||
        allocated < 0
      )
        throw new ReservationError('unavailable');
      record.journal.ownership = witnesses;
      record.charge = Math.max(
        record.charge,
        allocated + witnesses.reduce((sum, marker) => sum + Math.max(4096, marker.allocated), 4096),
      );
      if (!Number.isSafeInteger(records.reduce((sum, item) => sum + item.charge, 0)))
        throw new ReservationError('unavailable');
    });
  }

  writeJournal(
    lease: JournalLease,
    projected: number,
    measure: () => { ownership: MarkerWitness[]; allocated: number },
    effect: () => void,
  ): void {
    if (!Number.isSafeInteger(projected) || projected < 0)
      throw new ReservationError('unavailable');
    this.locked(() => {
      const records = this.read();
      const record = records.find((item) => item.id === lease.id);
      if (
        !record?.journal?.ownership ||
        !sameLease(record.journal, lease) ||
        record.state !== 'active' ||
        record.journal.retirement
      )
        throw new ReservationError('unavailable');
      const commit = (charge: number) => {
        if (
          !Number.isSafeInteger(charge) ||
          !Number.isSafeInteger(
            records.reduce((sum, item) => sum + (item === record ? charge : item.charge), 0),
          )
        )
          throw new ReservationError('unavailable');
        record.charge = charge;
        this.write(records);
      };
      const account = () => {
        const current = measure(); // Captured roots, held marker identities and exact owned writer FD.
        if (
          !record.journal?.ownership ||
          !validWitnesses(current.ownership, ['intent', 'owned']) ||
          !sameWitnesses(record.journal.ownership, current.ownership) ||
          !Number.isSafeInteger(current.allocated) ||
          current.allocated < 0
        )
          throw new ReservationError('unavailable');
        const markers = current.ownership.reduce(
          (sum, marker) => sum + Math.max(4096, marker.allocated),
          4096,
        );
        const charge = Math.max(
          record.charge,
          current.allocated + markers,
          rounded(projected) + markers,
        );
        if (!Number.isSafeInteger(charge)) throw new ReservationError('unavailable');
        record.journal.ownership = current.ownership;
        commit(charge);
      };
      try {
        account();
      } catch {
        commit(Math.max(record.charge, CLEANUP_BLOCKING_DEBT));
        throw new ReservationError('unavailable');
      }
      let failedEffect = false;
      try {
        effect();
      } catch {
        failedEffect = true;
      }
      // Persist on failure inside the lock: transaction() would discard this durable debt on throw.
      try {
        account();
      } catch {
        commit(Math.max(record.charge, CLEANUP_BLOCKING_DEBT));
        throw new ReservationError('unavailable');
      }
      if (failedEffect) throw new ReservationError('unavailable');
    });
  }

  captureJournalRead(
    lease: JournalLease,
    capture: (
      bytes: number,
      ownership: readonly Readonly<MarkerWitness>[],
    ) => { ownership: MarkerWitness[]; allocated: number },
  ): number {
    return this.measureJournalRead(lease, capture, false);
  }

  retainJournal(
    lease: JournalLease,
    measure: (
      bytes: number,
      ownership: readonly Readonly<MarkerWitness>[],
    ) => { ownership: MarkerWitness[]; allocated: number },
  ): 'staged' {
    this.measureJournalRead(lease, measure, true);
    return 'staged';
  }

  private measureJournalRead(
    lease: JournalLease,
    measure: (
      bytes: number,
      ownership: readonly Readonly<MarkerWitness>[],
    ) => { ownership: MarkerWitness[]; allocated: number },
    staged: boolean,
  ): number {
    return this.locked(() => {
      const records = this.read();
      const record = records.find((item) => item.id === lease.id);
      if (
        !record?.journal?.ownership ||
        !sameLease(record.journal, lease) ||
        !['active', 'staged'].includes(record.state) ||
        record.journal.retirement
      )
        throw new ReservationError('unavailable');
      const commit = (charge: number) => {
        if (
          !Number.isSafeInteger(charge) ||
          !Number.isSafeInteger(
            records.reduce((sum, item) => sum + (item === record ? charge : item.charge), 0),
          )
        )
          throw new ReservationError('unavailable');
        record.charge = charge;
        this.write(records);
      };
      let measured: { ownership: MarkerWitness[]; allocated: number };
      try {
        measured = measure(
          record.bytes,
          record.journal.ownership.map((marker) => ({ ...marker })),
        );
        if (
          !validWitnesses(measured.ownership, ['intent', 'owned']) ||
          !sameWitnesses(record.journal.ownership, measured.ownership) ||
          !Number.isSafeInteger(measured.allocated) ||
          measured.allocated < 0
        )
          throw new ReservationError('unavailable');
      } catch (error) {
        // A failed nonblocking acquisition has no effect or uncertain measurement.
        if (error instanceof RecoveryError && error.code === 'busy') throw error;
        commit(Math.max(record.charge, CLEANUP_BLOCKING_DEBT));
        throw new ReservationError('unavailable');
      }
      const charge = Math.max(
        record.charge,
        measured.allocated +
          measured.ownership.reduce((sum, marker) => sum + Math.max(4096, marker.allocated), 4096),
      );
      if (!Number.isSafeInteger(charge)) {
        commit(Math.max(record.charge, CLEANUP_BLOCKING_DEBT));
        throw new ReservationError('unavailable');
      }
      record.journal.ownership = measured.ownership;
      if (staged) record.state = 'staged';
      commit(charge); // Conversion retains the same row, declaration, witnesses and monotone debt.
      return record.bytes;
    });
  }

  reconcileJournal(
    lease: JournalLease,
    prepare: (
      ownership: MarkerWitness[],
      retainAllocation: (allocated: number, measured: MarkerWitness[]) => void,
    ) => MarkerWitness[],
    retire: (
      witnesses: MarkerWitness[],
      retainMarkers: (measured: MarkerWitness[]) => void,
    ) => void,
    checkpoint?: (stage: 'retirement-committed' | 'settled-committed') => void,
  ): 'settled' | 'already_settled' {
    return this.locked(() => {
      const records = this.read();
      const index = records.findIndex((item) => item.id === lease.id);
      const record = records[index];
      if (!record?.journal || !sameLease(record.journal, lease))
        throw new ReservationError('unavailable');
      if (record.state === 'settled') return 'already_settled';
      // Ownership guard: never reconstruct a missing binding from existing files.
      if (!record.journal.ownership) throw new ReservationError('unavailable');
      if (!record.journal.retirement) {
        const witnesses = prepare(record.journal.ownership, (allocated, measured) => {
          if (
            !Number.isSafeInteger(allocated) ||
            allocated < 0 ||
            !validWitnesses(measured, ['intent', 'owned']) ||
            !record.journal?.ownership ||
            !sameWitnesses(record.journal.ownership, measured)
          )
            throw new ReservationError('unavailable');
          record.journal.ownership = measured;
          record.charge = Math.max(
            record.charge,
            allocated +
              (record.journal?.ownership ?? []).reduce(
                (sum, marker) => sum + Math.max(4096, marker.allocated),
                4096,
              ),
          );
          if (!Number.isSafeInteger(records.reduce((sum, item) => sum + item.charge, 0)))
            throw new ReservationError('unavailable');
          this.write(records); // Preserve measured allocation even when cleanup later refuses.
        });
        if (
          !validWitnesses(witnesses, ['intent', 'owned', 'cleaned']) ||
          !sameWitnesses(record.journal.ownership, witnesses.slice(0, 2))
        )
          throw new ReservationError('unavailable');
        record.journal.retirement = witnesses;
        record.state = 'cleanup';
        record.charge = Math.max(
          record.charge,
          witnesses.reduce((sum, marker) => sum + Math.max(4096, marker.allocated), 0),
        );
        this.write(records); // Persist all witnesses BEFORE the first retirement effect.
        checkpoint?.('retirement-committed');
      }
      // Retirement-before-refund guard: this must complete actual deletion and directory fsync.
      retire(record.journal.retirement, (measured) => {
        if (
          !validWitnesses(measured, ['intent', 'owned', 'cleaned']) ||
          !record.journal?.retirement ||
          !sameWitnesses(record.journal.retirement, measured)
        )
          throw new ReservationError('unavailable');
        record.journal.retirement = measured;
        record.charge = Math.max(
          record.charge,
          measured.reduce((sum, marker) => sum + Math.max(4096, marker.allocated), 0),
        );
        if (!Number.isSafeInteger(records.reduce((sum, item) => sum + item.charge, 0)))
          throw new ReservationError('unavailable');
        this.write(records); // Retained marker allocation debt is durable before unlink attempts.
      });
      const { nonce, home, scratch, metadata, artifactExtension } = record.journal;
      record.journal = {
        nonce,
        home,
        scratch,
        metadata,
        ...(artifactExtension !== undefined ? { artifactExtension } : {}),
      };
      record.state = 'settled';
      record.charge = 0;
      records.splice(index, 1);
      records.push(record); // Completion order, not admission order, determines eviction.
      this.write(records);
      checkpoint?.('settled-committed');
      return 'settled';
    });
  }

  /** The caller must have confirmed owned deletion; this is not a filesystem operation. */
  releaseAfterCleanup(id: string): void {
    this.transaction((records) => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0 || records[index]?.journal) throw new ReservationError('unavailable');
      records.splice(index, 1);
    });
  }
}
