/** Private cross-process RAM accounting (#1617), not device authority or filesystem confinement. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { parseStrictJson } from '@remi/shared/relay/strict-json.ts';
import {
  InterprocessFileLockError,
  withInterprocessFileLockNonblocking,
} from '../storage/interprocess-file-lock.ts';
import { writeRestrictedJson } from '../storage/restricted-json.ts';

export const TERMINAL_RESERVATION_LIMITS = {
  models: 32,
  modelBytes: 1024 * 1024,
  views: 8,
  deviceViews: 2,
  sessionViews: 4,
  connectionViews: 1,
  ledgerBytes: 32768,
} as const;

type Owner = { readonly pid: number; readonly host: string; readonly owner: string };
type Model = Owner & { readonly kind: 'model'; readonly id: string; readonly session: string };
type View = Owner & {
  readonly kind: 'view';
  readonly id: string;
  readonly session: string;
  readonly model: string;
  readonly device: string;
  readonly connection: string;
};
type Row = Model | View;
const LIMIT = TERMINAL_RESERVATION_LIMITS;
const TOKEN = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DEVICE = /^[a-f0-9]{64}$/;
const MODEL_KEYS = 'host,id,kind,owner,pid,session';
const VIEW_KEYS = 'connection,device,host,id,kind,model,owner,pid,session';

export class TerminalReservationError extends Error {
  constructor(readonly code: 'busy' | 'unavailable') {
    super(`terminal reservation ${code}`);
  }
}
function unavailable(): never {
  throw new TerminalReservationError('unavailable');
}
const sameOwner = (a: Owner, b: Owner): boolean =>
  a.pid === b.pid && a.host === b.host && a.owner === b.owner;
const keys = (value: object): string => Object.keys(value).sort().join();
const hostValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 255 &&
  !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);

function parse(text: string, namespace: string): Row[] {
  const value = parseStrictJson(text, LIMIT.ledgerBytes) as Record<string, unknown> | null;
  if (
    !value ||
    keys(value) !== 'namespace,records,version' ||
    value['version'] !== 1 ||
    value['namespace'] !== namespace ||
    !Array.isArray(value['records']) ||
    value['records'].length > LIMIT.models + LIMIT.views
  )
    unavailable();
  const rows: Row[] = [];
  for (const candidate of value['records']) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) unavailable();
    const row = candidate as Row;
    if (
      (row.kind !== 'model' && row.kind !== 'view') ||
      keys(row) !== (row.kind === 'model' ? MODEL_KEYS : VIEW_KEYS) ||
      typeof row.id !== 'string' ||
      !TOKEN.test(row.id) ||
      rows.some((r) => r.id === row.id) ||
      typeof row.session !== 'string' ||
      !UUID.test(row.session) ||
      !Number.isSafeInteger(row.pid) ||
      row.pid < 1 ||
      row.pid > 2147483647 ||
      !hostValid(row.host) ||
      typeof row.owner !== 'string' ||
      !TOKEN.test(row.owner) ||
      (row.kind === 'view' &&
        (typeof row.model !== 'string' ||
          !TOKEN.test(row.model) ||
          typeof row.device !== 'string' ||
          !DEVICE.test(row.device) ||
          typeof row.connection !== 'string' ||
          !UUID.test(row.connection)))
    )
      unavailable();
    rows.push(row);
  }
  const models = rows.filter((r): r is Model => r.kind === 'model');
  const views = rows.filter((r): r is View => r.kind === 'view');
  if (
    models.length > LIMIT.models ||
    views.length > LIMIT.views ||
    new Set(models.map((r) => r.session)).size !== models.length
  )
    unavailable();
  for (const view of views) {
    if (
      !models.some(
        (m) => m.id === view.model && m.session === view.session && sameOwner(m, view),
      ) ||
      views.filter((r) => r.connection === view.connection).length > LIMIT.connectionViews ||
      views.filter((r) => r.device === view.device).length > LIMIT.deviceViews ||
      views.filter((r) => r.session === view.session).length > LIMIT.sessionViews
    )
      unavailable();
  }
  return rows;
}

/** Bound reads independently of a stale size stat, and refuse links or unstable files. */
function readPrivate(file: string, maximum: number): { stat: fs.BigIntStats; bytes: Buffer } {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (stat.mode & 0o777n) !== 0o600n ||
      stat.size > BigInt(maximum)
    )
      unavailable();
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      BigInt(length) !== stat.size ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    )
      unavailable();
    return { stat, bytes: bytes.subarray(0, length) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Unknown signal results retain charge. PID reuse also conservatively retains charge. */
function provedDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Reserve before constructing a model. Dispose content/send slots before release.
 * Live rows never expire by wall clock: the future service owns monotonic expiry.
 * Atomic-write errors have uncertain completion: admission may charge, release may commit.
 * Dead rows require an obtainable lock; abandoned locks require quiescent operator repair.
 */
export class TerminalReservations {
  private readonly identity: fs.BigIntStats;
  private readonly file: string;
  private readonly markerIdentity: fs.BigIntStats;
  private readonly actor: Owner = {
    pid: process.pid,
    host: hostname(),
    owner: randomBytes(16).toString('hex'),
  };

  private constructor(
    private readonly directory: string,
    private readonly marker: string,
    initialize: boolean,
  ) {
    this.identity = fs.lstatSync(directory, { bigint: true });
    this.markerIdentity = fs.lstatSync(marker, { bigint: true });
    this.file = path.join(directory, 'reservations.json');
    this.locked(() => {
      if (initialize) this.write([]);
      else this.read();
    });
  }

  /** Exclusive creation only; an existing but incomplete namespace is never reset. */
  static open(home: string): TerminalReservations {
    try {
      if (!path.isAbsolute(home) || fs.realpathSync(home) !== home) unavailable();
      const stat = fs.lstatSync(home);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022)
        unavailable();
      const directory = path.join(home, 'terminal-view');
      const marker = path.join(home, '.terminal-view-namespace');
      let initialize = false;
      try {
        fs.lstatSync(marker);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A surviving directory or marker prevents automatic reinitialization.
        fs.mkdirSync(directory, { mode: 0o700 });
        const stat = fs.lstatSync(directory, { bigint: true });
        const fd = fs.openSync(marker, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, `${stat.dev}:${stat.ino}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        initialize = true;
      }
      return new TerminalReservations(directory, marker, initialize);
    } catch (error) {
      if (error instanceof TerminalReservationError) throw error;
      return unavailable();
    }
  }

  private get namespace(): string {
    return `${this.identity.dev}:${this.identity.ino}`;
  }
  private current(): void {
    const stat = fs.lstatSync(this.directory, { bigint: true });
    const marker = readPrivate(this.marker, 128);
    if (
      marker.stat.dev !== this.markerIdentity.dev ||
      marker.stat.ino !== this.markerIdentity.ino ||
      marker.bytes.toString('utf8') !== `${this.namespace}\n` ||
      process.pid !== this.actor.pid ||
      !hostValid(this.actor.host) ||
      fs.realpathSync(this.directory) !== this.directory ||
      !stat.isDirectory() ||
      stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (stat.mode & 0o777n) !== 0o700n
    )
      unavailable();
  }

  private locked<T>(operation: () => T): T {
    try {
      this.current();
      return withInterprocessFileLockNonblocking(this.file, () => {
        this.current();
        const value = operation();
        this.current();
        return value;
      });
    } catch (error) {
      if (error instanceof TerminalReservationError) throw error;
      if (error instanceof InterprocessFileLockError && error.retryable)
        throw new TerminalReservationError('busy');
      return unavailable();
    }
  }

  private read(): Row[] {
    const { bytes } = readPrivate(this.file, LIMIT.ledgerBytes);
    return parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      this.namespace,
    );
  }

  private write(records: Row[]): void {
    this.current();
    const value = { version: 1, namespace: this.namespace, records };
    if (Buffer.byteLength(JSON.stringify(value)) > LIMIT.ledgerBytes) unavailable();
    writeRestrictedJson(this.file, value);
  }

  private transaction<T>(operation: (rows: Row[]) => T): T {
    return this.locked(() => {
      const dead = new Map<number, boolean>();
      const rows = this.read().filter((row) => {
        if (row.host !== this.actor.host) return true;
        if (!dead.has(row.pid)) dead.set(row.pid, provedDead(row.pid));
        return !dead.get(row.pid);
      });
      const result = operation(rows);
      this.write(rows);
      return result;
    });
  }

  private id(rows: Row[]): string {
    let id: string;
    do {
      id = randomBytes(16).toString('hex');
    } while (rows.some((row) => row.id === id));
    return id;
  }

  reserveModel(session: string): string {
    if (typeof session !== 'string' || !UUID.test(session)) unavailable();
    return this.transaction((rows) => {
      if (
        rows.filter((row) => row.kind === 'model').length >= LIMIT.models ||
        rows.some((row) => row.kind === 'model' && row.session === session)
      )
        throw new TerminalReservationError('busy');
      const id = this.id(rows);
      rows.push({ ...this.actor, kind: 'model', id, session });
      return id;
    });
  }

  reserveView(modelId: string, device: string, connection: string): string {
    if (
      typeof modelId !== 'string' ||
      !TOKEN.test(modelId) ||
      typeof device !== 'string' ||
      !DEVICE.test(device) ||
      typeof connection !== 'string' ||
      !UUID.test(connection)
    )
      unavailable();
    return this.transaction((rows) => {
      const model = rows.find(
        (row) => row.kind === 'model' && row.id === modelId && sameOwner(row, this.actor),
      );
      if (!model) unavailable();
      const views = rows.filter((row): row is View => row.kind === 'view');
      if (
        views.length >= LIMIT.views ||
        views.filter((row) => row.device === device).length >= LIMIT.deviceViews ||
        views.filter((row) => row.session === model.session).length >= LIMIT.sessionViews ||
        views.filter((row) => row.connection === connection).length >= LIMIT.connectionViews
      )
        throw new TerminalReservationError('busy');
      const id = this.id(rows);
      rows.push({
        ...this.actor,
        kind: 'view',
        id,
        session: model.session,
        model: modelId,
        device,
        connection,
      });
      return id;
    });
  }

  owns(id: string): boolean {
    return this.locked(() =>
      this.read().some((row) => row.id === id && sameOwner(row, this.actor)),
    );
  }

  release(id: string): boolean {
    return this.transaction((rows) => {
      const index = rows.findIndex((row) => row.id === id && sameOwner(row, this.actor));
      if (index < 0) return false;
      if (rows.some((row) => row.kind === 'view' && row.model === id)) unavailable();
      rows.splice(index, 1);
      return true;
    });
  }
}
