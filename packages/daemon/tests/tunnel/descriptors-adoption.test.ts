import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as proofAdmission from '../../../../scripts/tunnel-storage-proof/admission';
import type { PrivateOps as ProofPrivateOps } from '../../../../scripts/tunnel-storage-proof/private-copy';
import { recoveryNative } from '../../../../scripts/tunnel-storage-proof/recovery-native';
import { AdmittedFile, DirectoryRoot, FileAdmission } from '../../src/tunnel/admission';
import type { PrivateOps } from '../../src/tunnel/private-ops';

test('proof descriptor adapters share daemon classes and capture a real owned root', async () => {
  expect(proofAdmission.DirectoryRoot).toBe(DirectoryRoot);
  expect(proofAdmission.AdmittedFile).toBe(AdmittedFile);
  expect(proofAdmission.FileAdmission).toBe(FileAdmission);
  const native = await recoveryNative();
  const proofOps: ProofPrivateOps = native.ops;
  const ops: PrivateOps = proofOps;
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'remi-descriptors-adoption-'));
  fs.chmodSync(directory, 0o700);
  let root: DirectoryRoot | null = null;
  try {
    root = proofAdmission.DirectoryRoot.capture(directory, ops.openAt.bind(ops));
    expect(root).toBeInstanceOf(DirectoryRoot);
    if (!root) throw new Error('actual owned root capture failed');
    const stat = fs.fstatSync(root.fd, { bigint: true });
    const named = fs.statSync(directory, { bigint: true });
    expect(stat.isDirectory()).toBe(true);
    expect(stat.dev).toBe(named.dev);
    expect(stat.ino).toBe(named.ino);
    expect(root.identity).toBe(`${stat.dev}:${stat.ino}`);
    expect(root.contains(new Set([root.identity]))).toBe(true);
    expect(root.active).toBe(true);
    expect(root.isCurrent()).toBe(true);
    const fd = root.fd;
    root.close();
    expect(root.active).toBe(false);
    expect(root.isCurrent()).toBe(false);
    expect(() => fs.fstatSync(fd)).toThrow();
    root.close();
  } finally {
    root?.close();
    native.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
