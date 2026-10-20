// #1170 bounded admitted-source cursor; transfer authority remains with its caller.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { AdmittedFile } from './admission';

export const ADMITTED_READ_CHUNK_SIZE = 32 * 1024;
const LIMIT = 10n * 1024n * 1024n;

/** Borrows the admitted descriptor; the caller retains its ownership and closes it. */
export class AdmittedRead {
  private offset = 0;
  private finished = false;
  private readonly hash = createHash('sha256');
  private readonly buffer = Buffer.alloc(ADMITTED_READ_CHUNK_SIZE);

  private constructor(private readonly source: AdmittedFile) {}

  static capture(source: AdmittedFile): AdmittedRead | null {
    try {
      if (source.size < 0n || source.size > LIMIT) return null;
      const reader = new AdmittedRead(source);
      return reader.isCurrent() ? reader : null;
    } catch {
      return null;
    }
  }

  get byteLength(): number {
    return Number(this.source.size);
  }

  get bytesRead(): number {
    return this.offset;
  }

  /** The returned bytes are borrowed until the next read; consume before yielding/reusing. */
  readNext(): Buffer {
    if (this.finished || this.offset >= this.byteLength)
      throw new Error('admitted read unavailable');
    const count = fs.readSync(
      this.source.fd,
      this.buffer,
      0,
      Math.min(ADMITTED_READ_CHUNK_SIZE, this.byteLength - this.offset),
      this.offset,
    );
    if (!count) throw new Error('admitted read unavailable');
    const bytes = this.buffer.subarray(0, count);
    this.hash.update(bytes);
    this.offset += count;
    return bytes;
  }

  /** Source identity/metadata checks also remain available at the later publication effect. */
  isCurrent(): boolean {
    try {
      return (
        this.source.matchesMetadata(fs.fstatSync(this.source.fd, { bigint: true })) &&
        this.source.isCurrent()
      );
    } catch {
      return false;
    }
  }

  finish(): { byteLength: number; sha256: string } {
    if (
      this.finished ||
      this.offset !== this.byteLength ||
      // Exactly one extra source byte may be inspected; it is never returned or written.
      fs.readSync(this.source.fd, this.buffer, 0, 1, this.byteLength) !== 0 ||
      !this.isCurrent()
    )
      throw new Error('admitted read unavailable');
    this.finished = true;
    return { byteLength: this.byteLength, sha256: this.hash.digest('hex') };
  }
}
