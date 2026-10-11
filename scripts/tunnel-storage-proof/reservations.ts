// #1170 standalone budget candidate. No production caller or file-deletion authority.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  InterprocessFileLockError,
  withInterprocessFileLockNonblocking,
} from '../../packages/daemon/src/storage/interprocess-file-lock';
import { writeRestrictedJson } from '../../packages/daemon/src/storage/restricted-json';

const KIB = 1024;
const FILE_LIMIT = 10 * 1024 * KIB;
const HOME_LIMIT = 100 * 1024 * KIB;
const LEDGER_LIMIT = 256 * KIB;
const STATES = ['active', 'staged', 'cleanup'] as const;
type State = (typeof STATES)[number];
type Owner = { device: string; session: string; hub: string };
type Record = Owner & { id: string; bytes: number; charge: number; state: State };
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
      Object.keys(item).sort().join() !== KEYS.join()
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
      record.charge < rounded(record.bytes) ||
      !STATES.includes(record.state)
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
      return parse(buffer.subarray(0, length).toString('utf8'));
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
      if (error instanceof InterprocessFileLockError && error.retryable)
        throw new ReservationError('busy');
      throw new ReservationError('unavailable');
    }
  }

  private transaction<T>(operation: (records: Record[]) => T): T {
    return this.locked(() => {
      const records = this.read();
      const result = operation(records);
      this.current();
      writeRestrictedJson(this.file, { version: 1, records });
      return result;
    });
  }

  inspect(): readonly Readonly<Record>[] {
    return this.locked(() => this.read());
  }

  reserve(owner: Owner, bytes: number): string {
    if (!validOwner(owner) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > FILE_LIMIT)
      throw new ReservationError('unavailable');
    return this.transaction((records) => {
      const charge = rounded(bytes);
      if (
        overLimits(records, owner, 1) ||
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
      });
      return id;
    });
  }

  retain(id: string, state: 'staged' | 'cleanup', allocatedBytes = 0): void {
    this.transaction((records) => {
      const record = records.find((item) => item.id === id);
      if (
        !record ||
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

  /** The caller must have confirmed owned deletion; this is not a filesystem operation. */
  releaseAfterCleanup(id: string): void {
    this.transaction((records) => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) throw new ReservationError('unavailable');
      records.splice(index, 1);
    });
  }
}
