// #1440/#1170 standalone immutable ownership journal; no quota refund or transfer authority.
import * as fs from 'node:fs';
import type { DirectoryRoot } from './admission';
import type { PrivateOps } from './private-copy';

export type RecoveryOps = PrivateOps & { lock: (fd: number) => number };
export type RecoveryStage =
  | 'pre-create'
  | 'post-create'
  | 'post-witness'
  | 'post-unlink'
  | 'post-cleaned';
type Witness = { dev: string; ino: string; uid: string };
type Marker = { version: 1; id: string; root: string; artifact: Witness | null };
type Held = { fd: number; name: string; stat: fs.BigIntStats; value: Marker };
const C = fs.constants;
const READ = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK;
const CAP = 4096;
const TOKEN = /^[a-f0-9]{32}$/;
const NUMBER = /^(0|[1-9][0-9]*)$/;
const UID = BigInt(process.getuid?.() ?? -1);

export class RecoveryError extends Error {
  constructor(readonly code: 'busy' | 'unavailable') {
    super(`recovery ${code}`);
  }
}
function refuse(): never {
  throw new RecoveryError('unavailable');
}
const identity = (stat: fs.BigIntStats): Witness => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  uid: String(stat.uid),
});
function privateFile(stat: fs.BigIntStats): boolean {
  // Ownership guard: regular, single link, exact UID and private mode, including special bits.
  return stat.isFile() && stat.nlink === 1n && stat.uid === UID && (stat.mode & 0o7777n) === 0o600n;
}
function matches(stat: fs.BigIntStats, witness: Witness): boolean {
  return privateFile(stat) && JSON.stringify(identity(stat)) === JSON.stringify(witness);
}
function canonical(raw: string, value: Marker): boolean {
  return JSON.stringify(value) === raw;
}
function parse(raw: string, id: string, root: string, owned: boolean): Marker {
  const value = JSON.parse(raw) as Marker;
  // Schema guard: canonical bytes also reject duplicate keys and unrecognized fields.
  if (
    !value ||
    Object.keys(value).join() !== 'version,id,root,artifact' ||
    value.version !== 1 ||
    value.id !== id ||
    value.root !== root ||
    !canonical(raw, value)
  )
    refuse();
  if (owned) {
    const item = value.artifact;
    if (
      !item ||
      Object.keys(item).join() !== 'dev,ino,uid' ||
      ![item.dev, item.ino, item.uid].every(
        (part) => typeof part === 'string' && NUMBER.test(part),
      ) ||
      item.uid !== String(UID)
    )
      refuse();
  } else if (value.artifact !== null) refuse();
  return value;
}

