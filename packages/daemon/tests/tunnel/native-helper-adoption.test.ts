import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { constants, tmpdir } from 'node:os';
import * as path from 'node:path';
import { recoveryNative as proofRecoveryNative } from '../../../../scripts/tunnel-storage-proof/recovery-native';
import { DirectoryRoot } from '../../src/tunnel/admission';
import { recoveryNative } from '../../src/tunnel/recovery-native';

test('proof native helper shares the daemon factory and owns real descriptors and locks', async () => {
  expect(proofRecoveryNative).toBe(recoveryNative);
  const bytes = fs.readFileSync(
    path.resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof/fixture.png'),
  );
  const native = await recoveryNative();
  const opened = new Set<number>();
  let directory: string | undefined;
  let root: DirectoryRoot | null = null;
  const closeFile = (fd: number) => {
    fs.closeSync(fd);
    opened.delete(fd);
  };
  try {
    directory = fs.mkdtempSync(path.join(tmpdir(), 'remi-native-helper-adoption-'));
    fs.chmodSync(directory, 0o700);
    root = DirectoryRoot.capture(directory, native.ops.openAt.bind(native.ops));
    expect(root).toBeInstanceOf(DirectoryRoot);
    if (!root) throw new Error('actual native helper root capture failed');
    const directoryFD = root.fd;
    expect(fs.fstatSync(directoryFD).isDirectory()).toBe(true);
    const directoryFlags = native.cloexec(directoryFD);
    expect(directoryFlags).toBeGreaterThanOrEqual(0);
    expect(directoryFlags & 1).toBe(1);
    const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    expect(native.ops.openAt(directoryFD, 'missing.png', flags)).toBe(-constants.errno.ENOENT);
    expect(native.ops.unlink(directoryFD, 'missing.png')).toBe(-constants.errno.ENOENT);
    const first = native.ops.create(
      directoryFD,
      'owned.png',
      flags | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    expect(first).toBeGreaterThanOrEqual(0);
    if (first < 0) throw new Error('actual owned file creation failed');
    opened.add(first);
    fs.writeFileSync(first, bytes);
    fs.fsyncSync(first);
    const firstStat = fs.fstatSync(first, { bigint: true });
    expect(firstStat.isFile()).toBe(true);
    expect(Number(firstStat.mode & 0o777n)).toBe(0o600);
    const firstFlags = native.cloexec(first);
    expect(firstFlags).toBeGreaterThanOrEqual(0);
    expect(firstFlags & 1).toBe(1);
    const second = native.ops.openAt(directoryFD, 'owned.png', flags);
    expect(second).toBeGreaterThanOrEqual(0);
    if (second < 0) throw new Error('actual owned file reopen failed');
    opened.add(second);
    const secondStat = fs.fstatSync(second, { bigint: true });
    expect(secondStat.dev).toBe(firstStat.dev);
    expect(secondStat.ino).toBe(firstStat.ino);
    const secondFlags = native.cloexec(second);
    expect(secondFlags).toBeGreaterThanOrEqual(0);
    expect(secondFlags & 1).toBe(1);
    expect(fs.readFileSync(second)).toEqual(bytes);
    expect(native.ops.lock(first)).toBe(0);
    expect(native.ops.lock(second)).toBe(-constants.errno.EWOULDBLOCK);
    closeFile(first);
    expect(native.ops.lock(second)).toBe(0);
    closeFile(second);
    expect(() => native.ops.link(directoryFD, 'owned.png', 'alias.png')).toThrow(
      'recovery link unsupported',
    );
    expect(native.ops.unlink(directoryFD, 'owned.png')).toBe(0);
    expect(native.ops.unlink(directoryFD, 'owned.png')).toBe(-constants.errno.ENOENT);
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    try {
      for (const fd of opened) fs.closeSync(fd);
    } finally {
      try {
        root?.close();
      } finally {
        try {
          native.close();
        } finally {
          if (directory) fs.rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }
});
