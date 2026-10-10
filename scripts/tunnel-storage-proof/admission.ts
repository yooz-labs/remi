// #1170 candidate only: real descriptors, no transfer authority or production caller.
import * as fs from 'node:fs';
import * as path from 'node:path';

export type OpenAt = (directory: number, component: string, flags: number) => number;
type Entry = { fd: number; parent: number; name: string; flags: number; stat: fs.BigIntStats };
const C = fs.constants;
const DIRECTORY = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
const LEAF = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK;
const MAX_BYTES = 10n * 1024n * 1024n;
const identity = (stat: fs.BigIntStats) => `${stat.dev}:${stat.ino}`;
const asciiLower = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const credentialNames = new Set([
  'node_modules',
  'id_rsa',
  'id_ed25519',
  'credentials',
  'authorized_keys',
  'known_hosts',
]);
const unsafeText = /[/:\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function allowed(part: string): boolean {
  if (typeof part !== 'string' || !part || unsafeText.test(part)) return false;
  const folded = asciiLower(part);
  return (
    !folded.startsWith('.') &&
    !folded.endsWith('~') &&
    Buffer.byteLength(part, 'utf8') <= 255 &&
    !credentialNames.has(folded) &&
    !/\.(key|pem|p12|pfx|keystore)$/u.test(folded)
  );
}

function namesCurrent(entries: readonly Entry[], openAt: OpenAt): boolean {
  try {
    for (const entry of entries) {
      const fd = openAt(entry.parent, entry.name, entry.flags);
      if (fd < 0) return false;
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (identity(stat) !== identity(entry.stat)) return false;
        if (entry.stat.isFile() && (!stat.isFile() || stat.nlink !== 1n)) return false;
      } finally {
        fs.closeSync(fd);
      }
    }
    return true;
  } catch {
    // A missing/replaced/unreadable name refuses admission, without logging host paths.
    return false;
  }
}

export class DirectoryRoot {
  private closed = false;
  private constructor(
    readonly pathname: string,
    private readonly descriptors: number[],
    private readonly entries: Entry[],
    private readonly rootStat: fs.BigIntStats,
    private readonly openAt: OpenAt,
  ) {}

  static capture(pathname: string, openAt: OpenAt): DirectoryRoot | null {
    // Trusted configuration only. Even the absolute ancestors use no-follow opens.
    if (
      !path.posix.isAbsolute(pathname) ||
      path.posix.normalize(pathname) !== pathname ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(pathname)
    )
      return null;
    const descriptors: number[] = [];
    const entries: Entry[] = [];
    let captured = false;
    try {
      let fd = fs.openSync('/', DIRECTORY);
      descriptors.push(fd);
      const rootStat = fs.fstatSync(fd, { bigint: true });
      for (const component of pathname.split('/').filter(Boolean)) {
        const next = openAt(fd, component, DIRECTORY);
        if (next < 0) return null;
        descriptors.push(next);
        const stat = fs.fstatSync(next, { bigint: true });
        if (!stat.isDirectory()) return null;
        entries.push({ fd: next, parent: fd, name: component, flags: DIRECTORY, stat });
        fd = next;
      }
      const result = new DirectoryRoot(pathname, descriptors, entries, rootStat, openAt);
      if (!result.isCurrent()) return null;
      captured = true;
      return result;
    } catch {
      return null; // Fail closed; capture does not expose the failing host component.
    } finally {
      if (!captured) for (const fd of descriptors.reverse()) fs.closeSync(fd);
    }
  }

  get fd(): number {
    return this.descriptors[this.descriptors.length - 1] ?? -1;
  }
  get active(): boolean {
    return !this.closed;
  }
  get identity(): string {
    return identity(this.entries.at(-1)?.stat ?? this.rootStat);
  }

  contains(identities: ReadonlySet<string>): boolean {
    return (
      identities.has(identity(this.rootStat)) ||
      this.entries.some((entry) => identities.has(identity(entry.stat)))
    );
  }

  isCurrent(): boolean {
    return !this.closed && namesCurrent(this.entries, this.openAt);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fd of this.descriptors.reverse()) fs.closeSync(fd);
  }
}

export class AdmittedFile {
  private closed = false;
  constructor(
    readonly fd: number,
    readonly size: bigint,
    private readonly entries: Entry[],
    private readonly current: () => boolean,
    private readonly protectedSnapshot: DirectoryRoot[],
  ) {}