/** Open existing immutable state only; a missing witness is never deletion authority. */
export class RecoveryIntent {
  private readonly held: Held[] = [];
  private closed = false;
  private constructor(
    private readonly scratch: DirectoryRoot,
    private readonly metadata: DirectoryRoot,
    readonly id: string,
    private readonly ops: RecoveryOps,
    private readonly newlyCreated: boolean,
  ) {}
  private name(kind: 'intent' | 'owned' | 'cleaned' | 'artifact'): string {
    return `${this.id}.${kind}`;
  }
  private current(): void {
    // Current-root guard: retained descriptors do not authorize a replaced configured root.
    if (this.closed || !this.scratch.isCurrent() || !this.metadata.isCurrent()) refuse();
    for (const root of [this.scratch, this.metadata]) {
      const stat = fs.fstatSync(root.fd, { bigint: true });
      if (!stat.isDirectory() || stat.uid !== UID || (stat.mode & 0o7777n) !== 0o700n) refuse();
    }
    for (const item of this.held) this.validate(item);
  }
  private validate(item: Held): void {
    const fd = this.ops.openAt(this.metadata.fd, item.name, READ);
    if (fd < 0) refuse();
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (
        !matches(stat, identity(item.stat)) ||
        !matches(fs.fstatSync(item.fd, { bigint: true }), identity(item.stat))
      )
        refuse();
      if (!canonical(this.read(fd), item.value)) refuse();
    } finally {
      fs.closeSync(fd);
    }
  }
  private read(fd: number): string {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!privateFile(before) || before.size < 1n || before.size > BigInt(CAP)) refuse();
    const buffer = Buffer.alloc(CAP + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      BigInt(size) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      !privateFile(after)
    )
      refuse();
    return buffer.subarray(0, size).toString('utf8');
  }
  private load(kind: 'intent' | 'owned' | 'cleaned', optional = false): Held | null {
    const name = this.name(kind);
    const fd = this.ops.openAt(this.metadata.fd, name, READ);
    if (fd === -2 && optional) return null; // Native wrapper preserves exact ENOENT.
    if (fd < 0) refuse();
    try {
      const value = parse(this.read(fd), this.id, this.scratch.identity, kind !== 'intent');
      const item = { fd, name, stat: fs.fstatSync(fd, { bigint: true }), value };
      this.validate(item);
      this.held.push(item);
      return item;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  private persist(kind: 'intent' | 'owned' | 'cleaned', artifact: Witness | null): Held {
    this.current();
    const value: Marker = { version: 1, id: this.id, root: this.scratch.identity, artifact };
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > CAP) refuse();
    const name = this.name(kind);
    const fd = this.ops.create(
      this.metadata.fd,
      name,
      C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
      0o600,
    );
    if (fd < 0) refuse();
    // An incomplete exclusive marker is retained, never rewritten or silently retired.
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!privateFile(stat) || stat.size !== 0n) refuse();
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) refuse();
        offset += count;
      }
      fs.fsyncSync(fd);
      const item = { fd, name, stat: fs.fstatSync(fd, { bigint: true }), value };
      this.validate(item);
      this.current();
      fs.fsyncSync(this.metadata.fd);
      this.held.push(item);
      return item;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  private acquire(intent: Held): void {
    this.current();
    const result = this.ops.lock(intent.fd);
    if (result !== 0)
      throw new RecoveryError(result === -11 || result === -35 ? 'busy' : 'unavailable');
    this.current();
  }
  static open(
    scratch: DirectoryRoot,
    metadata: DirectoryRoot,
    id: string,
    ops: RecoveryOps,
    create = false,
  ): RecoveryIntent {
    if (typeof id !== 'string' || !TOKEN.test(id) || scratch.identity === metadata.identity)
      refuse();
    const result = new RecoveryIntent(scratch, metadata, id, ops, create);
    try {
      result.current();
      const intent = create ? result.persist('intent', null) : result.load('intent');
      if (!intent) refuse();
      result.acquire(intent);
      return result;
    } catch (error) {
      result.close();
      if (error instanceof RecoveryError) throw error;
      throw new RecoveryError('unavailable');
    }
  }
  createArtifact(checkpoint?: (stage: RecoveryStage) => void): number {
    let fd = -1;
    try {
      this.current();
      if (!this.newlyCreated) refuse();
      for (const kind of ['owned', 'cleaned'] as const) {
        const existing = this.ops.openAt(this.metadata.fd, this.name(kind), READ);
        if (existing >= 0) fs.closeSync(existing);
        if (existing !== -2) refuse();
      }
      checkpoint?.('pre-create');
      this.current();
      fd = this.ops.create(
        this.scratch.fd,
        this.name('artifact'),
        C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
        0o600,
      );
      if (fd < 0) refuse();
      checkpoint?.('post-create');
      this.current();
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!privateFile(stat) || stat.size !== 0n) refuse();
      const named = this.artifact();
      if (named < 0) refuse();
      try {
        if (!matches(fs.fstatSync(named, { bigint: true }), identity(stat))) refuse();
      } finally {
        fs.closeSync(named);
      }
      fs.fsyncSync(fd);
      fs.fsyncSync(this.scratch.fd);
      this.persist('owned', identity(stat));
      this.current();
      checkpoint?.('post-witness');
      return fd; // Caller owns this descriptor; identity was durable before any content write.
    } catch {
      if (fd >= 0) fs.closeSync(fd);
      throw new RecoveryError('unavailable');
    }
  }
  private artifact(): number {
    return this.ops.openAt(this.scratch.fd, this.name('artifact'), READ);
  }
  cleanup(checkpoint?: (stage: RecoveryStage) => void): 'cleaned' {
    try {
      this.current();
      const owned =
        this.held.find((item) => item.name === this.name('owned')) ?? this.load('owned');
      if (!owned?.value.artifact) refuse();
      const terminal =
        this.held.find((item) => item.name === this.name('cleaned')) ?? this.load('cleaned', true);
      if (terminal && JSON.stringify(terminal.value) !== JSON.stringify(owned.value)) refuse();
      this.current();
      const fd = this.artifact();
      if (fd >= 0) {
        try {
          // Cleanup-outcome guard: an existing terminal record never adopts a conflicting name.
          if (terminal || !matches(fs.fstatSync(fd, { bigint: true }), owned.value.artifact))
            refuse();
          this.current();
          const named = this.artifact();
          if (named < 0) refuse();
          try {
            if (!matches(fs.fstatSync(named, { bigint: true }), owned.value.artifact)) refuse();
          } finally {
            fs.closeSync(named);
          }
          if (this.ops.unlink(this.scratch.fd, this.name('artifact')) !== 0) refuse();
        } finally {
          fs.closeSync(fd);
        }
      } else if (fd !== -2) refuse();
      this.current();
      fs.fsyncSync(this.scratch.fd);
      checkpoint?.('post-unlink');
      this.current();
      const outcome = terminal ?? this.persist('cleaned', owned.value.artifact);
      this.validate(outcome);
      fs.fsyncSync(outcome.fd);
      fs.fsyncSync(this.metadata.fd);
      checkpoint?.('post-cleaned');
      this.current();
      const absent = this.artifact();
      if (absent >= 0) fs.closeSync(absent);
      if (absent !== -2) refuse();
      return 'cleaned';
    } catch (error) {
      if (error instanceof RecoveryError) throw error;
      throw new RecoveryError('unavailable');
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.held.reverse()) fs.closeSync(item.fd); // Last intent FD closes its flock.
  }
}
