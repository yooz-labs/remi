// #1170 feasibility candidate only; no daemon, quota ledger or transfer caller.
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import type { AdmittedFile, DirectoryRoot, OpenAt } from './admission';

export type PrivateOps = {
  openAt: OpenAt;
  create: (directory: number, name: string, flags: number, mode: number) => number;
  link: (directory: number, from: string, to: string) => number;
  unlink: (directory: number, name: string) => number;
};
export type CopyCheckpoint =
  | { stage: 'created'; directory: number; partial: string; final: string; fd: number }
  | { stage: 'read'; bytes: number }
  | { stage: 'validated'; directory: number; partial: string; final: string };
const C = fs.constants;
const CHUNK = 32 * 1024;
const LIMIT = 10n * 1024n * 1024n;
const DIRECTORY = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;

function digest(fd: number, size: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(CHUNK);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!count) throw new Error('private copy short read');
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest('hex');
}

export class PrivateCopy {
  private closed = false;
  constructor(
    private readonly fd: number,
    private readonly directory: number,
    private readonly name: string,
    readonly size: number,
    readonly sha256: string,
    private readonly unlink: PrivateOps['unlink'],
  ) {}

  read(buffer: Buffer, offset: number): number {
    if (this.closed || !Number.isSafeInteger(offset) || offset < 0 || offset > this.size)
      throw new Error('private copy unavailable');
    return fs.readSync(this.fd, buffer, 0, Math.min(buffer.length, this.size - offset), offset);
  }

  close(): void {
    if (this.closed) return;
    // A failed unlink remains visible and retryable; future quota accounting must retain it.
    if (this.unlink(this.directory, this.name) !== 0) throw new Error('private cleanup failed');
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } finally {
      fs.closeSync(this.directory);
    }
  }
}

export function copyToPrivate(
  source: AdmittedFile,
  root: DirectoryRoot,
  ops: PrivateOps,
  checkpoint?: (event: CopyCheckpoint) => void,
): PrivateCopy | null {
  let directory = -1;
  let fd = -1;
  let partialOwned = false;
  let finalOwned = false;
  let completed = false;
  const token = randomBytes(16).toString('hex');
  const partial = `${token}.partial`;
  const final = `${token}.complete`;
  const discard = () => {
    let cleanupFailed = false;
    try {
      if (finalOwned && ops.unlink(directory, final) !== 0) cleanupFailed = true;
      if (partialOwned && ops.unlink(directory, partial) !== 0) cleanupFailed = true;
    } finally {
      try {
        if (fd >= 0) fs.closeSync(fd);
      } finally {
        if (directory >= 0) fs.closeSync(directory);
      }
    }
    // Cleanup failure overrides a normal refusal so a future reservation cannot be released.
    if (cleanupFailed) throw new Error('private cleanup failed');
  };
  try {
    if (source.size < 0n || source.size > LIMIT || !root.isCurrent()) return null;
    const before = fs.fstatSync(source.fd, { bigint: true });
    if (!source.matchesMetadata(before) || !source.isCurrent()) return null;
    // Retain our own directory FD for cleanup even if its configured path is replaced.
    directory = ops.openAt(root.fd, '.', DIRECTORY);
    if (directory < 0) return null;
    const privateStat = fs.fstatSync(directory, { bigint: true });
    if (
      !privateStat.isDirectory() ||
      (privateStat.mode & 0o777n) !== 0o700n ||
      privateStat.uid !== BigInt(process.getuid?.() ?? -1)
    )
      return null;
    fd = ops.create(directory, partial, C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    if (fd < 0) return null;
    partialOwned = true;
    checkpoint?.({ stage: 'created', directory, partial, final, fd });
    const created = fs.fstatSync(fd, { bigint: true });
    if (
      !created.isFile() ||
      created.nlink !== 1n ||
      created.size !== 0n ||
      (created.mode & 0o777n) !== 0o600n
    )
      return null;
    const size = Number(source.size);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(source.fd, buffer, 0, Math.min(CHUNK, size - offset), offset);
      if (!count) return null;
      let written = 0;
      while (written < count) {
        const amount = fs.writeSync(fd, buffer, written, count - written, offset + written);
        if (!amount) return null;
        written += amount;
      }
      hash.update(buffer.subarray(0, count));
      offset += count;
      checkpoint?.({ stage: 'read', bytes: offset });
    }
    // Exactly one extra source byte can be inspected; it is never written or sent.
    if (fs.readSync(source.fd, buffer, 0, 1, size) !== 0) return null;
    const after = fs.fstatSync(source.fd, { bigint: true });
    if (!source.matchesMetadata(after) || !source.isCurrent() || !root.isCurrent()) return null;
    fs.fsyncSync(fd);
    const copied = fs.fstatSync(fd, { bigint: true });
    const sha256 = hash.digest('hex');
    if (
      !copied.isFile() ||
      copied.nlink !== 1n ||
      copied.size !== source.size ||
      (copied.mode & 0o777n) !== 0o600n ||
      digest(fd, size) !== sha256
    )
      return null;
    checkpoint?.({ stage: 'validated', directory, partial, final });
    // A checkpoint may mutate real filesystem state; validate again at the effect.
    if (
      !source.matchesMetadata(fs.fstatSync(source.fd, { bigint: true })) ||
      !source.isCurrent() ||
      !root.isCurrent()
    )
      return null;
    if (ops.link(directory, partial, final) !== 0) return null;
    finalOwned = true;
    if (ops.unlink(directory, partial) !== 0) return null;
    partialOwned = false;
    if (fs.fstatSync(fd, { bigint: true }).nlink !== 1n) return null;
    completed = true;
    return new PrivateCopy(fd, directory, final, size, sha256, ops.unlink);
  } catch {
    return null; // Actual native/read/write failures refuse; no project-path fallback.
  } finally {
    if (!completed) discard();
  }
}