  isCurrent(): boolean {
    return !this.closed && this.current();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const entry of this.entries.reverse()) fs.closeSync(entry.fd);
    } finally {
      for (const captured of this.protectedSnapshot.reverse()) captured.close();
    }
  }
}

export class FileAdmission {
  private readonly protectedIdentities: ReadonlySet<string>;
  constructor(
    private readonly openAt: OpenAt,
    private readonly protectedRoots: DirectoryRoot[],
  ) {
    this.protectedIdentities = new Set(protectedRoots.map((root) => root.identity));
  }

  private protectedPath(pathname: string): boolean {
    // #1170: a replacement inode must remain denied under Mac spelling aliases.
    const candidate = asciiLower(pathname);
    return this.protectedRoots.some((root) => {
      const known = asciiLower(root.pathname);
      return candidate === known || candidate.startsWith(known === '/' ? '/' : `${known}/`);
    });
  }

  private captureProtected(): DirectoryRoot[] | null {
    const current: DirectoryRoot[] = [];
    let captured = false;
    try {
      for (const known of this.protectedRoots) {
        const directory = DirectoryRoot.capture(known.pathname, this.openAt);
        if (!directory) return null;
        current.push(directory);
      }
      captured = true;
      return current;
    } finally {
      if (!captured) for (const directory of current.reverse()) directory.close();
    }
  }

  private protectedDirectory(
    root: DirectoryRoot,
    entries: readonly Entry[],
    held: readonly DirectoryRoot[],
  ): boolean {
    // Preserve original, lookup-snapshot and latest configured identities together.
    const current = this.captureProtected();
    if (!current) return true;
    const identities = new Set([
      ...this.protectedIdentities,
      ...held.map((item) => item.identity),
      ...current.map((item) => item.identity),
    ]);
    try {
      return (
        root.contains(identities) ||
        entries.some((entry) => entry.stat.isDirectory() && identities.has(identity(entry.stat)))
      );
    } finally {
      for (const captured of current.reverse()) captured.close();
    }
  }

  open(
    root: DirectoryRoot,
    parts: readonly string[],
    afterOpen?: (index: number) => void,
  ): AdmittedFile | null {
    // Validate the complete client spelling before opening even its first component.
    if (!parts.length || parts.length > 64 || !parts.every(allowed)) return null;
    const pathname = path.posix.join(root.pathname, ...parts);
    if (
      this.protectedPath(pathname) ||
      root.contains(this.protectedIdentities) ||
      this.protectedRoots.some((item) => !item.active) ||
      !root.isCurrent()
    )
      return null;
    const retained = this.captureProtected();
    if (!retained) return null;
    const identities = new Set([
      ...this.protectedIdentities,
      ...retained.map((item) => item.identity),
    ]);
    const entries: Entry[] = [];
    const descriptors: number[] = [];
    let admitted = false;
    try {
      if (root.contains(identities)) return null;
      let parent = root.fd;
      for (const [index, component] of parts.entries()) {
        const last = index === parts.length - 1;
        const flags = last ? LEAF : DIRECTORY;
        const fd = this.openAt(parent, component, flags);
        if (fd < 0) return null;
        descriptors.push(fd);
        const stat = fs.fstatSync(fd, { bigint: true });
        if (
          last
            ? !stat.isFile() || stat.nlink !== 1n || stat.size > MAX_BYTES
            : !stat.isDirectory() || identities.has(identity(stat))
        )
          return null;
        entries.push({ fd, parent, name: component, flags, stat });
        // Owned probe checkpoint: performs real renames after real native opens.
        afterOpen?.(index);
        parent = fd;
      }
      const stat = entries.at(-1)?.stat;
      if (!stat) return null;
      const result = new AdmittedFile(
        parent,
        stat.size,
        entries,
        () =>
          this.protectedRoots.every((item) => item.active) &&
          root.isCurrent() &&
          namesCurrent(entries, this.openAt) &&
          !this.protectedDirectory(root, entries, retained),
        retained,
      );
      if (!result.isCurrent()) return null;
      admitted = true;
      return result;
    } catch {
      return null; // Native open/inspection failure cannot become an admitted descriptor.
    } finally {
      if (!admitted) {
        try {
          for (const fd of descriptors.reverse()) fs.closeSync(fd);
        } finally {
          for (const captured of retained.reverse()) captured.close();
        }
      }
    }
  }
}
